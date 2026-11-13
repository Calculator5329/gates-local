// A saved row's times, as the server stamped them when its turn ended (chat row 32): every
// window and every reload draws the same "Thought for", first-token time, thinking rounds and
// stop note from the row, and no window keeps its own.
import type { CatalogEntry, Message, ReplyTimes } from "@gates-local/contracts";
import { describeModel } from "../format.ts";
import type { StopNote } from "../store.ts";
import type { WorkClock } from "./turn.ts";

/** What a saved row draws from its times; each part undefined when the row has none. */
export interface Drawn {
  /** From the send to the first answer word, for the meta line. */
  readonly firstTokenMs: number | undefined;
  /** The "Thought for" seconds. */
  readonly thoughtSecs: number | undefined;
  /** The thinking rounds and where each call came, for the fold. */
  readonly clock: WorkClock | undefined;
  /** Stop's seconds on a reply's square, or a reason in words under the row. */
  readonly note: StopNote | undefined;
}

const NONE: Drawn = { firstTokenMs: undefined, thoughtSecs: undefined, clock: undefined, note: undefined };
/** Drawn once per row's times and catalog, so a memoized row gets the same props back. */
const drawn = new WeakMap<ReplyTimes, { readonly catalog: readonly CatalogEntry[] | undefined; readonly out: Drawn }>();

/** One plain sentence for a reply the server stopped to make way for something else. */
export function stopReason(why: { readonly code: string; readonly neededBy?: string | undefined }, catalog: readonly CatalogEntry[] | undefined): string | undefined {
  if (why.code === "runtime-changed") return "Stopped when the Ollama runtime changed.";
  if (why.code !== "preempted") return undefined;
  const by = why.neededBy === undefined ? "another model" : describeModel(why.neededBy, catalog).name;
  return `Stopped so ${by} could load.`;
}

/** The server's error text as a following sentence of a note; nothing when it has none. */
export function asSentence(text: string): string {
  const t = text.trim();
  if (t === "") return "";
  const sentence = t.charAt(0).toUpperCase() + t.slice(1);
  return ` ${/[.!?]$/.test(sentence) ? sentence : `${sentence}.`}`;
}

/**
 * Why the row's turn ended, as a note: a reply the person stopped carries Stop's seconds; one
 * the server halted or that failed says why in words. A question carries a note only when its
 * turn saved no reply and did not end by Stop, and says no error text: there is no reply for it.
 */
function noteOf(role: Message["role"], t: ReplyTimes, catalog: readonly CatalogEntry[] | undefined): StopNote | undefined {
  const { reason, at } = t.ended;
  if (reason === "done") return undefined;
  if (reason === "stopped") return role === "assistant" ? { kind: "stopped", secs: Math.round((at - t.startedAt) / 1000) } : undefined;
  const said = t.why === undefined ? undefined : stopReason(t.why, catalog);
  if (said !== undefined) return { kind: "said", words: said };
  return { kind: "said", words: `The reply didn't finish.${role === "assistant" ? asSentence(t.why?.message ?? "") : ""}` };
}

/** The row's times for drawing; the same object for the same times while the catalog holds still. */
export function drawTimes(msg: Message, catalog: readonly CatalogEntry[] | undefined): Drawn {
  const t = msg.times;
  if (t === undefined) return NONE;
  const kept = drawn.get(t);
  if (kept !== undefined && kept.catalog === catalog) return kept.out;
  const firstTokenMs = t.firstTokenAt === undefined ? undefined : t.firstTokenAt - t.startedAt;
  const out: Drawn = {
    firstTokenMs,
    // a reply that thought: from the model being ready to its first answer word or its end;
    // one that only called tools: from the send to its first word, as before
    thoughtSecs: t.thoughtMs !== undefined ? Math.max(1, Math.round(t.thoughtMs / 1000)) : firstTokenMs === undefined ? undefined : Math.max(1, Math.round(firstTokenMs / 1000)),
    clock: t.spans.length === 0 && Object.keys(t.callsAt).length === 0 ? undefined
      : { thinking: false, since: t.ended.at, from: 0, total: t.spans.reduce((n, s) => n + s.ms, 0), spans: t.spans, at: t.callsAt },
    note: noteOf(msg.role, t, catalog),
  };
  drawn.set(t, { catalog, out });
  return out;
}
