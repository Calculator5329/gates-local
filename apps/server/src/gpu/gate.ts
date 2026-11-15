// The load gate: the memory owner holds one (gpu/memory.ts), and a loader
// without a memory owner makes its own (runtime/load.ts).

/**
 * Runs `fn` with the load gate held; the gate is released when `fn` settles.
 * An in-process FIFO mutex: it orders residency reads, fits and loads among
 * the chat claims that share the GPU lease (gpu/lease.ts). A turn's admit
 * runs inside the turn's own lease claim; load() takes its own claim.
 */
export type LoadGate = <T>(fn: () => Promise<T>) => Promise<T>;

export function createFifoGate(): LoadGate {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
