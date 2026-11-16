// The rules of the reply table, each with the test that fails without it. Every rule can be
// turned off one at a time, and only from a test: the server's through the `Rules` argument of
// the record module, the store and the app (chat/reply.ts), the one a window keeps on its own
// calls through the stand-in window below. Each test runs twice here: as the product runs it,
// and with its rule off, where it must fail. The rule a window keeps on the order of what it
// hears is tested on the window itself (apps/web/src/composer/records.test.ts).
//
// To watch one fail by name, run this file with GATES_LOCAL_REPLY_RULE_OFF set to the rule's
// name. Nothing but this file reads that variable; the last test checks it.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message, ReplyAnswer } from "@gates-local/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { MODEL, rig, settle, until } from "../../test/send-rig.ts";
import { callsOf, mentions as mentionsIn, oneArgument, productSource } from "./product-testing.ts";
import { entry, waits } from "./queue-testing.ts";
import { type Ready, type RepliesDeps, createReplies } from "./replies.ts";
import { SOUND, type Rules } from "./reply.ts";

/** The rule a window keeps on its own calls. The server gives it what that needs: an honest answer. */
const WINDOW_RULES = ["windowWaitsForAnswer"] as const;
type WindowRule = (typeof WINDOW_RULES)[number];
type Rule = keyof Rules | WindowRule;
interface Under {
  readonly rules: Rules;
  readonly window: Readonly<Record<WindowRule, boolean>>;
}

const SWITCH = "GATES_LOCAL_REPLY_RULE_OFF";
const isServerRule = (rule: string): rule is keyof Rules => rule in SOUND;
const isRule = (rule: string): rule is Rule => isServerRule(rule) || (WINDOW_RULES as readonly string[]).includes(rule);
/** Everything as the product runs it, but for this one rule. */
const without = (rule: Rule | undefined): Under => ({
  rules: rule !== undefined && isServerRule(rule) ? { ...SOUND, [rule]: false } : SOUND,
  window: { windowWaitsForAnswer: rule !== "windowWaitsForAnswer" },
});
const named = process.env[SWITCH];
if (named !== undefined && !isRule(named)) throw new Error(`${SWITCH} names no rule: ${named}`);
const off: Rule | undefined = named;

const idle: Ready = { chat: true, anyWork: false, busy: () => false };
const question = (id: string, threadId = "t1"): Message => ({ id, threadId, role: "user", content: id, createdAt: 1 });
const WARM = { cold: false, drawing: false };

function store({ rules }: Under, file?: string, more: Partial<RepliesDeps> = {}) {
  return createReplies({
    file, log: () => undefined, told: () => undefined, saved: () => undefined, deleting: () => false, closing: () => false,
    cut: () => undefined, clock: () => undefined, rules, ...more,
  });
}

function dataFile(): string {
  const root = path.join(os.homedir(), ".cache", "gates-local-tests");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, "reply-rules-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "queue.json");
}

/**
 * A stand-in for a window on the reply calls: what it shows for each message, from the answers
 * it is given. The app's window does not send through these calls yet, so the rule a window
 * keeps on its own calls is broken here, against the real store.
 */
function standIn(window: Under["window"]) {
  const shown = new Map<string, { readonly rev: number; readonly stage: string }>();
  const hears = (id: string, a: ReplyAnswer): void => {
    if (a.answer === "gone") {
      shown.delete(id);
      return;
    }
    const has = shown.get(id);
    // older than what it shows: dropped
    if (has !== undefined && a.reply.rev < has.rev) return;
    shown.set(id, { rev: a.reply.rev, stage: a.reply.stage });
  };
  return {
    hears,
    /** The person presses remove. */
    remove(id: string, ask: () => ReplyAnswer): void {
      if (!window.windowWaitsForAnswer) {
        // the broken variant takes the row off its own screen at the press, whatever the server says
        shown.delete(id);
        ask();
        return;
      }
      const a = ask();
      if (a.answer === "done") shown.delete(id);
      else hears(id, a);
    },
    shows: (id: string): string | undefined => shown.get(id)?.stage,
  };
}

interface Case {
  readonly rule: Rule;
  readonly name: string;
  readonly run: (under: Under) => void | Promise<void>;
}

