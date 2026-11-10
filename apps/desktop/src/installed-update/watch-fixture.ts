// A whole installed copy for the watcher tests, on real files: a program
// file with known bytes, a data folder with a real thread store, a verified
// download of the next version signed with a key made for this test, and
// fake processes. The new version, when started, makes the store's
// pre-migration copy and migrates the store as the server would, then is
// killed with its WAL live; whether it acknowledges is up to the test.
//
// Every effect is recorded, and the world checks the design's five
// invariants after each run (`checkInvariants`).
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeManifest, signManifest } from "../../../server/src/update/release-manifest.ts";
import type { ProcessRecord } from "../../../server/src/update/identity.ts";
import { identify, realFileOps, type FileOps, type Identity } from "./files.ts";
import { holds, programPaths, type ProgramPaths } from "./linux.ts";
import { asideFolder, copyPath, STORE_FILES, STORE_NAME } from "./restore.ts";
import type { StopPoint } from "./stop-points.ts";
import { contents, copyStore, createStore, currentVersion, migrateWithLiveWal } from "./store-fixture.ts";
import { readTransaction, transactionFile, UPDATES_FOLDER, type Approval, type InstalledTransaction } from "./transaction.ts";
import type { InstalledResult, WatcherEffects, WatchOutcome } from "./watch.ts";
import type { Words } from "./words.ts";

export const FROM = "1.4.0";
export const TO = "1.5.0";
export const BEFORE = ["alpha", "beta"];
export const MIGRATED = ["alpha", "beta", "gamma"];
export const STORE_BEFORE = 4;
export const STORE_AFTER = 6;
const OLD_BYTES = "old program bytes, version 1.4.0";
const NEW_BYTES = "new program bytes, version 1.5.0, a little longer";
const UPTIME = 1_000;

/** Thrown by a stop point: the watcher was killed there. */
export class Crash extends Error {
  readonly point: StopPoint;
  constructor(point: StopPoint) {
    super(`killed at ${point}`);
    this.name = "Crash";
    this.point = point;
  }
}

/** A returned I/O error shaped like Node's: the source in `path`, a rename, link or copy's target in `dest`. */
export const ioError = (code: string, file: string, dest?: string): Error =>
  Object.assign(new Error(`${code}: ${file}`), { code, path: file }, dest === undefined ? {} : { dest });

interface Proc { alive: boolean; readonly version: "old" | "new" | "other"; readonly token: string }

/**
 * An injected returned error: a matching call throws `code`, before or after
 * doing what it does, once (or `times` times) after letting `skip` matching
 * calls through. The error names the call's first path, as Node's do.
 */
export interface Fault {
  readonly op: keyof FileOps;
  readonly match: (args: readonly string[]) => boolean;
  readonly code: string;
  readonly when?: "before" | "after";
  times?: number;
  skip?: number;
}

export interface RunLog {
  readonly points: StopPoint[];
  readonly spawns: string[];
  readonly stops: number[];
  readonly deleted: string[];
  readonly ops: string[];
  readonly violations: string[];
  readonly pages: Words[];
  ordinary: number;
}

