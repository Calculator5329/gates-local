import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import type { LibraryEntry } from "../types.ts";

const BWRAP = "/usr/bin/bwrap";
const baseArgs = () => [
  "--die-with-parent", "--new-session", "--unshare-all", "--cap-drop", "ALL",
  "--tmpfs", "/", "--ro-bind", "/usr", "/usr",
  "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib",
  ...(existsSync("/usr/lib64") ? ["--symlink", "usr/lib64", "/lib64"] : []),
  "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
  "--tmpfs", "/data", "--tmpfs", "/library", "--clearenv",
  "--setenv", "PATH", "/usr/bin", "--setenv", "HOME", "/home/absent", "--setenv", "LC_ALL", "C",
  "--chdir", "/library",
];
let probed: { available: boolean; reason?: string } | undefined;

/** One probe per process. Only namespace/permission failures are skippable; broken mounts are not. */
export function probeSandbox(): { available: boolean; reason?: string } {
  if (probed) return probed;
  if (process.platform !== "linux") return probed = { available: false, reason: "bwrap is Linux-only" };
  if (!existsSync(BWRAP)) return probed = { available: false, reason: "/usr/bin/bwrap is not installed" };
  const result = spawnSync(BWRAP, [...baseArgs(), "--", "/usr/bin/true"], { encoding: "utf8", timeout: 5000 });
  if (!result.error && result.status === 0) return probed = { available: true };
  const message = result.stderr?.trim() || result.error?.message || `exit ${result.status}`;
  if (/operation not permitted|permission denied|creating new namespace|no permissions to create/i.test(message)) return probed = { available: false, reason: `bwrap cannot create a namespace: ${message}` };
  throw new Error(`bwrap probe failed: ${message}`);
}

export async function runSandbox(input: { command: string; sources: readonly LibraryEntry[]; signal?: AbortSignal; timeoutMs?: number; outputCap?: number }): Promise<string> {
  input.signal?.throwIfAborted();
  const probe = probeSandbox();
  if (!probe.available) throw new Error(`Shell sandbox unavailable: ${probe.reason}`);
  const args = baseArgs();
  for (const source of input.sources) {
    if (!/^[\w-]+$/.test(source.id)) throw new Error("Invalid Library source id");
    const host = realpathSync(source.kind === "sqlite" ? requiredSnapshot(source) : source.path);
    if (host !== (source.kind === "sqlite" ? source.snapshotPath : source.path)) throw new Error("Library source path changed; reconnect this source before using it");
    args.push("--ro-bind", host, source.kind === "sqlite" ? `/data/${source.id}.db` : `/library/${source.id}`);
  }
  // Source mounts precede the final read-only remount so no writable carve-out can cover them.
  args.push("--remount-ro", "/data", "--remount-ro", "/library", "--", "/usr/bin/bash", "--noprofile", "--norc", "-c", input.command);
  return new Promise((resolve, reject) => {
    const child = spawn(BWRAP, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const stop = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
    const timer = setTimeout(() => stop(new Error("Shell exceeded its time limit")), Math.min(30000, Math.max(1, input.timeoutMs ?? 10000)));
    const abort = () => stop(new Error("Shell cancelled"));
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (input.outputCap ?? 100000)) stop(new Error("Shell exceeded its output limit"));
      else chunks.push(chunk);
    };
    child.stdout.on("data", data); child.stderr.on("data", data);
    const cleanup = () => { clearTimeout(timer); input.signal?.removeEventListener("abort", abort); };
    child.on("error", e => { cleanup(); reject(e); });
    child.on("close", code => {
      cleanup();
      const output = Buffer.concat(chunks).toString("utf8");
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Shell exited ${code}: ${output}`));
      else resolve(output);
    });
  });
}

function requiredSnapshot(source: LibraryEntry): string {
  if (!source.snapshotPath) throw new Error("SQLite source has no snapshot");
  return source.snapshotPath;
}
