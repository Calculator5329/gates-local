// Waiting for the app to close before the detached updater touches the
// checkout. process.kill(pid, 0) sends nothing: it only asks whether the
// process exists, on Linux and Windows alike.

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface WaitOptions {
  readonly timeoutMs: number;
  readonly pollMs?: number;
  readonly alive?: (pid: number) => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/** Resolves true once pid has exited, false when it is still running at the time limit. */
export async function waitForExit(pid: number, o: WaitOptions): Promise<boolean> {
  const alive = o.alive ?? isAlive;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = o.now ?? Date.now;
  const until = now() + o.timeoutMs;
  for (;;) {
    if (!alive(pid)) return true;
    if (now() >= until) return false;
    await sleep(o.pollMs ?? 200);
  }
}
