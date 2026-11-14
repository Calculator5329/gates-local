// Where a send's time goes before the model's first token. Off unless GATES_LOCAL_SEND_TIMES=1:
// then each send carries one recorder through its awaits (AsyncLocalStorage), the reads on its
// way (GPU, memory, Ollama) stamp it, and the first token prints one line to the server log:
//   send <turn> first token 1840 ms: gpu-read 12-31, ps 33-35, ..., model-request 120, first-token 1840
// Each mark is milliseconds since the request came in; a span is its start and end.
import { AsyncLocalStorage } from "node:async_hooks";

interface Recorder {
  readonly t0: number;
  readonly marks: string[];
  printed: boolean;
}

const store = new AsyncLocalStorage<Recorder>();

const enabled = (): boolean => process.env["GATES_LOCAL_SEND_TIMES"] === "1";
const since = (r: Recorder): number => Math.round(performance.now() - r.t0);

/** Runs `work` with a fresh recorder when send times are on; as it is otherwise. */
export function withSendTimes<T>(work: () => T): T {
  if (!enabled()) return work();
  return store.run({ t0: performance.now(), marks: [], printed: false }, work);
}

/** One point in the current send, if one is being timed. */
export function sendMark(name: string): void {
  const r = store.getStore();
  if (r !== undefined && !r.printed) r.marks.push(`${name} ${since(r)}`);
}

/** `work`'s start and end in the current send, if one is being timed. */
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

/** At the first token: the send's line, once. */
export function sendTimesLine(turnId: string): string | undefined {
  const r = store.getStore();
  if (r === undefined || r.printed) return undefined;
  r.printed = true;
  return `send ${turnId} first token ${since(r)} ms: ${[...r.marks, `first-token ${since(r)}`].join(", ")}`;
}
