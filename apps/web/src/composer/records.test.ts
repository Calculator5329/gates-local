// The rules a window keeps on the server's records, each with the test that fails without it.
// The window here is the app's own (createChat), hearing the real store. Each test runs twice:
// as the product runs it, and with its rule off, where it must fail.
//
// To watch one fail by name, run this file with GATES_LOCAL_WINDOW_RULE_OFF set to the rule's
// name. Nothing but this file reads that variable; the last tests check it.
import type { Reply, ReplyChange } from "@gates-local/contracts";
import { callsOf, mentions, oneArgument, productSource } from "@gates-local/server/chat/product-testing.ts";
import { entry, waits as joins } from "@gates-local/server/chat/queue-testing.ts";
import { createReplies } from "@gates-local/server/chat/replies.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { State } from "../lib/store/store.ts";
import { KEPT, type WindowRules, createRecords } from "./records.ts";

vi.stubGlobal("window", {});
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) });

const { createChat } = await import("./chat.ts");
const { getState, setState } = await import("../lib/store/store.ts");
const initial = getState();
afterEach(() => { storage.clear(); setState(initial); });

type Rule = keyof WindowRules;
const SWITCH = "GATES_LOCAL_WINDOW_RULE_OFF";
const isRule = (rule: string): rule is Rule => rule in KEPT;
/** Everything as the product runs it, but for this one rule. */
const without = (rule: Rule | undefined): WindowRules => (rule === undefined ? KEPT : { ...KEPT, [rule]: false });
const named = process.env[SWITCH];
if (named !== undefined && !isRule(named)) throw new Error(`${SWITCH} names no rule: ${named}`);
const off: Rule | undefined = named;

/** The real store, and what it sends every window, in the order it sends it. */
function server() {
  const sent: ReplyChange[] = [];
  const q = createReplies({
    log: () => undefined, told: (change) => void sent.push(change), saved: () => undefined, deleting: () => false, closing: () => false,
    cut: () => undefined, clock: () => undefined,
  });
  return { q, sent };
}
const never = () => { throw new Error("hearing of a record asks the server nothing"); };
/** The app's window, keeping these rules. */
function windowUnder(rules: WindowRules) {
  setState(initial);
  return createChat({
    applyServerEvent: (patch: Partial<State> | ((s: State) => Partial<State>)) => setState(patch),
    call: never, reply: never, codeOf: () => "", createThread: never, creatingDraft: () => false, loadThread: never, loading: () => false,
    noteMessage: never, withMessage: never, untrackedDone: never, openThread: never, blockingFor: () => [],
  } as unknown as Parameters<typeof createChat>[0], rules);
}
const shown = (id: string): Reply | undefined => getState().replies.get(id);

interface Case {
  readonly rule: Rule;
  readonly name: string;
  readonly run: (rules: WindowRules) => void;
}

const CASES: readonly Case[] = [
  {
    rule: "windowOrdersByRev",
    name: "a list that arrives after a newer push changes nothing a window shows",
    run(rules) {
      const { q, sent } = server();
      joins(q, entry("a"));
      const chat = windowUnder(rules);
      chat.connected();
      // the window reads the list as it connects; the answer is slow on its way
      const listed = q.records();
      expect(listed.map((l) => l.reply.stage)).toEqual(["queued"]);
      // another window presses Send now, and this one hears of that first
      sent.length = 0;
      expect(q.now({ id: "a" }).answer).toBe("done");
      expect(sent.map((c) => c.kind === "is" && c.reply.stage)).toEqual(["next"]);
      for (const change of sent) chat.recordChanged(change);
      expect(shown("a")?.stage).toBe("next");
      chat.replyListed(listed);
      expect(shown("a"), "the window shows what the server has").toEqual(q.records()[0]?.reply);
    },
  },
];

describe("the rules a window keeps on the server's records", () => {
  it("there is a test here for every rule that can be turned off", () => {
    expect(CASES.map((c) => c.rule).toSorted()).toEqual(Object.keys(KEPT).toSorted());
  });

  for (const c of CASES) it(`${c.rule}: ${c.name}`, () => c.run(without(off)));
});

describe("each window rule turned off fails its own test", () => {
  for (const c of CASES) {
    it(`with ${c.rule} off, "${c.name}" fails`, () => {
      let failed: unknown;
      try { c.run(without(c.rule)); } catch (e) { failed = e; }
      expect(failed, "the test passed with its rule off: it does not guard the rule").toBeInstanceOf(Error);
    });
  }
});

