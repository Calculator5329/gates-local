// A smaller machine for one command: pinned to the first few cores, which can
// also be slowed, with a memory ceiling and no swap. Linux with a user systemd
// only, which is what the test machine has. Everything the command starts
// stays in the box.
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";

export interface Limit {
  readonly spec: string;
  readonly cores: number;
  /** Percent of the cores' time the box may use; null is all of it. */
  readonly speed: number | null;
  /** null measures memory without capping it. */
  readonly memoryMb: number | null;
}
export interface LimitReading {
  /** The most memory everything in the box held at once, page cache included. */
  readonly peakMb: number;
  /** Processes the kernel killed because the box hit its ceiling. */
  readonly oomKills: number;
  /** Processor time everything in the box used. */
  readonly cpuSeconds: number;
  /** Time the box sat stopped because a speed limit had run out. */
  readonly heldBackSeconds: number;
}

/**
 * `2c-2g`, `1c-512m`, or `2c` for a core limit that only measures memory. A
 * number after the `c` slows the cores: `1c50-2g` is one core at half speed.
 */
export function parseLimit(spec: string): Limit {
  const match = /^([1-9]\d*)c([1-9]\d?)?(?:-([1-9]\d*)([gm]))?$/.exec(spec);
  if (!match) throw new Error(`Unknown limit "${spec}". Use CORESc-MEMORYg or CORESc-MEMORYm, such as 2c-2g, CORESc alone, or a percent after the c to slow the cores, such as 1c50-2g`);
  const memory = match[3] === undefined ? null : Number(match[3]) * (match[4] === "g" ? 1024 : 1);
  return { spec, cores: Number(match[1]), speed: match[2] === undefined ? null : Number(match[2]), memoryMb: memory };
}

// Runs the command, passes a stop on to it, then writes what the box's own
// counters read. A trapped signal ends `wait` early, hence the loop. A kill
// for memory ends the whole box at once: the run is no longer a measurement,
// and what survives the kill can otherwise sit idle until a test times out.
const REPORT = `out=$1; shift
box=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)
counter() { awk -v name="$1" '$1 == name { print $2 }' "$box/$2"; }
report() { echo "$(cat "$box/memory.peak") $(counter oom_kill memory.events) $(counter usage_usec cpu.stat) $(counter throttled_usec cpu.stat)" > "$out"; }
"$@" & pid=$!
trap 'kill -TERM "$pid" 2>/dev/null' TERM INT
( while [ "$(counter oom_kill memory.events)" = 0 ]; do sleep 1; done; report; echo 1 > "$box/cgroup.kill" ) & watch=$!
wait "$pid"; code=$?
while kill -0 "$pid" 2>/dev/null; do wait "$pid"; code=$?; done
kill "$watch" 2>/dev/null
report
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
  // The time is handed out every 5 ms, so a slowed box stalls for a few
  // milliseconds at a time, not for most of a tenth of a second. It is a share
  // of all the cores together: one busy thread in a two-core box at 50 runs
  // unslowed, and only one core at a percent slows everything by that much.
  const speed = limit.speed === null ? [] : ["-p", `CPUQuota=${limit.cores * limit.speed}%`, "-p", "CPUQuotaPeriodSec=5ms"];
  // OOMPolicy=continue keeps the wrapper alive after a kill so it can still report.
  return ["taskset", "-c", `0-${limit.cores - 1}`, "systemd-run", "--user", "--scope", "--quiet", "--collect",
    "-p", "MemoryAccounting=yes", "-p", "OOMPolicy=continue", ...memory, ...speed, "--", "sh", "-c", REPORT, "sh", reportFile, ...args];
}

/** systemd-run finds the user bus through XDG_RUNTIME_DIR; a runner shell may lack it. */
export function limitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, XDG_RUNTIME_DIR: env["XDG_RUNTIME_DIR"] ?? `/run/user/${process.getuid?.() ?? 0}` };
}

export function readLimit(reportFile: string): LimitReading {
  // The held-back counter exists only in a box with a speed limit.
  const [peak, kills, used, heldBack = 0] = readFileSync(reportFile, "utf8").trim().split(" ").map(Number);
  if (peak === undefined || kills === undefined || used === undefined || ![peak, kills, used, heldBack].every(Number.isFinite)) throw new Error(`Unreadable limit report ${reportFile}`);
  // The counters are in microseconds; a tenth of a second is plenty.
  return { peakMb: Math.round(peak / 1024 / 1024), oomKills: kills, cpuSeconds: Math.round(used / 100_000) / 10, heldBackSeconds: Math.round(heldBack / 100_000) / 10 };
}
