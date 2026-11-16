import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type Identity, updatesRoot, type Verified, verifyKept } from "@gates-local/update/installed/download";
import { writeRecord } from "@gates-local/update/record";
import { compare, parseRelease } from "@gates-local/update/semver";
import type { UpdateAndRestartResult } from "../bridge.ts";
import * as words from "@gates-local/update/installed/words";

export const PENDING_FILE = "windows-pending.json";
// external: the Windows installer reads /S as silent, --updated as an update with no close prompt, --force-run as start after.
export const INSTALLER_ARGS = ["/S", "--updated", "--force-run"] as const;
// external: the Windows installer leaves this next to the app; a copy without it was not installed by it.
export const UNINSTALLER = "Uninstall Gates Local.exe";
// why: the installer waits for this app to quit, so it cannot finish inside this time.
export const INSTALLER_GRACE_MS = 2_000;

export interface Pending {
  readonly from: string;
  readonly to: string;
  readonly listDigest: string;
  readonly installer: string;
  readonly at: number;
}

export const pendingFile = (dataDir: string) => path.join(updatesRoot(dataDir), PENDING_FILE);

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
  // external: Windows cannot open a folder to flush it, so there the rename is the last step.
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
  | { readonly kind: "dropped"; readonly why: string };

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
  readonly running: string;
  readonly verify: (version: string) => Promise<Verified>;
  readonly start: (installer: string) => Promise<InstallerStart>;
  readonly quit: () => void;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

const TARGET = /^(\d+\.\d+\.\d+):([a-f0-9]{128})$/;

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
