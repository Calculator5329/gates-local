export type GpuJobKind = "chat" | "image" | "bench" | "dream";
export interface GpuLease {
  acquire(kind: GpuJobKind, signal?: AbortSignal): Promise<() => void>;
  run<T>(kind: GpuJobKind, signal: AbortSignal | undefined, job: () => Promise<T>): Promise<T>;
  status(): { holder: GpuJobKind | null; waiting: GpuJobKind[] };
}
/** Process-local FIFO. Use run() (or finally release()) so errors cannot strand a claim.
 * Aborting a holder does NOT release it: its GPU cleanup must finish first.
 * A process crash discards the queue with the process; this is not a cross-app lock.
 */
export function createGpuLease(): GpuLease {
  type Waiter = { kind: GpuJobKind; grant: () => void };
  const queue: Waiter[] = [];
  let holder: GpuJobKind | null = null;
  const acquire: GpuLease["acquire"] = (kind, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const abort = () => {
      const index = queue.indexOf(waiter);
      if (index >= 0) queue.splice(index, 1);
      reject(signal?.reason);
    };
    const waiter: Waiter = { kind, grant() {
      signal?.removeEventListener("abort", abort);
      holder = kind;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        holder = null;
        queue.shift()?.grant();
      });
    } };
    if (holder === null) waiter.grant();
    else { queue.push(waiter); signal?.addEventListener("abort", abort, { once: true }); }
  });
  return {
    acquire,
    async run(kind, signal, job) {
      const release = await acquire(kind, signal);
      try { signal?.throwIfAborted(); return await job(); }
      finally { release(); }
    },
    status: () => ({ holder, waiting: queue.map((w) => w.kind) }),
  };
}
