import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { canonicalPathSync } from "../paths.ts";
import type { LibraryEntry } from "../types.ts";
import { isSeccompArch, lockFilter, type SeccompArch } from "./seccomp.ts";

const BWRAP = "/usr/bin/bwrap";
const SYSTEMD_RUN = "/usr/bin/systemd-run";
/** A test server points this at a stand-in (as GATES_LOCAL_NVIDIA_SMI does for nvidia-smi), to make the probe fail on any machine. */
const systemdRun = () => process.env["GATES_LOCAL_SYSTEMD_RUN"] || SYSTEMD_RUN;
/** Every tmpfs is 64 MiB; together with /dev they are charged to the scope's memory cap. */
const TMPFS_BYTES = String(64 * 1024 * 1024);
export const SCOPE_LIMITS = { memoryMaxBytes: 512 * 1024 * 1024, tasksMax: 64 } as const;
export const SCOPE_OFF = "The shell tool needs a user systemd session to cap its memory; it is off on this machine.";
export const ARCH_OFF = "The shell tool's lock filter covers x86_64 and aarch64 only; it is off on this machine.";

/**
 * The capped scope bwrap runs in. The kernel kills the process that goes over the
 * cap and the rest of the shell carries on, as in a terminal. OOMPolicy=continue
 * keeps systemd from stopping the whole scope and marking it failed (oom-kill),
 * which also raised a desktop out-of-memory notice for every hog.
 */
const scopeArgs = (unit: string) => [
  "--user", "--scope", "--quiet", "--collect", `--unit=${unit}`,
  "-p", "MemoryMax=512M", "-p", "MemorySwapMax=0", "-p", `TasksMax=${SCOPE_LIMITS.tasksMax}`,
  "-p", "OOMPolicy=continue", "--",
];
const tmpfs = (dest: string) => ["--size", TMPFS_BYTES, "--tmpfs", dest];
/**
 * The lock filter makes SQLite's shared lock fail, so a plain `sqlite3 /data/x.db`
 * would refuse the snapshot. Snapshots are the app's own copies that nothing
 * changes while mounted, so this wrapper opens them with immutable=1 (no locks).
 * A live database under /library still fails to open: that is the point.
 */
export const SQLITE_WRAPPER = `#!/usr/bin/bash
args=()
for arg in "$@"; do
  case "$arg" in
    /data/*.db) args+=("file:$arg?immutable=1") ;;
    *) args+=("$arg") ;;
  esac
done
exec /usr/bin/sqlite3 "\${args[@]}"
`;
/** fd 3 carries the seccomp program (seccomp.ts), fd 4 the sqlite3 wrapper. */
const sandboxFds = (arch: SeccompArch) => [lockFilter(arch), Buffer.from(SQLITE_WRAPPER)];
const baseArgs = () => [
  "--die-with-parent", "--new-session", "--unshare-all", "--unshare-user", "--disable-userns", "--cap-drop", "ALL",
  "--seccomp", "3",
  ...tmpfs("/"), "--ro-bind", "/usr", "/usr",
  "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib",
  ...(existsSync("/usr/lib64") ? ["--symlink", "usr/lib64", "/lib64"] : []),
  "--perms", "0555", "--ro-bind-data", "4", "/opt/gates/bin/sqlite3",
  "--proc", "/proc", "--dev", "/dev", ...tmpfs("/tmp"), ...tmpfs("/data"), ...tmpfs("/library"),
  "--clearenv", "--setenv", "PATH", "/opt/gates/bin:/usr/bin", "--setenv", "HOME", "/home/absent", "--setenv", "LC_ALL", "C",
  "--chdir", "/library",
];
// Source binds go between baseArgs and these, so the read-only remounts cover them;
// `/` is the last mount argument, which leaves only the capped /tmp (and /dev) writable.
const finalMounts = ["--remount-ro", "/data", "--remount-ro", "/library", "--remount-ro", "/"];

/** `word` is the few words Settings › Tools shows in place of Ready; `reason` the sentence a turn or log gives. */
export type SandboxProbe = { available: true; arch: SeccompArch } | { available: false; word: string; reason: string; detail?: string };
export interface SandboxHost {
  platform: NodeJS.Platform;
  arch: string;
  exists: (file: string) => boolean;
  /** `fds` become fds 3, 4, ... in the child: written and closed before bwrap reads them. */
  run: (command: string, args: readonly string[], fds?: readonly Buffer[]) => Promise<{ code: number | null; output: string; error?: Error }>;
}

