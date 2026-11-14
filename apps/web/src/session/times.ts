// A saved row's times, as the server stamped them when its turn ended (chat row 32): every
// window and every reload draws the same work seconds, thinking rounds and stop note from the
// row, and no window keeps its own.
import type { CatalogEntry, Message, ReplyTimes } from "@gates-local/contracts";
import { describeModel } from "../format.ts";
import type { StopNote } from "../store.ts";

/** The thinking rounds and where each call came in the thinking, for the open fold. */
export interface Rounds {
  readonly spans: ReplyTimes["spans"];
  readonly callsAt: ReplyTimes["callsAt"];
}

/** What a saved row draws from its times; each part undefined when the row has none. */
export interface Drawn {
  /** The work seconds (decision 2): thinking plus tool time, never the load or the writing. */
  readonly workMs: number | undefined;
  readonly rounds: Rounds | undefined;
  /** Stop's seconds on a reply's square, or a reason in words under the row. */
  readonly note: StopNote | undefined;
}

const NONE: Drawn = { workMs: undefined, rounds: undefined, note: undefined };
/** Drawn once per row's times and catalog, so a memoized row gets the same props back. */
const drawn = new WeakMap<ReplyTimes, { readonly catalog: readonly CatalogEntry[] | undefined; readonly out: Drawn }>();

/** One plain sentence for a reply the server stopped to make way for something else. */
export function stopReason(why: { readonly code: string; readonly neededBy?: string | undefined }, catalog: readonly CatalogEntry[] | undefined): string | undefined {
  if (why.code === "runtime-changed") return "Stopped when the Ollama runtime changed.";
  if (why.code !== "preempted") return undefined;
  const by = why.neededBy === undefined ? "another model" : describeModel(why.neededBy, catalog).name;
  return `Stopped so ${by} could load.`;
}

/**
 * Why the row's turn ended, as a note: a reply the person stopped carries Stop's seconds; one
 * the server halted says why in words; one that failed (after the server's second try, decision
 * 7) is a failure, with the runtime's own text for the tip. A question carries a note only when
 * its turn saved no reply and did not end by Stop.
 */
function noteOf(role: Message["role"], t: ReplyTimes, catalog: readonly CatalogEntry[] | undefined): StopNote | undefined {
  const { reason, at } = t.ended;
  if (reason === "done") return undefined;
  if (reason === "stopped") return role === "assistant" ? { kind: "stopped", secs: Math.round((at - t.startedAt) / 1000) } : undefined;
  const said = t.why === undefined ? undefined : stopReason(t.why, catalog);
  if (said !== undefined) return { kind: "said", words: said };
  return { kind: "failed", why: t.why?.message ?? "" };
}

/** Work milliseconds of a row saved before the server kept them: its thought, or the wait for its first word. */
function oldWorkMs(t: ReplyTimes): number | undefined {
  return t.thoughtMs ?? (t.firstTokenAt === undefined ? undefined : t.firstTokenAt - t.startedAt);
}

/** The row's times for drawing; the same object for the same times while the catalog holds still. */
export function drawTimes(msg: Message, catalog: readonly CatalogEntry[] | undefined): Drawn {
  const t = msg.times;
  if (t === undefined) return NONE;
  const kept = drawn.get(t);
  if (kept !== undefined && kept.catalog === catalog) return kept.out;
  const out: Drawn = {
    workMs: t.workMs ?? oldWorkMs(t),
    rounds: t.spans.length === 0 && Object.keys(t.callsAt).length === 0 ? undefined : { spans: t.spans, callsAt: t.callsAt },
    note: noteOf(msg.role, t, catalog),
  };
  drawn.set(t, { catalog, out });
  return out;
}