const CASES: readonly Case[] = [
  {
    rule: "lateStopHolds",
    name: "a Stop that reaches the server after the reply's last word still holds what waits in its chat",
    run(under) {
      const q = store(under);
      q.direct("turn-1", "t1", { messageId: "m-1", text: "first", at: 1 }, false, 1);
      expect(q.started("turn-1", 1, question("m-1"), "m", WARM)).toBe(true);
      waits(q, entry("a"));
      q.ended("turn-1", { how: "done" }, 2);
      q.left("turn-1");
      q.notify();
      expect(q.pick(idle)?.id, "it would go next").toBe("a");
      expect(q.stop({ id: "turn-1" }).answer).toBe("gone");
      expect(q.list().map((e) => [e.id, e.held])).toEqual([["a", true]]);
      expect(q.pick(idle), "nothing goes on its own after a Stop").toBeUndefined();
    },
  },
  {
    rule: "removeAnswersHonestly",
    name: "a message that goes on to be asked was never said to be removed",
    run(under) {
      const q = store(under);
      waits(q, entry("a"));
      const attempt = q.take("a", "turn-a", 1);
      q.begun("turn-a");
      const answer = q.remove({ id: "a" });
      expect(q.started("turn-a", attempt ?? 0, question("m-a"), "m", WARM), "it was on its way, and its question is saved").toBe(true);
      expect(answer.answer).toBe("sending");
    },
  },
  {
    rule: "editAnswersHonestly",
    name: "an edit the server did not keep is not answered as done",
    run(under) {
      const q = store(under);
      waits(q, entry("a"));
      expect(q.change({ id: "a", base: "m-a", messageId: "m-a1", text: "from one window" }, 1).answer).toBe("done");
      // a second window's save began from the words as first typed
      const late = q.change({ id: "a", base: "m-a", messageId: "m-a2", text: "from another window" }, 2);
      expect(q.list()[0]?.text, "the words kept are the first window's").toBe("from one window");
      expect(late.answer).toBe("elsewhere");
    },
  },
  {
    rule: "sendChecksSaved",
    name: "a message whose question is in its chat is not queued to be asked again",
    run(under) {
      const q = store(under, undefined, { saved: (messageId) => (messageId === "m-a" ? question("m-a") : undefined) });
      // a window that missed the start still has the message, and sends it once more
      expect(waits(q, entry("a"))).toBe("sent");
      expect(q.list()).toEqual([]);
      expect(q.pick(idle)).toBeUndefined();
    },
  },
  {
    rule: "restartHolds",
    name: "after a restart nothing a closed app left goes on its own",
    run(under) {
      const file = dataFile();
      const q = store(under, file);
      waits(q, entry("a"));
      waits(q, entry("b", "t2"));
      q.now({ id: "b" });
      waits(q, entry("c", "t3"));
      q.edit({ id: "c", open: true }, 1);
      const again = store(under, file);
      expect(again.list().map((e) => [e.id, e.held, e.now, e.editing])).toEqual([["a", true, undefined, undefined], ["b", true, undefined, undefined], ["c", true, undefined, undefined]]);
      expect(again.pick(idle)).toBeUndefined();
    },
  },
  {
    rule: "windowWaitsForAnswer",
    name: "a window changes what it shows only when the server answers",
    run(under) {
      const q = store(under);
      waits(q, entry("a"));
      q.take("a", "turn-a", 1);
      q.begun("turn-a");
      const one = standIn(under.window);
      const two = standIn(under.window);
      const read = () => q.hold({ id: "a" });
      one.hears("a", read());
      two.hears("a", read());
      expect(two.shows("a")).toBe("starting");
      // too late to remove: it is on its way
      one.remove("a", () => q.remove({ id: "a" }));
      two.hears("a", read());
      expect(one.shows("a"), "every window shows the same").toBe(two.shows("a"));
      expect(q.list().map((e) => e.id), "and it is what the server has").toEqual(["a"]);
    },
  },
  {
    rule: "saveChecksStage",
    name: "a Stop that lands inside a start's save leaves nothing of that message saved",
    async run({ rules }) {
      let stop: (() => void) | undefined;
      let readsWhileSending = 0;
      const r = rig({ rules, fileOwnersRead: () => {
        if (r.latest("q1")?.stage !== "starting") return;
        // the first read is the check when the send is taken; the second is inside the save
        if (++readsWhileSending === 2) stop?.();
      } });
      const { turnId } = await r.h["chat.send"]({ threadId: r.thread.id, content: "first", model: MODEL, numCtx: 16384 }, { clientId: 1 });
      const file = await r.h["files.attach"]({ name: "notes.txt", type: "text/plain", data: "aGVsbG8=" }, { clientId: 1 });
      await r.h["reply.send"]({ ...r.entry("q1", "second"), files: [file] }, { clientId: 1 });
      r.openOne();
      await until(() => r.latest("q1")?.stage === "starting", "the queued message on its way");
      let stopped = false;
      stop = () => { stopped = true; void r.h["chat.cancel"]({ turnId }, { clientId: 1 }); };
      r.open();
      await until(() => stopped, "the Stop during the save");
      await settle();
      expect(r.db.getMessage("m-q1"), "the message the Stop pulled back was never saved").toBeUndefined();
      expect(r.starts()).toEqual(["first"]);
      expect(r.queued().map((q) => [q.id, q.stage])).toEqual([["q1", "held"]]);
    },
  },
  {
    rule: "pickSkipsEditing",
    name: "a message open in a composer is never sent",
    run(under) {
      const q = store(under);
      waits(q, entry("a"));
      expect(q.edit({ id: "a", open: true }, 1).answer).toBe("done");
      expect(q.pick(idle)).toBeUndefined();
      expect(q.take("a", "turn-a", 1), "nor can a start be taken for it").toBeUndefined();
      expect(q.list()).toMatchObject([{ id: "a", editing: true }]);
    },
  },
  {
    rule: "restartReconciles",
    name: "after a restart a message whose question is saved is not listed as waiting",
    run(under) {
      const file = dataFile();
      const q = store(under, file);
      waits(q, entry("a"));
      waits(q, entry("b"));
      // the app closed after a's question was saved and before its row left the file
      const again = store(under, file, { saved: (messageId) => (messageId === "m-a" ? question("m-a") : undefined) });
      expect(again.list().map((e) => e.id)).toEqual(["b"]);
      expect(again.remove({ id: "a" })).toEqual({ answer: "gone", why: "sent", question: question("m-a") });
    },
  },
  {
    rule: "removalIsRemembered",
    name: "a removed message is not queued again by a window that missed the removal",
    run(under) {
      const q = store(under);
      waits(q, entry("a"));
      expect(q.remove({ id: "a" }).answer).toBe("done");
      expect(waits(q, entry("a"))).toBe("removed");
      expect(q.list()).toEqual([]);
      expect(q.pick(idle)).toBeUndefined();
    },
  },
];

