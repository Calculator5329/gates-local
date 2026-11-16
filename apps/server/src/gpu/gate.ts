
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
