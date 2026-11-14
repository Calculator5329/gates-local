// Windows W-A (docs/design/installed-updates.md, section 3): an install made
// by the Windows installer updates by running the checked installer of the
// new version silently. No watcher and no automatic go-back.
//
// The click (after the server committed the approval): verify the download
// again from its bytes, write updates/windows-pending.json, start
// `<installer> /S --updated --force-run` detached, and quit. The installer's
// running-app check (apps/desktop/build/installer.nsh) waits for this
// install's processes to end, never kills, then installs and starts the new
// version. An installer that is refused (Smart App Control, a policy) or
// ends at once leaves the running app as it was: the note is removed and the
// person reads where the checked installer is, to run it themselves.
//
// The next launch reads the note: the version it names is running, so it says
// "Updated to version <v>." once; or the update did not finish, and it names
// the installer. The running version's folder in updates/ stays: it is the
// kept installer the next update names to go back with (the server's cleanup
// keeps it).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type Identity, updatesRoot, type Verified, verifyKept } from "../../../server/src/update/installed/download.ts";
import { writeRecord } from "../../../server/src/update/record.ts";
import { compare, parseRelease } from "../../../server/src/update/semver.ts";
import type { UpdateAndRestartResult } from "../bridge.ts";
import * as words from "./words.ts";

export const PENDING_FILE = "windows-pending.json";
/** Silent, as an update (the stock close prompt is skipped), and start the app when done. */
export const INSTALLER_ARGS = ["/S", "--updated", "--force-run"] as const;
/** The installer leaves this next to the app; a copy without it was not installed by it. */
export const UNINSTALLER = "Uninstall Gates Local.exe";
/** How long a started installer must keep running before the app quits for it. It waits for this app, so it cannot finish sooner. */
export const INSTALLER_GRACE_MS = 2_000;

/** What the click wrote before it started the installer. */
export interface Pending {
  readonly from: string;
  readonly to: string;
  /** SHA-512 of the signed list the person approved. */
  readonly listDigest: string;
  readonly installer: string;
  readonly at: number;
}

export const pendingFile = (dataDir: string) => path.join(updatesRoot(dataDir), PENDING_FILE);

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Write, flush, rename into place. Windows cannot open a folder to flush it; the rename is what it has. */
export function writePending(dataDir: string, pending: Pending): void {
  const file = pendingFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify({ version: 1, ...pending }, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  if (process.platform !== "win32") {
    const dir = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
}

const RELEASE = /^\d+\.\d+\.\d+$/;
function decodePending(raw: string): Pending | null {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const { from, to, listDigest, installer, at } = o;
  if (o["version"] !== 1 || typeof from !== "string" || typeof to !== "string" || !RELEASE.test(to) || typeof listDigest !== "string" || typeof installer !== "string" || typeof at !== "number") return null;
  return { from, to, listDigest, installer, at };
}

function removePending(dataDir: string): void {
  fs.rmSync(pendingFile(dataDir), { force: true });
}

export type Settled =
  | { readonly kind: "none" }
  | { readonly kind: "updated"; readonly to: string }
  | { readonly kind: "did-not-finish"; readonly to: string; readonly installer: string }
  /** A note that does not decode, or names a version below the running one (installed by hand since): removed, nothing said. */
  | { readonly kind: "dropped"; readonly why: string };

/**
 * Step 6, before the server starts: the note becomes the result the server
 * shows once (update-result.json), then the note goes. A crash between the
 * two says it again on the next launch, never not at all.
 */
export function settlePending(dataDir: string, running: string, now: () => number = Date.now): Settled {
  let raw: string;
  try { raw = fs.readFileSync(pendingFile(dataDir), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
    return { kind: "dropped", why: `the note could not be read: ${message(error)}` };
  }
  const pending = decodePending(raw);
  let settled: Settled;
  if (pending === null) settled = { kind: "dropped", why: "the note does not decode" };
  else {
    const target = parseRelease(`v${pending.to}`);
    const own = parseRelease(`v${running}`);
    const base = { id: randomUUID(), from: pending.from, to: pending.to };
    if (pending.to === running) {
      writeRecord(dataDir, { at: now(), outcome: "updated", installed: { ...base, text: words.updated(pending.to).text } });
      settled = { kind: "updated", to: pending.to };
    } else if (target !== null && own !== null && compare(own, target) < 0) {
      const said = words.windowsDidNotFinish(pending.to, pending.installer);
      writeRecord(dataDir, { at: now(), outcome: "stopped", installed: { ...base, text: said.text, link: true } });
      settled = { kind: "did-not-finish", to: pending.to, installer: pending.installer };
    } else settled = { kind: "dropped", why: `version ${running} runs, above the note's ${pending.to}` };
  }
  removePending(dataDir);
  return settled;
}

export type InstallerStart = { readonly started: true } | { readonly started: false; readonly why: string };

/**
 * Starts the installer on its own, outside this app, so it outlives the quit.
 * Started means it was still running after the grace period: a refusal shows
 * as a spawn error, and a run that ends at once (another installer open, a
 * check that could not run) as an exit inside the grace.
 */
export function startInstaller(file: string, o: { readonly graceMs?: number } = {}): Promise<InstallerStart> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...INSTALLER_ARGS], { detached: true, stdio: "ignore", windowsHide: true });
    } catch (error) {
      resolve({ started: false, why: message(error) });
      return;
    }
    const timer = setTimeout(() => {
      child.removeAllListeners();
      child.unref();
      resolve({ started: true });
    }, o.graceMs ?? INSTALLER_GRACE_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ started: false, why: error.message });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ started: false, why: `the installer ended at once (${code ?? signal ?? "no code"})` });
    });
  });
}