/** `fds` are written to fds 3, 4, ...; `readFds` more pipes after them stay open for the child to write. */
function spawnScoped(command: string, args: readonly string[], fds: readonly Buffer[], readFds = 0) {
  // bwrap --clearenv empties the sandbox's environment; this env only reaches systemd-run.
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe", ...[...fds, ...Array<undefined>(readFds)].map(() => "pipe" as const)], detached: true, env: scopeEnv() });
  fds.forEach((data, i) => (child.stdio[3 + i] as Writable).on("error", () => undefined).end(data));
  return child;
}

/**
 * fd 5 is the start marker: the sandbox's first process writes one byte to it once
 * systemd-run and bwrap have set everything up, and closes it before the command
 * runs. A failure with no marker came from the setup, never from the command.
 */
const MARKER_FD = 5;
const launch = (command: string) => ["/usr/bin/bash", "--noprofile", "--norc", "-c",
  `printf . >&${MARKER_FD}; exec ${MARKER_FD}>&-; exec /usr/bin/bash --noprofile --norc -c "$1"`, "gates-shell", command];

const virtualPath = (source: LibraryEntry) => source.kind === "sqlite" ? `/data/${source.id}.db` : `/library/${source.id}`;
/** The host path a source binds: the snapshot for a database, the folder or file itself otherwise. */
const boundPath = (source: LibraryEntry) => source.kind === "sqlite" ? requiredSnapshot(source) : source.path;

/** A source whose host path is gone, unreadable or moved, in virtual terms only. */
function unavailable(source: LibraryEntry, error?: unknown): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const what = source.kind === "folder" ? "folder" : "file";
  const why = source.kind === "sqlite"
    ? code === "ENOENT" || code === "ENOTDIR" ? "the source was removed during this reply" : "its snapshot could not be opened; refresh the source"
    : code === undefined ? `its ${what} now resolves somewhere else; reconnect it`
    : code === "ENOENT" || code === "ENOTDIR" ? `its ${what} was moved or removed`
    : code === "EACCES" || code === "EPERM" ? `its ${what} can no longer be read`
    : `its ${what} could not be opened`;
  return new Error(`${virtualPath(source)}: no longer available (${why})`);
}

/** The first source whose host path no longer resolves to itself, as a virtual-path error. */
function checkSources(sources: readonly LibraryEntry[]): Error | undefined {
  for (const source of sources) {
    const expected = boundPath(source);
    let host: string;
    try { host = canonicalPathSync(expected); } catch (e) { return unavailable(source, e); }
    if (host !== expected) return unavailable(source);
  }
  return undefined;
}

/** A source's host paths: its own, and for a database the snapshot, the snapshots folder and the data dir. */
const hostPaths = (source: LibraryEntry) => source.kind === "sqlite"
  ? [source.path, requiredSnapshot(source), path.dirname(requiredSnapshot(source)), path.dirname(path.dirname(requiredSnapshot(source)))]
  : [source.path];

/**
 * A failure before the command started. A source that went away is named; anything else
 * is a fixed sentence with the virtual paths involved. systemd-run's or bwrap's own text
 * is kept only when it holds no host path (a source, the data dir, home, the server's cwd).
 */
function setupFailure(sources: readonly LibraryEntry[], raw: string): Error {
  const gone = checkSources(sources);
  if (gone) return gone;
  const named = sources.filter(source => hostPaths(source).some(host => raw.includes(host)));
  const involved = (named.length > 0 ? named : sources).map(virtualPath);
  const leaks = [...sources.flatMap(hostPaths), homedir(), process.cwd()].some(host => host && raw.includes(host));
  const text = raw.trim();
  return new Error(`The shell sandbox could not start${involved.length > 0 ? ` while setting up ${involved.join(", ")}` : ""}${!leaks && text ? `: ${text}` : "."}`);
}

