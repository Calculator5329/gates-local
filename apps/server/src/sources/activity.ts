import type { UpdateAdmission } from "../update/admission.ts";
import type { Sources } from "./index.ts";

/** Track full import lifetimes, including worker exit and cleanup, rather than RPC acknowledgements. */
export function createImportActivity(admission: UpdateAdmission) {
  let closed = false;
  const pending = new Map<symbol, { label: string; controller: AbortController; finished: Promise<void> }>();
  // begin is synchronous so job-returning import APIs can refuse before
  // allocating anything. finish belongs in their worker/cleanup finally.
  const begin = (label: string) => {
    if (closed) throw new Error("Imports are shutting down.");
    admission.admit();
    const key = Symbol(label);
    const controller = new AbortController();
    let complete: () => void;
    const finished = new Promise<void>(resolve => { complete = resolve; });
    pending.set(key, { label, controller, finished });
    return { signal: controller.signal, finish: () => { pending.delete(key); complete(); } };
  };
  return {
    begin,
    async run<T>(label: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      const scope = begin(label);
      try { return await task(scope.signal); }
      finally { scope.finish(); }
    },
    activity: (): readonly string[] => [...pending.values()].map(value => value.label),
    close: async () => {
      closed = true;
      const jobs = [...pending.values()];
      for (const { controller } of jobs) controller.abort(new Error("Import interrupted while Gates Local is closing."));
      await Promise.allSettled(jobs.map(job => job.finished));
    },
  };
}

export type ImportActivity = ReturnType<typeof createImportActivity>;

export function withImportAdmission(sources: Sources, imports: ReturnType<typeof createImportActivity>): Sources {
  return {
    ...sources,
    add: input => imports.run(`Import: ${input.label ?? input.path}`, signal => sources.add(input, signal)),
    refresh: id => imports.run(`Import refresh: ${sources.list().find(source => source.id === id)?.label ?? id}`, signal => sources.refresh(id, signal)),
  };
}
