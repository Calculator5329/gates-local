// The rules of the reply table, each with the test that fails without it. Every rule can be
// turned off one at a time, and only from a test: the server's through the `Rules` argument of
// the record module, the store and the app (chat/reply.ts), the two a window keeps through the
// stand-in window below. Each test runs twice here: as the product runs it, and with its rule
// off, where it must fail.
//
// To watch one fail by name, run this file with GATES_LOCAL_REPLY_RULE_OFF set to the rule's
// name. Nothing but this file reads that variable; the last test checks it.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message, ReplyAnswer } from "@gates-local/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { MODEL, rig, settle, until } from "../../test/send-rig.ts";
import { type Entry, type Ready, type RepliesDeps, createReplies } from "./replies.ts";
import { SOUND, type Rules } from "./reply.ts";

/** The two rules a window keeps. The server gives it what they need: a number on every record that rises with every change, and an honest answer. */
const WINDOW_RULES = ["windowOrdersByRev", "windowWaitsForAnswer"] as const;
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
  window: { windowOrdersByRev: rule !== "windowOrdersByRev", windowWaitsForAnswer: rule !== "windowWaitsForAnswer" },
});
const named = process.env[SWITCH];
if (named !== undefined && !isRule(named)) throw new Error(`${SWITCH} names no rule: ${named}`);
const off: Rule | undefined = named;

const entry = (id: string, threadId = "t1", more: Partial<Entry> = {}): Entry => ({ id, threadId, messageId: `m-${id}`, text: id, at: 1, waitFor: "reply", model: "m", numCtx: 4096, ...more });
const idle: Ready = { chat: true, anyWork: false, busy: () => false };
const question = (id: string, threadId = "t1"): Message => ({ id, threadId, role: "user", content: id, createdAt: 1 });
const WARM = { cold: false, drawing: false };

