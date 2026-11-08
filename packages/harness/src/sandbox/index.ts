import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Writable } from "node:stream";
import { canonicalPathSync, sourceUnavailable } from "../paths.ts";
import type { LibraryEntry } from "../types.ts";
import { isSeccompArch, lockFilter, type SeccompArch } from "./seccomp.ts";

const BWRAP = "/usr/bin/bwrap";
const SYSTEMD_RUN = "/usr/bin/systemd-run";
/** Every tmpfs is 64 MiB; together with /dev they are charged to the scope's memory cap. */
const TMPFS_BYTES = String(64 * 1024 * 1024);
export const SCOPE_LIMITS = { memoryMaxBytes: 512 * 1024 * 1024, tasksMax: 64 } as const;
export const SCOPE_OFF = "The shell tool needs a user systemd session to cap its memory; it is off on this machine.";
export const ARCH_OFF = "The shell tool's lock filter covers x86_64 and aarch64 only; it is off on this machine.";

/** The capped scope bwrap runs in; an OOM inside it kills only the sandbox. */
const scopeArgs = (unit: string) => [
  "--user", "--scope", "--quiet", "--collect", `--unit=${unit}`,
  "-p", "MemoryMax=512M", "-p", "MemorySwapMax=0", "-p", `TasksMax=${SCOPE_LIMITS.tasksMax}`, "--",
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

export type SandboxProbe = { available: true; arch: SeccompArch } | { available: false; reason: string; detail?: string };
export interface SandboxHost {
  platform: NodeJS.Platform;
  arch: string;
  exists: (file: string) => boolean;
  /** `fds` become fds 3, 4, ... in the child: written and closed before bwrap reads them. */
  run: (command: string, args: readonly string[], fds?: readonly Buffer[]) => Promise<{ code: number | null; output: string; error?: Error }>;
}

function spawnScoped(command: string, args: readonly string[], fds: readonly Buffer[]) {
  // bwrap --clearenv empties the sandbox's environment; this env only reaches systemd-run.
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe", ...fds.map(() => "pipe" as const)], detached: true, env: scopeEnv() });
  fds.forEach((data, i) => (child.stdio[3 + i] as Writable).on("error", () => undefined).end(data));
  return child;
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

/** Checks, in order: Linux, a filter for this arch, bwrap, a working capped user scope, a working sandbox. */
export async function probeSandboxWith(host: SandboxHost): Promise<SandboxProbe> {
  if (host.platform !== "linux") return { available: false, reason: "The shell tool runs only on Linux." };
  if (!isSeccompArch(host.arch)) return { available: false, reason: ARCH_OFF };
  const arch = host.arch;
  if (!host.exists(BWRAP)) return { available: false, reason: "The shell tool needs bubblewrap (/usr/bin/bwrap); it is off on this machine." };
  if (!host.exists(SYSTEMD_RUN)) return { available: false, reason: SCOPE_OFF, detail: `${SYSTEMD_RUN} is missing` };
  // The scope must exist and carry the caps, read back from its own cgroup files.
  const caps = await host.run(SYSTEMD_RUN, [...scopeArgs(`gates-shell-probe-${randomUUID()}`), "/usr/bin/sh", "-c",
    'cg=$(cut -d: -f3 /proc/self/cgroup); cat "/sys/fs/cgroup$cg/memory.max" "/sys/fs/cgroup$cg/memory.swap.max" "/sys/fs/cgroup$cg/pids.max"']);
  const expected = `${SCOPE_LIMITS.memoryMaxBytes}\n0\n${SCOPE_LIMITS.tasksMax}`;
  if (caps.error || caps.code !== 0 || caps.output.trim() !== expected) {
    return { available: false, reason: SCOPE_OFF, detail: (caps.error?.message ?? caps.output.trim()) || `exit ${caps.code}` };
  }
  const result = await host.run(SYSTEMD_RUN, [...scopeArgs(`gates-shell-probe-${randomUUID()}`), BWRAP, ...baseArgs(), ...finalMounts, "--", "/usr/bin/true"], sandboxFds(arch));
  if (!result.error && result.code === 0) return { available: true, arch };
  const message = result.output.trim() || result.error?.message || `exit ${result.code}`;
  if (/operation not permitted|permission denied|creating new namespace|no permissions to create/i.test(message)) {
    return { available: false, reason: "The shell tool cannot create its sandbox on this machine; it is off.", detail: message };
  }
  // A broken mount or filter is a bug, never a quiet skip.
  throw new Error(`bwrap probe failed: ${message}`);
}

let probing: Promise<SandboxProbe> | undefined;
/** One async probe per process, run at first use. */
export function probeSandbox(): Promise<SandboxProbe> {
  return probing ??= probeSandboxWith(realHost);
}

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

export async function runSandbox(input: { command: string; sources: readonly LibraryEntry[]; signal?: AbortSignal; timeoutMs?: number; outputCap?: number }): Promise<string> {
  input.signal?.throwIfAborted();
  // Sources first: one removed since the turn began is named, never shown as a host path.
  const binds: string[] = [];
  for (const source of input.sources) {
    if (!/^[\w-]+$/.test(source.id)) throw new Error("Invalid Library source id");
    const expected = source.kind === "sqlite" ? requiredSnapshot(source) : source.path;
    let host: string;
    try { host = canonicalPathSync(expected); } catch (e) { throw sourceUnavailable(source, e); }
    if (host !== expected) throw new Error("Library source path changed; reconnect this source before using it");
    binds.push("--ro-bind", host, source.kind === "sqlite" ? `/data/${source.id}.db` : `/library/${source.id}`);
  }
  const probe = await probeSandbox();
  if (!probe.available) throw new Error(probe.reason);
  input.signal?.throwIfAborted();
  const args = [...baseArgs(), ...binds, ...finalMounts, "--", "/usr/bin/bash", "--noprofile", "--norc", "-c", input.command];
  // A snapshot removed after the check above makes bwrap's bind fail with the host path in its message.
  const removed = () => input.sources.find(s => s.kind === "sqlite" && !existsSync(s.snapshotPath!));
  const unit = `gates-shell-${randomUUID()}`;
  return new Promise((resolve, reject) => {
    const child = spawnScoped(SYSTEMD_RUN, [...scopeArgs(unit), BWRAP, ...args], sandboxFds(probe.arch));
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
    child.on("error", e => { cleanup(); reject(e); });
    child.on("close", (code, signal) => {
      cleanup();
      const output = Buffer.concat(chunks).toString("utf8");
      const gone = !failure && (code !== 0 || signal) ? removed() : undefined;
      if (failure) reject(failure);
      else if (gone) reject(sourceUnavailable(gone, Object.assign(new Error("snapshot removed"), { code: "ENOENT" })));
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
