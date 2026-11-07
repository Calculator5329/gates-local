export type GpuJobKind = "chat" | "image" | "bench" | "dream";
export interface GpuLease {
  acquire(kind: GpuJobKind, signal?: AbortSignal): Promise<() => void>;
  run<T>(kind: GpuJobKind, signal: AbortSignal | undefined, job: () => Promise<T>): Promise<T>;
  /** holder: the kind holding the GPU (null when free); holders: how many claims hold it. */
  status(): { holder: GpuJobKind | null; holders: number; waiting: GpuJobKind[] };
}

/**
 * Chat claims share the GPU with each other: two turns, a turn and a
 * preload, or two loads hold it at once (the loader's own gate orders their
 * fits). Every other kind holds it alone: an image job unloads the app's
 * chat models and loads its weights, so no turn may stream beside it.
 */
export const isSharedKind = (kind: GpuJobKind): boolean => kind === "chat";

/** Process-local FIFO. Use run() (or finally release()) so errors cannot strand a claim.
 * A waiting exclusive claim blocks every claim behind it, shared or not, so a
 * stream of chat turns cannot starve an image job.
 * Aborting a holder does NOT release it: its GPU cleanup must finish first.
 * Never acquire while holding a claim: a nested shared claim behind a waiting
 * exclusive one never gets the GPU.
 * A process crash discards the queue with the process; this is not a cross-app lock.
 */
export function createGpuLease(): GpuLease {
  type Waiter = { kind: GpuJobKind; grant: () => void };
  const queue: Waiter[] = [];
  let holder: GpuJobKind | null = null;
  let holders = 0;
  const fits = (kind: GpuJobKind) => holders === 0 || (isSharedKind(kind) && holder !== null && isSharedKind(holder));
  // Grant from the head while the head fits; stop at the first that does not.
  const drain = () => {
    while (queue.length > 0 && fits(queue[0]!.kind)) queue.shift()!.grant();
  };
  const acquire: GpuLease["acquire"] = (kind, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const abort = () => {
      const index = queue.indexOf(waiter);
      if (index >= 0) queue.splice(index, 1);
      reject(signal?.reason);
      // An exclusive waiter at the head may have been holding shared ones back.
      drain();
    };
    const waiter: Waiter = { kind, grant() {
      signal?.removeEventListener("abort", abort);
      holder = kind;
      holders += 1;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        holders -= 1;
        if (holders === 0) holder = null;
        drain();
      });
    } };
    if (queue.length === 0 && fits(kind)) waiter.grant();
    else { queue.push(waiter); signal?.addEventListener("abort", abort, { once: true }); }
  });
  return {
    acquire,
    async run(kind, signal, job) {
      const release = await acquire(kind, signal);
      try { signal?.throwIfAborted(); return await job(); }
      finally { release(); }
    },
    status: () => ({ holder, holders, waiting: queue.map((w) => w.kind) }),
  };
}