export interface WindowsClick {
  readonly dataDir: string;
  /** This copy's version. */
  readonly running: string;
  /** verifyPrepared for this copy; it deletes a folder that fails. */
  readonly verify: (version: string) => Promise<Verified>;
  /** startInstaller, or a fake. */
  readonly start: (installer: string) => Promise<InstallerStart>;
  readonly quit: () => void;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

const TARGET = /^(\d+\.\d+\.\d+):([a-f0-9]{128})$/;

/** Step 4, once the server has committed the approval of `<version>:<list digest>`. */
export async function startWindowsUpdate(target: string, o: WindowsClick): Promise<UpdateAndRestartResult> {
  const match = TARGET.exec(target);
  if (match === null) return { ok: false, message: "An exact checked version and current server approval are required. Check for updates again." };
  const [, version, digest] = match as unknown as [string, string, string];
  const verified = await o.verify(version);
  if (!verified.ok || verified.prepared.listSha512 !== digest || verified.prepared.version !== version) {
    return { ok: false, message: words.badDownload(version, true).text };
  }
  const installer = verified.prepared.file;
  const refused = (why: string): UpdateAndRestartResult => {
    o.log?.(`the installer did not start: ${why}`);
    try { removePending(o.dataDir); } catch (error) { o.log?.(`could not remove the pending note: ${message(error)}`); }
    return { ok: false, message: words.installerDidNotStart(installer).text };
  };
  try {
    writePending(o.dataDir, { from: o.running, to: version, listDigest: digest, installer, at: (o.now ?? Date.now)() });
  } catch (error) {
    return refused(`could not write the pending note: ${message(error)}`);
  }
  const started = await o.start(installer).catch((error: unknown): InstallerStart => ({ started: false, why: message(error) }));
  if (!started.started) return refused(started.why);
  o.quit();
  return { ok: true };
}

/**
 * Step 7: the installer of the newest version below the running one that is
 * still kept and checks out, for the status page of a version whose server
 * failed. Null when there is none.
 */
export async function goBackInstaller(o: Identity): Promise<string | null> {
  const own = parseRelease(`v${o.running}`);
  if (own === null) return null;
  const names = await fs.promises.readdir(updatesRoot(o.dataDir)).catch(() => [] as string[]);
  const older = names
    .map((name) => ({ name, version: parseRelease(`v${name}`) }))
    .filter((e): e is { name: string; version: NonNullable<typeof e.version> } => e.version !== null && RELEASE.test(e.name) && compare(e.version, own) < 0)
    .toSorted((a, b) => compare(b.version, a.version));
  for (const e of older) {
    const kept = await verifyKept({ ...o, version: e.name });
    if (kept.ok) return kept.prepared.file;
  }
  return null;
}
