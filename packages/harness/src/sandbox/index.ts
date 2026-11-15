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
const SQLITE = "/usr/bin/sqlite3";
const SYSTEMD_RUN = "/usr/bin/systemd-run";
// why: a test server points these at stand-ins, so the probe can fail on any machine.
const systemdRun = () => process.env["GATES_LOCAL_SYSTEMD_RUN"] || SYSTEMD_RUN;
const bwrap = () => process.env["GATES_LOCAL_BWRAP"] || BWRAP;
const sqlite = () => process.env["GATES_LOCAL_SQLITE"] || SQLITE;
// external: Linux charges tmpfs pages to the cgroup, so every tmpfs and /dev count toward the scope's memory cap.
const TMPFS_BYTES = String(64 * 1024 * 1024);
export const SCOPE_LIMITS = { memoryMaxBytes: 512 * 1024 * 1024, tasksMax: 64 } as const;
export const SCOPE_OFF = "The shell tool needs a user systemd session to cap its memory; it is off on this machine.";
export const ARCH_OFF = "The shell tool's lock filter covers x86_64 and aarch64 only; it is off on this machine.";

// external: without OOMPolicy=continue systemd stops the whole scope on one out-of-memory kill and raises a desktop notice for it.
const cappedScopeArgs = (unit: string) => [
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
exec ${SQLITE} "\${args[@]}"
`;
const FIRST_PASSED_FD = 3;
const SECCOMP_PROGRAM_FD = FIRST_PASSED_FD;
const SQLITE_WRAPPER_FD = FIRST_PASSED_FD + 1;
// why: a failure with no byte on the marker came from the setup, never from the command.
const MARKER_FD = FIRST_PASSED_FD + 2;
const writtenFds = (arch: SeccompArch) => [lockFilter(arch), Buffer.from(SQLITE_WRAPPER)];
const baseArgs = () => [
  "--die-with-parent", "--new-session", "--unshare-all", "--unshare-user", "--disable-userns", "--cap-drop", "ALL",
  "--seccomp", String(SECCOMP_PROGRAM_FD),
  ...tmpfs("/"), "--ro-bind", "/usr", "/usr",
  "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib",
  ...(existsSync("/usr/lib64") ? ["--symlink", "usr/lib64", "/lib64"] : []),
  "--perms", "0555", "--ro-bind-data", String(SQLITE_WRAPPER_FD), "/opt/gates/bin/sqlite3",
  "--proc", "/proc", "--dev", "/dev", ...tmpfs("/tmp"), ...tmpfs("/data"), ...tmpfs("/library"),
  "--clearenv", "--setenv", "PATH", "/opt/gates/bin:/usr/bin", "--setenv", "HOME", "/home/absent", "--setenv", "LC_ALL", "C",
  "--chdir", "/library",
];
// why: after the source binds, so the remounts cover them; / last leaves only /tmp writable.
const FINAL_MOUNTS = ["--remount-ro", "/data", "--remount-ro", "/library", "--remount-ro", "/"];
const bwrapArgs = (sourceBinds: readonly string[], command: readonly string[]) =>
  [...baseArgs(), ...sourceBinds, ...FINAL_MOUNTS, "--", ...command];

/** `word` is the few words Settings › Tools shows in place of Ready; `reason` the sentence a turn or log gives. */
export type SandboxProbe = { available: true; arch: SeccompArch; sqlite: boolean } | { available: false; word: string; reason: string; detail?: string };
/** `run`'s `fds` become fds 3, 4, ... in the child: written and closed before bwrap reads them. */
export interface SandboxHost {
  platform: NodeJS.Platform;
  arch: string;
  exists: (file: string) => boolean;
  run: (command: string, args: readonly string[], fds?: readonly Buffer[]) => Promise<{ code: number | null; output: string; error?: Error }>;
}

function spawnScoped(command: string, args: readonly string[], fds: readonly Buffer[], readFds = 0) {
  // why: readFds more pipes after the written ones stay open for the child to write.
  const passed = [...fds, ...Array<undefined>(readFds)].map(() => "pipe" as const);
  // why: bwrap --clearenv empties the sandbox's environment; this env only reaches systemd-run.
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe", ...passed], detached: true, env: scopeEnv() });
  fds.forEach((data, i) => (child.stdio[FIRST_PASSED_FD + i] as Writable).on("error", () => undefined).end(data));
  return child;
}

const launch = (command: string) => ["/usr/bin/bash", "--noprofile", "--norc", "-c",
  `printf . >&${MARKER_FD}; exec ${MARKER_FD}>&-; exec /usr/bin/bash --noprofile --norc -c "$1"`, "gates-shell", command];

const virtualPath = (source: LibraryEntry) => source.kind === "sqlite" ? `/data/${source.id}.db` : `/library/${source.id}`;
const hostPathToBind = (source: LibraryEntry) => source.kind === "sqlite" ? requiredSnapshot(source) : source.path;

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

function checkSources(sources: readonly LibraryEntry[]): Error | undefined {
  for (const source of sources) {
    const expected = hostPathToBind(source);
    let host: string;
    try { host = canonicalPathSync(expected); } catch (e) { return unavailable(source, e); }
    if (host !== expected) return unavailable(source);
  }
  return undefined;
}

const hostPaths = (source: LibraryEntry) => {
  if (source.kind !== "sqlite") return [source.path];
  const snapshot = requiredSnapshot(source);
  const snapshotsFolder = path.dirname(snapshot);
  const dataDir = path.dirname(snapshotsFolder);
  return [source.path, snapshot, snapshotsFolder, dataDir];
};

function setupFailure(sources: readonly LibraryEntry[], raw: string): Error {
  const gone = checkSources(sources);
  if (gone) return gone;
  const named = sources.filter(source => hostPaths(source).some(host => raw.includes(host)));
  const involved = (named.length > 0 ? named : sources).map(virtualPath);
  // why: systemd-run's or bwrap's own text is kept only when it holds no host path.
  const leaks = [...sources.flatMap(hostPaths), homedir(), process.cwd()].some(host => host && raw.includes(host));
  const text = raw.trim();
  return new Error(`The shell sandbox could not start${involved.length > 0 ? ` while setting up ${involved.join(", ")}` : ""}${!leaks && text ? `: ${text}` : "."}`);
}

// external: systemd-run finds the user bus through XDG_RUNTIME_DIR, which a server started outside a login shell may lack.
function scopeEnv(): NodeJS.ProcessEnv {
  if (process.env.XDG_RUNTIME_DIR || process.env.DBUS_SESSION_BUS_ADDRESS || typeof process.getuid !== "function") return process.env;
  const runtime = `/run/user/${process.getuid()}`;
  return existsSync(`${runtime}/bus`) ? { ...process.env, XDG_RUNTIME_DIR: runtime } : process.env;
}

function killGroup(leader: number): void {
  try { process.kill(-leader, "SIGKILL"); } catch {
    // why: a group that is already gone needs no kill.
    return;
  }
}

const hostRun: SandboxHost["run"] = (command, args, fds = []) => new Promise(resolve => {
  const child = spawnScoped(command, args, fds);
  let output = "";
  const timer = setTimeout(() => killGroup(child.pid!), 10000);
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
  if (!host.exists(bwrap())) return { available: false, word: "Needs bubblewrap", reason: "The shell tool needs bubblewrap (/usr/bin/bwrap); it is off on this machine." };
  if (!host.exists(systemdRun())) return scopeOff(`${systemdRun()} is missing`);
  // why: the scope must exist and carry the caps, so they are read back from its own cgroup files.
  const caps = await host.run(systemdRun(), [...cappedScopeArgs(`gates-shell-probe-${randomUUID()}`), "/usr/bin/sh", "-c",
    'cg=$(cut -d: -f3 /proc/self/cgroup); cat "/sys/fs/cgroup$cg/memory.max" "/sys/fs/cgroup$cg/memory.swap.max" "/sys/fs/cgroup$cg/pids.max"']);
  const expected = `${SCOPE_LIMITS.memoryMaxBytes}\n0\n${SCOPE_LIMITS.tasksMax}`;
  if (caps.error || caps.code !== 0 || caps.output.trim() !== expected) return scopeOff((caps.error?.message ?? caps.output.trim()) || `exit ${caps.code}`);
  const result = await host.run(systemdRun(), [...cappedScopeArgs(`gates-shell-probe-${randomUUID()}`), bwrap(), ...bwrapArgs([], ["/usr/bin/true"])], writtenFds(arch));
  if (!result.error && result.code === 0) return { available: true, arch, sqlite: host.exists(sqlite()) };
  const message = result.output.trim() || result.error?.message || `exit ${result.code}`;
  if (/operation not permitted|permission denied|creating new namespace|no permissions to create/i.test(message)) {
    return { available: false, word: "Can't create its sandbox", reason: "The shell tool cannot create its sandbox on this machine; it is off.", detail: message };
  }
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

/** The cgroup of the scope named `unit`, read from a process's /proc cgroup file; undefined when the process is in any other cgroup. */
export function cgroupOfScope(procCgroup: string, unit: string): string | undefined {
  const cgroup = procCgroup.split("\n").find(l => l.startsWith("0::"))?.slice(3);
  return cgroup?.endsWith(`/${unit}.scope`) ? cgroup : undefined;
}

function killCgroup(unit: string, pid: number): void {
  try {
    const cgroup = cgroupOfScope(readFileSync(`/proc/${pid}/cgroup`, "utf8"), unit);
    if (cgroup) writeFileSync(`/sys/fs/cgroup${cgroup}/cgroup.kill`, "1");
  } catch {
    // why: a scope that is already gone needs no kill.
    return;
  }
}

function killScope(pid: number | undefined, unit: string): void {
  if (pid === undefined) return;
  killCgroup(unit, pid);
  killGroup(pid);
}

/**
 * `beforeLaunch` and `launcher` are for tests only: the first runs after the source check and
 * the probe, just before launch, to race them deterministically; the second stands in for
 * systemd-run, to force a setup failure.
 */
export interface SandboxInput {
  command: string;
  sources: readonly LibraryEntry[];
  signal?: AbortSignal;
  timeoutMs?: number;
  outputCap?: number;
  beforeLaunch?: () => void;
  launcher?: string;
}

export async function runSandbox(input: SandboxInput): Promise<string> {
  input.signal?.throwIfAborted();
  for (const source of input.sources) if (!/^[\w-]+$/.test(source.id)) throw new Error("Invalid Library source id");
  const gone = checkSources(input.sources);
  if (gone) throw gone;
  const binds = input.sources.flatMap(source => ["--ro-bind", hostPathToBind(source), virtualPath(source)]);
  const probe = await probeSandbox();
  if (!probe.available) throw new Error(probe.reason);
  input.signal?.throwIfAborted();
  const args = bwrapArgs(binds, launch(input.command));
  const unit = `gates-shell-${randomUUID()}`;
  input.beforeLaunch?.();
  return new Promise((resolve, reject) => {
    const child = spawnScoped(input.launcher ?? systemdRun(),[...cappedScopeArgs(unit), bwrap(), ...args], writtenFds(probe.arch), 1);
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
