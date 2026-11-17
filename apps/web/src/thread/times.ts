import type { CatalogEntry, Message, ReplyTimes } from "@gates-local/contracts";
import { describeModel } from "../lib/words/format.ts";
import type { StopNote } from "../lib/store/store.ts";

export interface Rounds {
  readonly spans: ReplyTimes["spans"];
  readonly callsAt: ReplyTimes["callsAt"];
}

export interface Drawn {
  readonly workMs: number | undefined;
  readonly waitMs: number | undefined;
  readonly rounds: Rounds | undefined;
  readonly note: StopNote | undefined;
}

const NONE: Drawn = { workMs: undefined, waitMs: undefined, rounds: undefined, note: undefined };
const drawn = new WeakMap<ReplyTimes, { readonly catalog: readonly CatalogEntry[] | undefined; readonly out: Drawn }>();

export function stopReason(why: { readonly code: string; readonly neededBy?: string | undefined }, catalog: readonly CatalogEntry[] | undefined): string | undefined {
  if (why.code === "runtime-changed") return "Stopped when the Ollama runtime changed.";
  if (why.code !== "preempted") return undefined;
  const by = why.neededBy === undefined ? "another model" : describeModel(why.neededBy, catalog).name;
  return `Stopped so ${by} could load.`;
}

function noteOf(role: Message["role"], t: ReplyTimes, catalog: readonly CatalogEntry[] | undefined): StopNote | undefined {
  const { reason, at } = t.ended;
  if (reason === "done") return undefined;
  if (reason === "stopped") return role === "assistant" ? { kind: "stopped", secs: Math.round((at - t.startedAt) / 1000) } : undefined;
  const said = t.why === undefined ? undefined : stopReason(t.why, catalog);
  if (said !== undefined) return { kind: "said", words: said };
  return { kind: "failed", why: t.why?.message ?? "", ...(t.why === undefined ? {} : { code: t.why.code }) };
}

function oldWorkMs(t: ReplyTimes): number | undefined {
  return t.thoughtMs ?? (t.firstTokenAt === undefined ? undefined : t.firstTokenAt - t.startedAt);
}

export function drawTimes(msg: Message, catalog: readonly CatalogEntry[] | undefined): Drawn {
  const t = msg.times;
  if (t === undefined) return NONE;
  const kept = drawn.get(t);
  if (kept !== undefined && kept.catalog === catalog) return kept.out;
  const out: Drawn = {
    workMs: t.workMs ?? oldWorkMs(t),
    waitMs: t.readyAt === undefined ? undefined : t.readyAt - t.startedAt,
    rounds: t.spans.length === 0 && Object.keys(t.callsAt).length === 0 ? undefined : { spans: t.spans, callsAt: t.callsAt },
    note: noteOf(msg.role, t, catalog),
  };
  drawn.set(t, { catalog, out });
  return out;
}
