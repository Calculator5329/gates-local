// The Reply model's table, read from the real `move()` in apps/server/src/chat/reply.ts.
// Every record kind the code can reach is given every input the model uses, once per rule switched off.
import type { Message } from "@gates-local/contracts";
import {
  ENDED, IN_FLIGHT, SOUND, WAITING, fromQueued, move, stillStarting, toQueued,
  type Back, type Input, type Moved, type Queued, type Rec, type Rules,
} from "../../apps/server/src/chat/reply.ts";
import { bool, moduleText, record, set, text } from "../tla.ts";

const CHAT = "chat";
const OTHER_TURN = "another-turn";
const QUESTION: Message = { id: "question", threadId: CHAT, role: "user", content: "words", createdAt: 1 };
const TYPED: Queued = {
  id: "message", threadId: CHAT, rev: 0, words: { messageId: "question", text: "words", at: 1 },
  behind: "reply", starts: 0, direct: false, stage: "queued", waitFor: "reply",
};

const backKind = (b: Back): string => (b.stage === "queued" ? `queued_${b.waitFor}` : b.stage === "held" ? `held_${b.why.why}` : "next");

/** The part of a record the model keeps: its stage, and what decides where it goes from there. */
export function kindOf(r: Rec | undefined): string {
  if (r === undefined) return "none";
  switch (r.stage) {
    case "queued":
    case "held":
    case "next":
      return backKind(r);
    case "editing":
      return `editing${r.by}_${backKind(r.back)}`;
    case "starting":
      return r.now ? "starting_now" : "starting";
    case "loading":
    case "thinking":
    case "tool":
    case "writing":
      return r.try > 1 ? `${r.stage}_again` : r.stage;
    case "removed":
      return r.why === "removed" ? "removed_removed" : "removed_chat_deleted";
    case "drawing":
    case "stopping":
    case "done":
    case "stopped":
    case "failed":
      return r.stage;
  }
}

function turnOf(r: Rec | undefined): { readonly turnId: string; readonly attempt: number } {
  if (r === undefined || !("turnId" in r) || r.turnId === undefined) return { turnId: "no-turn", attempt: 1 };
  return { turnId: r.turnId, attempt: r.stage === "starting" ? r.attempt : 1 };
}

const chat = (busy: boolean) => ({ deleting: false, closing: false, busy });

/** The inputs the model uses, under the names its actions use. `same` is the record's own turn, `other` an older one. */
function inputs(r: Rec | undefined): Readonly<Record<string, Input>> {
  const { turnId, attempt } = turnOf(r);
  const start = { turnId: "new-turn", at: 2, retry: false };
  const began = { question: QUESTION, model: "model", cold: false, drawing: false };
  const why = { code: "memory", message: "no room" };
  return {
    send_start: { call: "send", record: TYPED, chat: chat(false), saved: false, start },
    send_wait: { call: "send", record: TYPED, chat: chat(true), saved: false },
    send_saved_start: { call: "send", record: TYPED, chat: chat(false), saved: true, start },
    send_saved_wait: { call: "send", record: TYPED, chat: chat(true), saved: true },
    stop: { call: "stop", at: 5 },
    hold: { call: "hold" },
    remove: { call: "remove" },
    now: { call: "now", stops: false },
    now_stops: { call: "now", stops: true },
    edit_open_1: { call: "edit", open: true, by: 1 },
    edit_open_2: { call: "edit", open: true, by: 2 },
    edit_close_1: { call: "edit", open: false, by: 1 },
    edit_close_2: { call: "edit", open: false, by: 2 },
    take: { event: "take", turnId: "taken-turn", at: 3 },
    start_same: { event: "start", turnId, attempt, ...began },
    start_other: { event: "start", turnId: OTHER_TURN, attempt, ...began },
    refuse_same: { event: "refuse", turnId, attempt, why },
    refuse_other: { event: "refuse", turnId: OTHER_TURN, attempt, why },
    end_done_same: { event: "end", turnId, at: 7, end: { how: "done", replyId: "reply" } },
    end_failed_same: { event: "end", turnId, at: 7, end: { how: "failed", code: "internal", message: "it broke" } },
    end_done_other: { event: "end", turnId: OTHER_TURN, at: 7, end: { how: "done", replyId: "reply" } },
    ahead_stopped: { event: "ahead", what: "stopped" },
    ahead_late_stop: { event: "ahead", what: "late-stop" },
    ahead_retry: { event: "ahead", what: "retry" },
    ahead_failed: { event: "ahead", what: "failed" },
    ahead_done: { event: "ahead", what: "done" },
    restart: { event: "restart", at: 9 },
    saved: { event: "saved" },
    left_same: { event: "left", turnId, at: 8 },
    left_other: { event: "left", turnId: OTHER_TURN, at: 8 },
  };
}

