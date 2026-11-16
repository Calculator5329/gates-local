import { AsyncLocalStorage } from "node:async_hooks";

interface Recorder {
  readonly t0: number;
  readonly marks: string[];
  printed: boolean;
}

const store = new AsyncLocalStorage<Recorder>();

const enabled = (): boolean => process.env["GATES_LOCAL_SEND_TIMES"] === "1";
const since = (r: Recorder): number => Math.round(performance.now() - r.t0);

export function withSendTimes<T>(work: () => T): T {
  if (!enabled()) return work();
  return store.run({ t0: performance.now(), marks: [], printed: false }, work);
}

export function sendMark(name: string): void {
  const r = store.getStore();
  if (r !== undefined && !r.printed) r.marks.push(`${name} ${since(r)}`);
}

export async function sendSpan<T>(name: string, work: () => Promise<T>): Promise<T> {
  const r = store.getStore();
  if (r === undefined || r.printed) return work();
  const start = since(r);
  try {
    return await work();
  } finally {
    if (!r.printed) r.marks.push(`${name} ${start}-${since(r)}`);
  }
}

export function sendTimesLine(turnId: string): string | undefined {
  const r = store.getStore();
  if (r === undefined || r.printed) return undefined;
  r.printed = true;
  return `send ${turnId} first token ${since(r)} ms: ${[...r.marks, `first-token ${since(r)}`].join(", ")}`;
}
