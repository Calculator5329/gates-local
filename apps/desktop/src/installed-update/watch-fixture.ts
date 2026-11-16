import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeManifest, signManifest } from "@gates-local/update/release-manifest";
import type { ProcessRecord } from "@gates-local/update/identity";
import { identify, realFileOps, type FileOps, type Identity } from "@gates-local/update/installed/files";
import { holds, programPaths, type ProgramPaths } from "./linux.ts";
import { asideFolder, copyPath, STORE_FILES, STORE_NAME } from "./restore.ts";
import type { StopPoint } from "./stop-points.ts";
import { contents, copyStore, createStore, currentVersion, migrateWithLiveWal } from "./store-fixture.ts";
import { readTransaction, transactionFile, UPDATES_FOLDER, type Approval, type InstalledTransaction } from "@gates-local/update/installed/transaction";
import type { InstalledResult, WatcherEffects, WatchOutcome } from "./watch.ts";
import type { Words } from "@gates-local/update/installed/words";

export const FROM = "1.4.0";
export const TO = "1.5.0";
export const BEFORE = ["alpha", "beta"];
export const MIGRATED = ["alpha", "beta", "gamma"];
export const STORE_BEFORE = 4;
export const STORE_AFTER = 6;
const OLD_BYTES = "old program bytes, version 1.4.0";
const NEW_BYTES = "new program bytes, version 1.5.0, a little longer";
const UPTIME = 1_000;

export class Crash extends Error {
  readonly point: StopPoint;
  constructor(point: StopPoint) {
    super(`killed at ${point}`);
    this.name = "Crash";
    this.point = point;
  }
}

// external: Node's fs errors name the source in path and a rename, link or copy's target in dest.
export const ioError = (code: string, file: string, dest?: string): Error =>
  Object.assign(new Error(`${code}: ${file}`), { code, path: file }, dest === undefined ? {} : { dest });

interface Proc { alive: boolean; readonly version: "old" | "new" | "other"; readonly token: string }

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
  readonly logged: string[];
  ordinary: number;
}

const roots: string[] = [];
export function removeWorlds(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export interface WorldOptions {
  readonly newAcks?: boolean;
  readonly oldAcks?: boolean;
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
  approval: Approval;
  newAcks: boolean;
  oldAcks: boolean;
  boot = "boot-1";
  uptime = UPTIME;
  free = 1e12;
  readonly procs = new Map<number, Proc>();
  readonly results = new Map<string, InstalledResult>();
  faults: Fault[] = [];
  resultFault: string | null = null;
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

    // why: main quit when the person clicked Restart, so its records name processes already gone.
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

  hangOldApp(): void {
    this.#setAlive(this.approval.main.pid, true);
    this.#setAlive(this.approval.server.pid, true);
  }

  // why: main stops a token launch whose watcher died with no result for its token (RT-05).
  watcherDied(): void {
    const answered = new Set([...this.results.values()].flatMap(r => "token" in r ? [r.token] : []));
    for (const proc of this.procs.values()) if (proc.token.startsWith("T-") && !answered.has(proc.token)) proc.alive = false;
  }

  reboot(): void {
    for (const proc of this.procs.values()) proc.alive = false;
    this.boot = `boot-${Number(this.boot.slice(5)) + 1}`;
    this.uptime = 10;
  }

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
    const twoPaths = new Set<keyof FileOps>(["rename", "link", "copyFile"]);
    const changes = new Set<keyof FileOps>(["writeFile", "rename", "link", "copyFile", "unlink", "removeTree"]);
    const wrap = (op: keyof FileOps, real: (...args: string[]) => void, isDelete = false) => (...args: string[]): void => {
      log.ops.push(`${op} ${args.map(a => path.relative(this.root, a)).join(" ")}`);
      const fault = firing(op, args);
      if (fault !== undefined && (fault.when ?? "before") === "before") throw ioError(fault.code, args[0] ?? "", args[1]);
      const dest = (twoPaths.has(op) ? args[1] : args[0]) ?? "";
      const touched = [dest, ...(op === "rename" ? [args[0] ?? ""] : [])].find(f => storeFiles.has(f));
      if (changes.has(op) && touched !== undefined) {
        const intent = this.#intent();
        if (intent !== "restore-aside" && intent !== "restore-install") log.violations.push(`${op} changed the live ${path.basename(touched)} at ${intent ?? "no transaction"}`);
      }
      // why: a rename, link or copy onto a file destroys what was there.
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
      // why: no test here cuts the power, and waiting for the disk was most of the matrix's time.
      fsyncFile: wrap("fsyncFile", () => {}),
      fsyncDir: wrap("fsyncDir", () => {}),
    };
  }

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
      log: line => { log.logged.push(line); },
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

  named(): string[] {
    const p = this.paths;
    return [p.previous, p.incoming, this.download, this.storeCopy, this.aside].filter(f => existsSync(f));
  }

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

export const newLog = (): RunLog => ({ points: [], spawns: [], stops: [], deleted: [], ops: [], violations: [], pages: [], logged: [], ordinary: 0 });

export type RunEnd = WatchOutcome | { readonly outcome: "crashed"; readonly point: StopPoint };

export async function attempt(run: () => Promise<WatchOutcome>): Promise<RunEnd> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof Crash) return { outcome: "crashed", point: e.point };
    throw e;
  }
}

const within = (inner: string, outer: string): boolean => inner.startsWith(`${outer}${path.sep}`);

export function checkInvariants(w: World, end: RunEnd, log: RunLog, o: { readonly storeExpected?: boolean } = {}): void {
  const problems: string[] = [];
  const at = holds(w.program, w.old, w.new);
  if (at === "neither") problems.push("1: the program path holds neither old nor new");
  if ((end.outcome === "updated" || end.outcome === "rolled-back" || end.outcome === "stopped") && o.storeExpected !== false) {
    if (!existsSync(w.live)) problems.push(`2: no live store after ${end.outcome}`);
    else {
      const found = contents(w.live);
      const want = end.outcome === "updated" ? { version: STORE_AFTER, ids: MIGRATED } : { version: STORE_BEFORE, ids: BEFORE };
      if (JSON.stringify(found) !== JSON.stringify(want)) problems.push(`2: store after ${end.outcome} holds ${JSON.stringify(found)}`);
    }
  }
  problems.push(...log.violations.map(v => `3: ${v}`));
  if (end.outcome === "rollback-failed" || end.outcome === "stuck") {
    const named = [w.paths.previous, w.paths.incoming, w.download, w.storeCopy, w.aside];
    for (const gone of log.deleted) if (named.some(n => gone === n || within(gone, n) || within(n, gone))) problems.push(`4: ${end.outcome} deleted ${path.relative(w.root, gone)}`);
  }
  if (end.outcome === "stopped" && (at !== "old" || existsSync(w.paths.incoming))) problems.push(`5: stopped with the path at ${at}, incoming ${existsSync(w.paths.incoming) ? "present" : "absent"}`);
  if (problems.length > 0) throw new Error(`invariants broken after ${end.outcome}${"point" in end ? ` at ${end.point}` : ""}:\n${problems.join("\n")}`);
}