type NameOf<I> = I extends { readonly call: infer C } ? C : I extends { readonly event: infer E } ? E : never;

/** Every call and event `move()` takes. `false` is one the model leaves out; a new one fails the typecheck here until it is placed. */
const USED: Readonly<Record<NameOf<Input>, boolean>> = {
  send: true, stop: true, hold: true, remove: true, now: true, edit: true, change: false,
  take: true, start: true, refuse: true, end: true, ahead: true, restart: true, saved: true, left: true,
  load: false, tool: false, think: false, word: false, retry: false, "chat-deleted": false,
};

interface Row { readonly next: string; readonly ans: string; readonly ahead: string; readonly stop: boolean }
type Table = Map<string, Map<string, Row>>;

const word = (s: string): string => s.replaceAll("-", "_");

function rowOf(m: Moved): Row {
  const a = m.answer;
  return {
    next: kindOf(m.next),
    ans: a === undefined ? "none" : a.answer === "gone" ? word(`gone_${a.why}`) : a.answer,
    ahead: m.ahead === undefined ? "none" : word(m.ahead),
    stop: m.stopChat === true,
  };
}

const same = (a: Row, b: Row): boolean => a.next === b.next && a.ans === b.ans && a.ahead === b.ahead && a.stop === b.stop;

/** How many different records of one kind are given every input, to show the kind decides the answer. */
const KEPT_PER_KIND = 4;

interface Read {
  readonly table: Table;
  readonly stages: Map<string, Rec["stage"]>;
  /** Kinds whose own turn may still store its question, and kinds an older turn may store one for. */
  readonly still: { readonly same: Set<string>; readonly other: Set<string> };
  /** What a kind comes back as from the saved file, before the restart is applied to it. */
  readonly rows: Map<string, string>;
}

/** Walks every record `move()` reaches from nothing through the inputs above, under one set of rules. */
function read(rules: Rules, name: string): Read {
  const out: Read = { table: new Map(), stages: new Map(), still: { same: new Set(), other: new Set() }, rows: new Map() };
  const kept = new Map<string, number>();
  const seen = new Set<string>();
  const todo: (Rec | undefined)[] = [undefined];
  const disagree = (kind: string, what: string, a: string, b: string): never => {
    throw new Error(
      `apps/server/src/chat/reply.ts (${name}): two records the model holds as one kind, ${kind}, ${what}: ${a} and ${b}. `
      + "If the change to reply.ts is meant, kindOf() in model/reply/table.ts has to tell these two apart; if it is not, this is the mistake.",
    );
  };
  while (todo.length > 0) {
    const r = todo.shift();
    const kind = kindOf(r);
    const json = JSON.stringify(r ?? null);
    const reps = kept.get(kind) ?? 0;
    if (seen.has(json) || reps >= KEPT_PER_KIND) continue;
    seen.add(json);
    kept.set(kind, reps + 1);
    if (r !== undefined) out.stages.set(kind, r.stage);

    const saved = r === undefined ? undefined : toQueued(r);
    const back = saved === undefined ? undefined : fromQueued(saved);
    const before = out.rows.get(kind);
    if (before !== undefined && before !== kindOf(back)) disagree(kind, "come back from the saved file differently", before, kindOf(back));
    out.rows.set(kind, kindOf(back));
    if (back !== undefined) todo.push(back);

    const { turnId, attempt } = turnOf(r);
    for (const [which, id] of [["same", turnId], ["other", OTHER_TURN]] as const) {
      const yes = stillStarting(r, id, attempt, rules);
      if (reps > 0 && out.still[which].has(kind) !== yes) disagree(kind, `answer stillStarting() for the ${which} turn differently`, String(!yes), String(yes));
      if (yes) out.still[which].add(kind);
    }

    const at = out.table.get(kind) ?? new Map<string, Row>();
    out.table.set(kind, at);
    for (const [input, value] of Object.entries(inputs(r))) {
      const moved = move(r, value, rules);
      const row = rowOf(moved);
      const earlier = at.get(input);
      if (earlier !== undefined && !same(earlier, row)) disagree(kind, `answer ${input} differently`, JSON.stringify(earlier), JSON.stringify(row));
      at.set(input, row);
      todo.push(moved.next);
    }
  }
  return out;
}