/** systemd-run finds the user bus through XDG_RUNTIME_DIR; a server started outside a login shell may lack it. */
function scopeEnv(): NodeJS.ProcessEnv {
  if (process.env.XDG_RUNTIME_DIR || process.env.DBUS_SESSION_BUS_ADDRESS || typeof process.getuid !== "function") return process.env;
  const runtime = `/run/user/${process.getuid()}`;
  return existsSync(`${runtime}/bus`) ? { ...process.env, XDG_RUNTIME_DIR: runtime } : process.env;
}

const hostRun: SandboxHost["run"] = (command, args, fds = []) => new Promise(resolve => {
  const child = spawnScoped(command, args, fds);
  let output = "";
  const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } }, 10000);
  child.stdout!.on("data", d => { output += String(d); });
  child.stderr!.on("data", d => { output += String(d); });
  child.on("error", error => { clearTimeout(timer); resolve({ code: null, output, error }); });
  child.on("close", code => { clearTimeout(timer); resolve({ code, output }); });
});
const realHost: SandboxHost = { platform: process.platform, arch: process.arch, exists: existsSync, run: hostRun };

const scopeOff = (detail: string) => ({ available: false as const, word: "Needs a systemd user session", reason: SCOPE_OFF, detail });

/**
 * Checks, in order: Linux, a filter for this arch, bwrap, a working capped user scope, and a real
 * command (/usr/bin/true) run in the full sandbox. Only that last one passing makes it available.
 */
export async function probeSandboxWith(host: SandboxHost): Promise<SandboxProbe> {
  if (host.platform !== "linux") return { available: false, word: "Linux only", reason: "The shell tool runs only on Linux." };
  if (!isSeccompArch(host.arch)) return { available: false, word: "Not on this processor", reason: ARCH_OFF };
  const arch = host.arch;
  if (!host.exists(BWRAP)) return { available: false, word: "Needs bubblewrap", reason: "The shell tool needs bubblewrap (/usr/bin/bwrap); it is off on this machine." };
  if (!host.exists(systemdRun())) return scopeOff(`${systemdRun()} is missing`);
  // The scope must exist and carry the caps, read back from its own cgroup files.
  const caps = await host.run(systemdRun(), [...scopeArgs(`gates-shell-probe-${randomUUID()}`), "/usr/bin/sh", "-c",
    'cg=$(cut -d: -f3 /proc/self/cgroup); cat "/sys/fs/cgroup$cg/memory.max" "/sys/fs/cgroup$cg/memory.swap.max" "/sys/fs/cgroup$cg/pids.max"']);
  const expected = `${SCOPE_LIMITS.memoryMaxBytes}\n0\n${SCOPE_LIMITS.tasksMax}`;
  if (caps.error || caps.code !== 0 || caps.output.trim() !== expected) return scopeOff((caps.error?.message ?? caps.output.trim()) || `exit ${caps.code}`);
  const result = await host.run(systemdRun(), [...scopeArgs(`gates-shell-probe-${randomUUID()}`), BWRAP, ...baseArgs(), ...finalMounts, "--", "/usr/bin/true"], sandboxFds(arch));
  if (!result.error && result.code === 0) return { available: true, arch };
  const message = result.output.trim() || result.error?.message || `exit ${result.code}`;
  if (/operation not permitted|permission denied|creating new namespace|no permissions to create/i.test(message)) {
    return { available: false, word: "Can't create its sandbox", reason: "The shell tool cannot create its sandbox on this machine; it is off.", detail: message };
  }
  // A broken mount or filter, or a bwrap this machine set up oddly: off, and Settings says so
  // instead of Ready (the real-confinement tests below still fail on it rather than skip).
  return { available: false, word: "Sandbox check failed", reason: "The shell tool's sandbox failed its check on this machine; it is off.", detail: `bwrap probe failed: ${message}` };
}

/** How long a failed probe stands before the next use asks again (bubblewrap installed, a session started). */
export const PROBE_RETRY_MS = 30_000;

/** A probe kept for good once it passes; a failed one is asked again after PROBE_RETRY_MS. Calls during one share it. */
export function createProbe(host: SandboxHost, now: () => number = Date.now): () => Promise<SandboxProbe> {
  const once = () => probeSandboxWith(host).catch((e: unknown): SandboxProbe =>
    ({ available: false, word: "Sandbox check failed", reason: "The shell tool's sandbox failed its check on this machine; it is off.", detail: (e as Error).message }));
  let last: { at: number; probe: Promise<SandboxProbe> } | undefined;
  return () => {
    if (last === undefined) last = { at: now(), probe: once() };
    else if (now() - last.at >= PROBE_RETRY_MS) last = { at: now(), probe: last.probe.then(p => p.available ? p : once()) };
    return last.probe;
  };
}