const queued = (rev: number): Reply => ({ id: "a", threadId: "t1", rev, messageId: "m-a", text: "a", at: 1, stage: "queued" });
const is = (reply: Reply): ReplyChange => ({ kind: "is", reply });
const left = (rev: number): ReplyChange => ({ kind: "left", id: "a", threadId: "t1", rev, why: "removed" });
const done = (rev: number): Reply => ({ id: "a", threadId: "t1", rev, stage: "done", at: 2, questionId: "m-a", replyId: "r-a" });

describe("which changes are news", () => {
  it("a change is taken when it is newer than the one held, and the same change again is not", () => {
    const records = createRecords();
    expect(records.takes(undefined, is(queued(4)))).toBe(true);
    expect(records.takes(queued(4), is(queued(4))), "the same change, told twice").toBe(false);
    expect(records.takes(queued(4), is(queued(3)))).toBe(false);
    expect(records.takes(queued(4), is(queued(5)))).toBe(true);
  });

  it("a record that left or ended is not brought back by a change sent before it went", () => {
    const records = createRecords();
    expect(records.takes(queued(4), left(6))).toBe(true);
    expect(records.takes(undefined, is(queued(5))), "a list read before the removal").toBe(false);
    expect(records.takes(undefined, left(6)), "the removal, told twice").toBe(false);
    const ended = createRecords();
    expect(ended.takes(queued(4), is(done(8)))).toBe(true);
    expect(ended.takes(undefined, is(queued(7))), "a list read before the reply was saved").toBe(false);
  });

  it("after a reconnect the first thing said of a held record replaces it, whatever its number: the server may have started again", () => {
    const records = createRecords();
    records.connected(["a", "b"]);
    expect(records.takes(queued(40), is(queued(2)))).toBe(true);
    expect(records.takes(queued(2), is(queued(1))), "and from then on its numbers order it").toBe(false);
    expect(records.unlisted(), "a held record the list did not name is gone").toEqual(["b"]);
    expect(records.unlisted()).toEqual([]);
  });

  it("a new connection forgets what left on the last one: the count may have started again", () => {
    const records = createRecords();
    expect(records.takes(queued(4), left(60))).toBe(true);
    records.connected([]);
    expect(records.takes(undefined, is(queued(1)))).toBe(true);
  });
});

describe("no window rule can be turned off from the product", () => {
  const product = productSource();

  it("only the records module names a rule, and nothing reads the variable this file reads", () => {
    expect(product.map((p) => p.file)).toContain("apps/web/src/composer/chat.ts");
    expect(mentions(product, new RegExp(`\\b(${Object.keys(KEPT).join("|")})\\b`))).toEqual(["apps/web/src/composer/records.ts"]);
    expect(mentions(product, new RegExp(SWITCH))).toEqual([]);
    // the rules as a whole are passed on by the window's own module and by nothing else
    expect(mentions(product, /\bimport\b[^;]*\b(KEPT|WindowRules)\b[^;]*from "[^"]*\/records\.ts"/)).toEqual(["apps/web/src/composer/chat.ts"]);
  });

  it("the one product call that makes the window passes no rules", () => {
    const calls = callsOf(product, ["createChat", "createRecords"]);
    expect(calls.map((c) => `${c.file} ${c.name}`).toSorted()).toEqual(["apps/web/src/composer/chat.ts createRecords", "apps/web/src/lib/session/index.ts createChat"]);
    const made = calls.find((c) => c.name === "createChat");
    expect(made !== undefined && oneArgument(made), `createChat(${made?.args})`).toBe(true);
    // the window hands on the rules it was given and makes none of its own
    const wiring = product.find((p) => p.file === "apps/web/src/composer/chat.ts")?.text ?? "";
    const code = wiring.split("\n").map((l) => l.trim()).filter((l) => /\brules\b/.test(l) && !/^(\/\/|\/?\*)/.test(l));
    expect(code.map((l) => l.replace(/^.*(?=\}: ChatEffects)/, "")), "every line of the window's module that says rules").toEqual([
      "}: ChatEffects, rules?: WindowRules) {",
      "const records = createRecords(rules);",
    ]);
  });
});