const rowText = (r: Row): string => record({ next: text(r.next), ans: text(r.ans), ahead: text(r.ahead), stop: bool(r.stop) });

function tableText(t: Table, only: (kind: string, input: string, row: Row) => boolean): string {
  const kinds: Record<string, string> = {};
  for (const [kind, at] of [...t].toSorted(([a], [b]) => a.localeCompare(b))) {
    const cells: Record<string, string> = {};
    for (const [input, row] of at) if (only(kind, input, row)) cells[input] = rowText(row);
    if (Object.keys(cells).length > 0) kinds[kind] = record(cells, ",\n      ");
  }
  return record(kinds, ",\n    ");
}

export const RULES: readonly string[] = Object.keys(SOUND);

export interface ReplyTable { readonly module: string; readonly kinds: number; readonly cells: number }

/** The module `ReplyCode` the Reply model extends. Throws, naming the kind and the input, when the code stops fitting the model's kinds. */
export function replyTable(): ReplyTable {
  const given = new Set(Object.values(inputs(undefined)).map((i) => ("call" in i ? i.call : i.event)));
  for (const [name, used] of Object.entries(USED)) {
    if (used !== given.has(name as NameOf<Input>)) throw new Error(`model/reply/table.ts: USED says ${name} is ${used ? "" : "not "}given to move(), and inputs() says otherwise.`);
  }
  const sound = read(SOUND, "sound rules");
  const off = new Map(RULES.map((rule) => [rule, read({ ...SOUND, [rule]: false }, `${rule} off`)] as const));
  const stages = new Map(sound.stages);
  const rows = new Map(sound.rows);
  for (const r of off.values()) {
    for (const [k, v] of r.stages) stages.set(k, v);
    for (const [k, v] of r.rows) rows.set(k, v);
  }
  const kinds = ["none", ...stages.keys()];
  const where = (test: (stage: Rec["stage"]) => boolean) => set([...stages].filter(([, s]) => test(s)).map(([k]) => text(k)));

  const diffs: Record<string, string> = {};
  const stills: Record<string, string> = {};
  for (const [rule, r] of off) {
    diffs[rule] = tableText(r.table, (kind, input, row) => {
      const was = sound.table.get(kind)?.get(input);
      return was === undefined || !same(was, row);
    });
    stills[rule] = record({ same: set([...r.still.same].map(text)), other: set([...r.still.other].map(text)) });
  }
  const at: Record<string, string> = {};
  const row: Record<string, string> = {};
  for (const k of kinds.toSorted()) {
    at[k] = text(/^editing\d_(.+)$/.exec(k)?.[1] ?? k);
    row[k] = text(rows.get(k) ?? "none");
  }
  let cells = 0;
  for (const t of sound.table.values()) cells += t.size;

  const module = moduleText("ReplyCode", "model/reply/table.ts", [], {
    Kinds: set(kinds.map(text)),
    Waiting: where((s) => WAITING.has(s)),
    InFlight: where((s) => IN_FLIGHT.has(s)),
    Ended: where((s) => ENDED.has(s)),
    Asked: where((s) => IN_FLIGHT.has(s) && s !== "starting"),
    Starting: where((s) => s === "starting"),
    Stopping: where((s) => s === "stopping"),
    Editing: where((s) => s === "editing"),
    QueuedKinds: where((s) => s === "queued"),
    HeldKinds: where((s) => s === "held"),
    Removed: where((s) => s === "removed"),
    At: record(at, ",\n    "),
    RowOf: record(row, ",\n    "),
    Rules: set(RULES.map(text)),
    Sound: tableText(sound.table, () => true),
    Diff: record(diffs, ",\n  "),
    StillSound: record({ same: set([...sound.still.same].map(text)), other: set([...sound.still.other].map(text)) }),
    StillDiff: record(stills, ",\n  "),
    AheadInput: record({ stopped: text("ahead_stopped"), late_stop: text("ahead_late_stop"), retry: text("ahead_retry"), failed: text("ahead_failed"), done: text("ahead_done") }),
  });
  return { module, kinds: kinds.length, cells };
}
