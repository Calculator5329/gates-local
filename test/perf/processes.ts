import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { groupAlive, processAlive } from "../../apps/server/src/process-state.ts";

/** Own only children started here; keep detached groups until every member stops. */
export function ownProcesses(signal: AbortSignal) {
  const children = new Map<ChildProcess, { grouped: boolean; exited: Promise<void>; stopping?: Promise<void> }>();
  let closed = signal.aborted;
  function stop(child: ChildProcess): Promise<void> {
    const owned = children.get(child);
    if (!owned) return Promise.resolve();
    return owned.stopping ??= (async () => {
      const alive = () => child.pid !== undefined && (owned.grouped ? groupAlive(child.pid) : processAlive(child.pid));
      const kill = (termination: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try { if (owned.grouped) process.kill(-child.pid, termination); else child.kill(termination); }
        catch (error) { if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ESRCH") throw error; }
      };
      const goneWithin = async (ms: number) => {
        const deadline = Date.now() + ms;
        while (alive()) {
          if (Date.now() >= deadline) return false;
          await setTimeout(20);
        }
        return true;
      };
      if (alive()) kill("SIGTERM");
      // Finish escalation before the release supervisor's two-second grace ends.
      if (!await goneWithin(300)) kill("SIGKILL");
      if (!await goneWithin(750)) throw new Error(`Owned performance process ${child.pid} could not be confirmed stopped`);
      await owned.exited;
      children.delete(child);
    })();
  }
  const stopAll = () => Promise.all([...children.keys()].map(stop));
  const onAbort = () => {
    closed = true;
    void stopAll().catch(error => console.error("Performance process cleanup failed:", error));
  };
  if (!signal.aborted) signal.addEventListener("abort", onAbort, { once: true });
  return {
    spawn(file: string, args: readonly string[], options: SpawnOptions): ChildProcess {
      signal.throwIfAborted();
      if (closed) throw new Error("Performance process owner is closed");
      const grouped = options.detached === true && process.platform !== "win32";
      const child = spawn(file, [...args], { ...options, detached: grouped });
      const exited = new Promise<void>(resolve => { child.once("exit", () => resolve()); child.once("error", () => resolve()); });
      children.set(child, { grouped, exited });
      // Abort can occur in a spawn hook before the returned child is registered.
      if (signal.aborted) onAbort();
      signal.throwIfAborted();
      return child;
    },
    stop,
    async close() {
      closed = true;
      signal.removeEventListener("abort", onAbort);
      await stopAll();
    },
  };
}