function store({ rules }: Under, file?: string, more: Partial<RepliesDeps> = {}) {
  return createReplies({
    file, log: () => undefined, changed: () => undefined, saved: () => undefined, deleting: () => false, closing: () => false,
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
 * it is given. The app's window is not on these calls yet, so the two rules a window keeps are
 * broken here, against the real store.
 */
function standIn(window: Under["window"]) {
  const shown = new Map<string, { readonly rev: number; readonly stage: string }>();
  const hears = (id: string, a: ReplyAnswer): void => {
    if (a.answer === "gone") {
      shown.delete(id);
      return;
    }
    const has = shown.get(id);
    // older than what it shows: dropped. The broken variant shows whatever came last.
    if (window.windowOrdersByRev && has !== undefined && a.reply.rev < has.rev) return;
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
      q.add(entry("a"));
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
      q.add(entry("a"));
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
      q.add(entry("a"));
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
      expect(q.add(entry("a"))).toBe("ok");
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
      q.add(entry("a"));
      q.add(entry("b", "t2"));
      q.update("b", { now: true }, 1);
      q.add(entry("c", "t3"));
      q.update("c", { editing: true }, 1);
      const again = store(under, file);
      expect(again.list().map((e) => [e.id, e.held, e.now, e.editing])).toEqual([["a", true, undefined, undefined], ["b", true, undefined, undefined], ["c", true, undefined, undefined]]);
      expect(again.pick(idle)).toBeUndefined();
    },
  },
  {
    rule: "windowOrdersByRev",
    name: "an answer that arrives after a newer one changes nothing a window shows",
    run(under) {
      const q = store(under);
      q.add(entry("a"));
      const one = standIn(under.window);
      const two = standIn(under.window);
      // window one puts it on hold; that answer is slow on its way back
      const held = q.hold({ id: "a" });
      // window two sends it now, and every window hears of that first
      const next = q.now({ id: "a" });
      one.hears("a", next);
      two.hears("a", next);
      one.hears("a", held);
      expect(two.shows("a")).toBe("next");
      expect(one.shows("a"), "every window shows the same").toBe(two.shows("a"));
      expect(q.list()[0], "and it is what the server has").toMatchObject({ id: "a", now: true });
    },
  },
  {
    rule: "windowWaitsForAnswer",
    name: "a window changes what it shows only when the server answers",
    run(under) {
      const q = store(under);
      q.add(entry("a"));
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
        if (r.queued()[0]?.sending === undefined) return;
        // the first read is the check when the send is taken; the second is inside the save
        if (++readsWhileSending === 2) stop?.();
      } });
      const { turnId } = await r.h["chat.send"]({ threadId: r.thread.id, content: "first", model: MODEL, numCtx: 16384 }, { clientId: 1 });
      const file = await r.h["files.attach"]({ name: "notes.txt", type: "text/plain", data: "aGVsbG8=" }, { clientId: 1 });
      await r.h["queue.add"]({ ...r.entry("q1", "second"), files: [file] }, { clientId: 1 });
      r.openOne();
      await until(() => r.queued()[0]?.sending !== undefined, "the queued message on its way");
      let stopped = false;
      stop = () => { stopped = true; void r.h["chat.cancel"]({ turnId }, { clientId: 1 }); };
      r.open();
      await until(() => stopped, "the Stop during the save");
      await settle();
      expect(r.db.getMessage("m-q1"), "the message the Stop pulled back was never saved").toBeUndefined();
      expect(r.starts()).toEqual(["first"]);
      expect(r.queued().map((q) => [q.id, q.held, q.sending])).toEqual([["q1", true, undefined]]);
    },
  },
  {
    rule: "pickSkipsEditing",
    name: "a message open in a composer is never sent",
    run(under) {
      const q = store(under);
      q.add(entry("a"));
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
      q.add(entry("a"));
      q.add(entry("b"));
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
      q.add(entry("a"));
      expect(q.remove({ id: "a" }).answer).toBe("done");
      expect(q.add(entry("a"))).toBe("removed");
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

/** The text of a call's arguments: from just after its opening bracket to the matching close, comments and quoted text blanked. */
function argumentsOf(source: string, from: number): string {
  let out = "";
  let depth = 1;
  for (let i = from; i < source.length && depth > 0; i++) {
    const ch = source[i] ?? "";
    const two = source.slice(i, i + 2);
    if (two === "//") { i = source.indexOf("\n", i); if (i < 0) break; continue; }
    if (two === "/*") { i = source.indexOf("*/", i) + 1; if (i < 1) break; continue; }
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < source.length && source[i] !== ch; i++) if (source[i] === "\\") i++;
      out += '""';
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (depth > 0) out += depth === 1 ? ch : " ";
  }
  return out;
}

describe("no rule can be turned off from the product", () => {
  const repo = fileURLToPath(new URL("../../../../", import.meta.url));
  const product = ["apps", "packages"].flatMap((top) => readdirSync(path.join(repo, top)).map((name) => path.join(top, name, "src")))
    .flatMap((dir) => { try { return readdirSync(path.join(repo, dir), { recursive: true, encoding: "utf8" }).map((f) => path.join(dir, f)); } catch { return []; } })
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => ({ file: f.split(path.sep).join("/"), text: readFileSync(path.join(repo, f), "utf8") }));
  const mentions = (re: RegExp) => product.filter((p) => re.test(p.text)).map((p) => p.file).toSorted();

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
    // their own declarations are not calls
    const calls = product.flatMap((p) => [...p.text.matchAll(/(?<!function )\b(createApp|createReplies)\(/g)].map((m) => ({ file: p.file, name: m[1] ?? "", args: argumentsOf(p.text, m.index + m[0].length) })));
    expect(calls.map((c) => `${c.file} ${c.name}`).toSorted()).toEqual(["apps/server/src/app.ts createReplies", "apps/server/src/main.ts createApp"]);
    for (const c of calls) {
      // one argument: no comma outside its brackets, but for a last one
      expect(c.args.replace(/,\s*$/, ""), `${c.file} ${c.name}`).not.toContain(",");
    }
    // the app hands the store the rules it was given and makes none of its own
    const wiring = product.find((p) => p.file === "apps/server/src/app.ts")?.text ?? "";
    const code = wiring.split("\n").map((l) => l.trim()).filter((l) => /\brules\b/.test(l) && !/^(\/\/|\/?\*)/.test(l));
    expect(code, "every line of the app's wiring that says rules").toEqual([
      "export function createApp(deps: AppDeps, rules?: Rules): App {",
      "...(rules === undefined ? {} : { rules }),",
    ]);
  });
});