const roots: string[] = [];
export function removeWorlds(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export interface WorldOptions {
  /** Whether the new version acknowledges (forward path) or never does (go-back path). */
  readonly newAcks?: boolean;
  readonly oldAcks?: boolean;
  /** The data folder had no thread store before the update. */
  readonly noStore?: boolean;
}

export class World {
  readonly root: string;
  readonly program: string;
  readonly dataDir: string;
  readonly file: string;
  readonly download: string;
  readonly artifactFile: string;
  readonly old: Identity;
  readonly new: Identity;
  readonly trustedKeys: readonly string[];
  /** What row H writes; a test may change it before `beginUpdate`. */
  approval: Approval;
  newAcks: boolean;
  oldAcks: boolean;
  boot = "boot-1";
  uptime = UPTIME;
  free = 1e12;
  readonly procs = new Map<number, Proc>();
  readonly results = new Map<string, InstalledResult>();
  faults: Fault[] = [];
  /** The next result write fails with this code, before writing anything. */
  resultFault: string | null = null;
  /** Token launches of this version cannot be confirmed stopped. */
  unstoppable: "old" | "new" | null = null;
  #pid = 100;
  #tokens = 0;

  constructor(o: WorldOptions = {}) {
    this.root = mkdtempSync(path.join(tmpdir(), "iu-watch-")); roots.push(this.root);
    this.newAcks = o.newAcks ?? true;
    this.oldAcks = o.oldAcks ?? true;
    const apps = path.join(this.root, "apps");
    mkdirSync(apps);
    this.program = path.join(apps, "Gates-Local.AppImage");
    writeFileSync(this.program, OLD_BYTES, { mode: 0o755 });
    this.dataDir = path.join(this.root, "data");
    mkdirSync(this.dataDir);
    if (o.noStore !== true) createStore(this.dataDir, STORE_BEFORE, BEFORE);
    this.file = transactionFile(this.dataDir);

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    this.trustedKeys = [publicKey.export({ type: "spki", format: "der" }).toString("base64")];
    this.download = path.join(this.dataDir, UPDATES_FOLDER, TO);
    mkdirSync(this.download, { recursive: true });
    const file = `Gates-Local-${TO}-x86_64.AppImage`;
    this.artifactFile = path.join(this.download, file);
    writeFileSync(this.artifactFile, NEW_BYTES);
    this.old = identify(this.program) ?? fail("program");
    this.new = identify(this.artifactFile) ?? fail("artifact");
    const artifact = { platform: "linux", arch: "x64", kind: "appimage", file, size: this.new.size, sha512: this.new.sha512 } as const;
    const list = encodeManifest({ schema: 1, version: TO, commit: "c".repeat(40), artifacts: [artifact] });
    writeFileSync(path.join(this.download, "release.json"), list);
    writeFileSync(path.join(this.download, "release.json.sig"), signManifest(list, privateKey));

    // The old main and its server, already gone: the person clicked Restart and main quit.
    const main = this.#spawnProc("old", "main"), server = this.#spawnProc("old", "server");
    this.#setAlive(main.pid, false);
    this.#setAlive(server.pid, false);
    this.approval = {
      id: "tx1", copy: { program: this.program, dataDir: this.dataDir }, from: FROM, to: TO,
      listDigest: createHash("sha512").update(list).digest("hex"), artifact,
      uptime: UPTIME - 1, boot: this.boot, main, server,
    };
  }

  get paths(): ProgramPaths { return programPaths(this.program, this.approval.id ?? fail("id")); }
  get live(): string { return path.join(this.dataDir, STORE_NAME); }
  get aside(): string { return asideFolder(this.dataDir, this.approval.id ?? fail("id")); }
  get storeCopy(): string { return copyPath(this.dataDir, STORE_BEFORE); }
  transaction(): InstalledTransaction | null { return readTransaction(this.file); }

  #spawnProc(version: Proc["version"], token: string): ProcessRecord {
    const pid = this.#pid++;
    this.procs.set(pid, { alive: true, version, token });
    return { pid, start: `start-${pid}`, uptime: this.uptime };
  }

  #setAlive(pid: number, alive: boolean): void {
    const proc = this.procs.get(pid);
    if (proc !== undefined) proc.alive = alive;
  }

  /** The old app has not closed. */
  hangOldApp(): void {
    this.#setAlive(this.approval.main.pid, true);
    this.#setAlive(this.approval.server.pid, true);
  }

  /**
   * What a token launch does when its watcher dies (section 2, "when the
   * watcher dies"): with no result carrying its token, it stops its server and
   * asks the person to close it, and the person does. One with a result runs on.
   */
  watcherDied(): void {
    const answered = new Set([...this.results.values()].flatMap(r => "token" in r ? [r.token] : []));
    for (const proc of this.procs.values()) if (proc.token.startsWith("T-") && !answered.has(proc.token)) proc.alive = false;
  }

  /** A restart of the computer: every process ends and the boot id changes. */
  reboot(): void {
    for (const proc of this.procs.values()) proc.alive = false;
    this.boot = `boot-${Number(this.boot.slice(5)) + 1}`;
    this.uptime = 10;
  }

  /** Whether the transaction on disk has decided, after which nothing may be spawned, stopped or moved. */
  #decided(): string | null {
    let tx: InstalledTransaction | null;
    try {
      tx = readTransaction(this.file);
    } catch {
      return null;
    }
    if (tx === null) return null;
    if (tx.intent === "accepted" || tx.intent === "went-back") return tx.intent;
    if (tx.intent === "cleanup" && tx.ending !== "stopped") return `cleanup after ${tx.ending ?? "?"}`;
    return null;
  }

  /** The intent on disk now, or null when there is no transaction or it does not decode. */
  #intent(): string | null {
    try {
      return readTransaction(this.file)?.intent ?? null;
    } catch {
      return null;
    }
  }

  #fs(log: RunLog): FileOps {
    const storeFiles = new Set(STORE_FILES.map(name => path.join(this.dataDir, name)));
    const firing = (op: keyof FileOps, args: readonly string[]): Fault | undefined => {
      const fault = this.faults.find(f => f.op === op && f.match(args) && (f.times ?? 1) > 0);
      if (fault === undefined) return undefined;
      if ((fault.skip ?? 0) > 0) {
        fault.skip = (fault.skip ?? 0) - 1;
        return undefined;
      }
      fault.times = (fault.times ?? 1) - 1;
      return fault;
    };
    // Ops with a source and a destination; the rest act on their first argument.
    const twoPaths = new Set<keyof FileOps>(["rename", "link", "copyFile"]);
    const changes = new Set<keyof FileOps>(["writeFile", "rename", "link", "copyFile", "unlink", "removeTree"]);
    const wrap = (op: keyof FileOps, real: (...args: string[]) => void, isDelete = false) => (...args: string[]): void => {
      log.ops.push(`${op} ${args.map(a => path.relative(this.root, a)).join(" ")}`);
      const fault = firing(op, args);
      if (fault !== undefined && (fault.when ?? "before") === "before") throw ioError(fault.code, args[0] ?? "", args[1]);
      const dest = (twoPaths.has(op) ? args[1] : args[0]) ?? "";
      // Only B2a and B2b may change the live store: a write to it, or a rename away from it, anywhere else is a violation.
      const touched = [dest, ...(op === "rename" ? [args[0] ?? ""] : [])].find(f => storeFiles.has(f));
      if (changes.has(op) && touched !== undefined) {
        const intent = this.#intent();
        if (intent !== "restore-aside" && intent !== "restore-install") log.violations.push(`${op} changed the live ${path.basename(touched)} at ${intent ?? "no transaction"}`);
      }
      // A rename, link or copy that lands on a file destroys what was there: it counts as a deletion of it.
      const replaces = twoPaths.has(op) && existsSync(dest);
      if (isDelete) log.deleted.push(args[0] ?? "");
      real(...args);
      if (replaces) log.deleted.push(dest);
      if (fault !== undefined) throw ioError(fault.code, args[0] ?? "", args[1]);
    };
    return {
      writeFile: (file, data, mode) => wrap("writeFile", f => realFileOps.writeFile(f, data, mode))(file),
      rename: wrap("rename", (a, b) => realFileOps.rename(a ?? "", b ?? "")),
      link: wrap("link", (a, b) => realFileOps.link(a ?? "", b ?? "")),
      copyFile: wrap("copyFile", (a, b) => realFileOps.copyFile(a ?? "", b ?? "")),
      unlink: wrap("unlink", a => realFileOps.unlink(a ?? ""), true),
      removeTree: wrap("removeTree", a => realFileOps.removeTree(a ?? ""), true),
      mkdir: (dir, mode) => wrap("mkdir", d => realFileOps.mkdir(d ?? "", mode))(dir),
      chmod: (file, mode) => wrap("chmod", f => realFileOps.chmod(f ?? "", mode))(file),
      fsyncFile: wrap("fsyncFile", f => realFileOps.fsyncFile(f ?? "")),
      fsyncDir: wrap("fsyncDir", d => realFileOps.fsyncDir(d ?? "")),
    };
  }

  /** The effects for one run. `crashAt` kills the run the first time it reaches that point. */
  effects(log: RunLog, crashAt?: StopPoint): WatcherEffects {
    let crashed = false;
    const guard = (what: string) => {
      const decided = this.#decided();
      if (decided !== null) log.violations.push(`${what} after ${decided}`);
    };
    return {
      spawn: token => {
        guard("spawned a token launch");
        log.spawns.push(token);
        const at = holds(this.program, this.old, this.new);
        const record = this.#spawnProc(at === "neither" ? "other" : at, token);
        if (at === "new" && existsSync(this.live) && currentVersion(this.live) < STORE_AFTER) {
          if (!existsSync(this.storeCopy)) copyStore(this.dataDir);
          migrateWithLiveWal(this.dataDir, STORE_AFTER, ["gamma"]);
        }
        return record;
      },
      waitForExit: async record => !this.#alive(record),
      treeGone: record => !this.#alive(record),
      stopTree: async record => {
        guard("stopped a tree");
        log.stops.push(record.pid);
        if (this.procs.get(record.pid)?.version === this.unstoppable) return false;
        this.#setAlive(record.pid, false);
        return true;
      },
      waitForAck: async (token, record) => {
        const proc = this.procs.get(record.pid);
        if (proc === undefined || proc.token !== token || !proc.alive) return "exited";
        return (proc.version === "new" ? this.newAcks : proc.version === "old" ? this.oldAcks : false) ? "ready" : "timeout";
      },
      writeResult: result => {
        const code = this.resultFault;
        this.resultFault = null;
        if (code !== null) throw ioError(code, path.join(this.dataDir, "update-result.json"));
        this.results.set(result.id, result);
      },
      readResult: id => this.results.get(id) ?? null,
      uptime: () => this.uptime,
      bootId: () => this.boot,
      showPage: words => { log.pages.push(words); },
      freeBytes: () => this.free,
      trustedKeys: this.trustedKeys,
      automaticChecks: true,
      newToken: () => `T-${++this.#tokens}`,
      startOrdinary: () => { log.ordinary++; },
      stopAt: point => {
        log.points.push(point);
        if (point === crashAt && !crashed) {
          crashed = true;
          throw new Crash(point);
        }
      },
      fs: this.#fs(log),
    };
  }

  #alive(record: ProcessRecord): boolean {
    return this.procs.get(record.pid)?.alive ?? false;
  }

  /** Every named file and folder of this transaction that exists now. */
  named(): string[] {
    const p = this.paths;
    return [p.previous, p.incoming, this.download, this.storeCopy, this.aside].filter(f => existsSync(f));
  }

  /** The bytes under the root, for "changed no file". */
  snapshot(): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else out.set(path.relative(this.root, full), createHash("sha256").update(readFileSync(full)).digest("hex"));
      }
    };
    walk(this.root);
    return out;
  }
}