describe("the rules of the reply table", () => {
  it("there is a test here for every rule that can be turned off", () => {
    expect(CASES.map((c) => c.rule).toSorted()).toEqual([...Object.keys(SOUND), ...WINDOW_RULES].toSorted());
  });

  for (const c of CASES) it(`${c.rule}: ${c.name}`, () => c.run(without(off)));
});

describe("each rule turned off fails its own test", () => {
  for (const c of CASES) {
    it(`with ${c.rule} off, "${c.name}" fails`, async () => {
      let failed: unknown;
      try { await c.run(without(c.rule)); } catch (e) { failed = e; }
      expect(failed, "the test passed with its rule off: it does not guard the rule").toBeInstanceOf(Error);
    });
  }
});

describe("no rule can be turned off from the product", () => {
  const product = productSource();
  const mentions = (re: RegExp) => mentionsIn(product, re);

  it("looks at the product's files", () => {
    expect(product.length).toBeGreaterThan(200);
    expect(product.map((p) => p.file)).toContain("apps/server/src/main.ts");
  });

  it("only the record module and the store name a rule, and nothing reads the variable this file reads", () => {
    const rule = new RegExp(`\\b(${Object.keys(SOUND).join("|")})\\b`);
    expect(mentions(rule)).toEqual(["apps/server/src/chat/replies.ts", "apps/server/src/chat/reply.ts"]);
    expect(mentions(new RegExp(SWITCH))).toEqual([]);
    // the rules as a whole are passed on by the app's wiring and by nothing else
    expect(mentions(/\bimport\b[^;]*\b(SOUND|Rules)\b[^;]*from "[^"]*\/reply\.ts"/)).toEqual(["apps/server/src/app.ts", "apps/server/src/chat/replies.ts"]);
  });

  it("every product call that makes the app or the store passes no rules", () => {
    const calls = callsOf(product, ["createApp", "createReplies"]);
    expect(calls.map((c) => `${c.file} ${c.name}`).toSorted()).toEqual(["apps/server/src/app.ts createReplies", "apps/server/src/main.ts createApp"]);
    for (const c of calls) expect(oneArgument(c), `${c.file} ${c.name}(${c.args})`).toBe(true);
    // the app hands the store the rules it was given and makes none of its own
    const wiring = product.find((p) => p.file === "apps/server/src/app.ts")?.text ?? "";
    const code = wiring.split("\n").map((l) => l.trim()).filter((l) => /\brules\b/.test(l) && !/^(\/\/|\/?\*)/.test(l));
    expect(code, "every line of the app's wiring that says rules").toEqual([
      "export function createApp(deps: AppDeps, rules?: Rules): App {",
      "...(rules === undefined ? {} : { rules }),",
    ]);
  });
});
