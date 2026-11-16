export type GpuJobKind = "chat" | "image" | "bench" | "dream";
export interface GpuLease {
  // why: a claim taken while holding one can wait for ever behind an exclusive waiter
  acquire(kind: GpuJobKind, signal?: AbortSignal): Promise<() => void>;
  run<T>(kind: GpuJobKind, signal: AbortSignal | undefined, job: () => Promise<T>): Promise<T>;
  status(): { holder: GpuJobKind | null; holders: number; waiting: GpuJobKind[] };
}

// why: an image job unloads the chat models and loads its own weights, so nothing streams beside it
export const isSharedKind = (kind: GpuJobKind): boolean => kind === "chat";

export interface GpuLeaseOptions {
  readonly faultForTest?: "shared-claims-jump-the-queue";
}

export function createGpuLease(options: GpuLeaseOptions = {}): GpuLease {
  type Waiter = { kind: GpuJobKind; grant: () => void };
  const queue: Waiter[] = [];
  let holder: GpuJobKind | null = null;
  let holders = 0;
  const fits = (kind: GpuJobKind) => holders === 0 || (isSharedKind(kind) && holder !== null && isSharedKind(holder));
  const drain = () => {
    while (queue.length > 0 && fits(queue[0]!.kind)) queue.shift()!.grant();
  };
  const acquire: GpuLease["acquire"] = (kind, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const abort = () => {
      const index = queue.indexOf(waiter);
      if (index >= 0) queue.splice(index, 1);
      reject(signal?.reason);
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
    const behind = queue.length > 0 && !(options.faultForTest === "shared-claims-jump-the-queue" && isSharedKind(kind));
    if (!behind && fits(kind)) waiter.grant();
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