/** The process's probe: run at first use, kept once it passes. */
export const probeSandbox = createProbe(realHost);

/** Kills every process in the scope through its cgroup, then the process group. */
function killScope(pid: number | undefined, unit: string): void {
  if (pid === undefined) return;
  try {
    const line = readFileSync(`/proc/${pid}/cgroup`, "utf8").split("\n").find(l => l.startsWith("0::"));
    const cgroup = line?.slice(3);
    // Only ever the scope this call created; never the server's own cgroup.
    if (cgroup?.endsWith(`/${unit}.scope`)) writeFileSync(`/sys/fs/cgroup${cgroup}/cgroup.kill`, "1");
  } catch { /* the scope is already gone */ }
  try { process.kill(-pid, "SIGKILL"); } catch { /* the group is already gone */ }
}

export interface SandboxInput {
  command: string;
  sources: readonly LibraryEntry[];
  signal?: AbortSignal;
  timeoutMs?: number;
  outputCap?: number;
  /** Tests only: runs after the source check and the probe, just before launch, to race them deterministically. */
  beforeLaunch?: () => void;
  /** Tests only: stands in for systemd-run, to force a setup failure. */
  launcher?: string;
}

export async function runSandbox(input: SandboxInput): Promise<string> {
  input.signal?.throwIfAborted();
  // Sources first: one gone since the turn began is named by its virtual path, never its host path.
  for (const source of input.sources) if (!/^[\w-]+$/.test(source.id)) throw new Error("Invalid Library source id");
  const gone = checkSources(input.sources);
  if (gone) throw gone;
  const binds = input.sources.flatMap(source => ["--ro-bind", boundPath(source), virtualPath(source)]);
  const probe = await probeSandbox();
  if (!probe.available) throw new Error(probe.reason);
  input.signal?.throwIfAborted();
  const args = [...baseArgs(), ...binds, ...finalMounts, "--", ...launch(input.command)];
  const unit = `gates-shell-${randomUUID()}`;
  input.beforeLaunch?.();
  return new Promise((resolve, reject) => {
    const child = spawnScoped(input.launcher ?? systemdRun(),[...scopeArgs(unit), BWRAP, ...args], sandboxFds(probe.arch), 1);
    // Until the marker arrives, everything on stdout and stderr is systemd-run's or bwrap's.
    let started = false;
    const marker = (child.stdio as readonly unknown[])[MARKER_FD] as Readable;
    marker.on("data", () => { started = true; }).on("error", () => undefined);
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const stop = (error: Error) => { failure ??= error; killScope(child.pid, unit); };
    const timer = setTimeout(() => stop(new Error("Shell exceeded its time limit")), Math.min(30000, Math.max(1, input.timeoutMs ?? 10000)));
    const abort = () => stop(new Error("Shell cancelled"));
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (input.outputCap ?? 100000)) stop(new Error("Shell exceeded its output limit"));
      else chunks.push(chunk);
    };
    child.stdout!.on("data", data); child.stderr!.on("data", data);
    const cleanup = () => { clearTimeout(timer); input.signal?.removeEventListener("abort", abort); };
    child.on("error", e => { cleanup(); reject(setupFailure(input.sources, e.message)); });
    child.on("close", (code, signal) => {
      cleanup();
      const output = Buffer.concat(chunks).toString("utf8");
      if (failure) reject(failure);
      else if (!started && (code !== 0 || signal)) reject(setupFailure(input.sources, output));
      else if (signal || code === 137) reject(new Error(`Shell was killed${signal ? ` (${signal})` : ""}; it may have gone over its 512 MB memory cap: ${output}`));
      else if (code !== 0) reject(new Error(`Shell exited ${code}: ${output}`));
      else resolve(output);
    });
  });
}

function requiredSnapshot(source: LibraryEntry): string {
  if (!source.snapshotPath) throw new Error("SQLite source has no snapshot");
  return source.snapshotPath;
}
