// A smaller machine for one command: pinned to the first few cores, with a
// memory ceiling and no swap. Linux with a user systemd only, which is what
// the test machine has. Everything the command starts stays in the box.
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";

export interface Limit {
  readonly spec: string;
  readonly cores: number;
  /** null measures memory without capping it. */
  readonly memoryMb: number | null;
}
export interface LimitReading {
  /** The most memory everything in the box held at once, page cache included. */
  readonly peakMb: number;
  /** Processes the kernel killed because the box hit its ceiling. */
  readonly oomKills: number;
}

/** `2c-2g`, `1c-512m`, or `2c` for a core limit that only measures memory. */
export function parseLimit(spec: string): Limit {
  const match = /^([1-9]\d*)c(?:-([1-9]\d*)([gm]))?$/.exec(spec);
  if (!match) throw new Error(`Unknown limit "${spec}". Use CORESc-MEMORYg or CORESc-MEMORYm, such as 2c-2g, or CORESc alone`);
  const memory = match[2] === undefined ? null : Number(match[2]) * (match[3] === "g" ? 1024 : 1);
  return { spec, cores: Number(match[1]), memoryMb: memory };
}

// Runs the command, passes a stop on to it, then writes what the box's own
// memory counters read. A trapped signal ends `wait` early, hence the loop.
const REPORT = `out=$1; shift
"$@" & pid=$!
trap 'kill -TERM "$pid" 2>/dev/null' TERM INT
wait "$pid"; code=$?
while kill -0 "$pid" 2>/dev/null; do wait "$pid"; code=$?; done
box=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)
echo "$(cat "$box/memory.peak") $(awk '$1 == "oom_kill" { print $2 }' "$box/memory.events")" > "$out"
exit "$code"`;

/**
 * The command line that runs `args` inside the limit and leaves a reading in
 * `reportFile` for `readLimit`. Refuses a core count this machine cannot go
 * under, so a limit that limits nothing is never recorded as one.
 */
export function limited(limit: Limit, args: readonly string[], reportFile: string, machineCores = availableParallelism()): string[] {
  if (process.platform !== "linux") throw new Error("A limit needs Linux with a user systemd");
  if (limit.cores >= machineCores) throw new Error(`Limit ${limit.spec} asks for ${limit.cores} cores; this machine has ${machineCores}, so nothing would be limited`);
  const memory = limit.memoryMb === null ? [] : ["-p", `MemoryMax=${limit.memoryMb}M`, "-p", "MemorySwapMax=0"];
  // OOMPolicy=continue keeps the wrapper alive after a kill so it can still report.
  return ["taskset", "-c", `0-${limit.cores - 1}`, "systemd-run", "--user", "--scope", "--quiet", "--collect",
    "-p", "MemoryAccounting=yes", "-p", "OOMPolicy=continue", ...memory, "--", "sh", "-c", REPORT, "sh", reportFile, ...args];
}

/** systemd-run finds the user bus through XDG_RUNTIME_DIR; a runner shell may lack it. */
export function limitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, XDG_RUNTIME_DIR: env["XDG_RUNTIME_DIR"] ?? `/run/user/${process.getuid?.() ?? 0}` };
}

export function readLimit(reportFile: string): LimitReading {
  const [peak, kills] = readFileSync(reportFile, "utf8").trim().split(" ").map(Number);
  if (peak === undefined || kills === undefined || !Number.isFinite(peak) || !Number.isFinite(kills)) throw new Error(`Unreadable limit report ${reportFile}`);
  return { peakMb: Math.round(peak / 1024 / 1024), oomKills: kills };
}