function fail(what: string): never {
  throw new Error(`fixture: no ${what}`);
}

export const newLog = (): RunLog => ({ points: [], spawns: [], stops: [], deleted: [], ops: [], violations: [], pages: [], ordinary: 0 });

export type RunEnd = WatchOutcome | { readonly outcome: "crashed"; readonly point: StopPoint };

/** Runs `run`, turning a Crash into a run end; anything else is a real failure. */
export async function attempt(run: () => Promise<WatchOutcome>): Promise<RunEnd> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof Crash) return { outcome: "crashed", point: e.point };
    throw e;
  }
}

/**
 * The design's invariants, after any run (section 10 and the lane brief):
 * 1. the program path holds `old` or `new`;
 * 2. a run ending updated, rolled-back or stopped leaves a live store that holds exactly the rows from before (the migrated rows after an accept);
 * 3. nothing spawned or stopped once the transaction decided, and no file op changed the live store outside `restore-aside` and `restore-install`;
 * 4. rollback-failed and stuck delete nothing the transaction names (a rename, link or copy onto a file counts as deleting it);
 * 5. a stop before the replace leaves `old` and no `.incoming`.
 */
const within = (inner: string, outer: string): boolean => inner.startsWith(`${outer}${path.sep}`);

export function checkInvariants(w: World, end: RunEnd, log: RunLog, o: { readonly storeExpected?: boolean } = {}): void {
  const problems: string[] = [];
  const at = holds(w.program, w.old, w.new);
  if (at === "neither") problems.push("1: the program path holds neither old nor new");
  if ((end.outcome === "updated" || end.outcome === "rolled-back" || end.outcome === "stopped") && o.storeExpected !== false) {
    if (!existsSync(w.live)) problems.push(`2: no live store after ${end.outcome}`);
    else {
      const found = contents(w.live);
      // A stop comes before the replace, so the store must be exactly what it was before the update.
      const want = end.outcome === "updated" ? { version: STORE_AFTER, ids: MIGRATED } : { version: STORE_BEFORE, ids: BEFORE };
      if (JSON.stringify(found) !== JSON.stringify(want)) problems.push(`2: store after ${end.outcome} holds ${JSON.stringify(found)}`);
    }
  }
  problems.push(...log.violations.map(v => `3: ${v}`));
  if (end.outcome === "rollback-failed" || end.outcome === "stuck") {
    const named = [w.paths.previous, w.paths.incoming, w.download, w.storeCopy, w.aside];
    // A deletion counts when it removes a kept path, something inside one, or a folder that holds one.
    for (const gone of log.deleted) if (named.some(n => gone === n || within(gone, n) || within(n, gone))) problems.push(`4: ${end.outcome} deleted ${path.relative(w.root, gone)}`);
  }
  if (end.outcome === "stopped" && (at !== "old" || existsSync(w.paths.incoming))) problems.push(`5: stopped with the path at ${at}, incoming ${existsSync(w.paths.incoming) ? "present" : "absent"}`);
  if (problems.length > 0) throw new Error(`invariants broken after ${end.outcome}${"point" in end ? ` at ${end.point}` : ""}:\n${problems.join("\n")}`);
}
