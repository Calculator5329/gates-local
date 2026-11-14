import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as S from "effect/Schema";
import { describe, expect, it } from "vitest";
import { runSnapshotQuery } from "../../../../packages/harness/src/sql.ts";
import { BUDGET, CASES, WEIGHTS, ensureFixtures, numbersIn, pageIn, toolCallOf, type MeasureCase } from "./cases.ts";
import { STEPS, measureModel, type MeasureInput } from "./suite.ts";
import { gradePages, partsOf, scoreOf } from "./score.ts";
import { measureStore } from "./store.ts";
import { PAGES_UNRUN, createMeasure, type MeasureDeps } from "./handlers.ts";
import { createMemoryOwner } from "../gpu/memory.ts";
import { ModelActionError, type TurnReservation } from "../runtime/load.ts";
import type { LoadedModel } from "../runtime/types.ts";
import type { FitReport, MeasureRun, ModelInfo, ModelMeasure } from "@gates-local/contracts";
import type { Push } from "../app.ts";

const dir = () => mkdtempSync(path.join(tmpdir(), "measure-"));

type Answer = { content?: string; thinking?: string; calls?: unknown[]; evalCount?: number; evalNs?: number; doneReason?: string };
type Body = { messages: { role: string; content: string }[]; options: Record<string, number>; think?: boolean; tools?: unknown[] };
/**
 * A runtime that answers /api/show with `capabilities` and each /api/chat with `play(check, round)`,
 * where round counts the model's earlier replies in this turn, streamed as NDJSON.
 */
function fakeRuntime(capabilities: string[] | undefined, play: (c: MeasureCase | undefined, round: number, body: Body) => Answer) {
  const bodies: Body[] = [];
  const fetcher = (async (url: URL | string, init?: RequestInit) => {
    const route = new URL(String(url)).pathname;
    if (route === "/api/show") return Response.json(capabilities ? { capabilities } : {});
    const body = JSON.parse(String(init?.body ?? "{}")) as Body;
    bodies.push(body);
    // The check's prompt, not a tool result sent back as a user message (the text call format).
    const user = body.messages.findLastIndex((m) => m.role === "user" && CASES.some((x) => x.prompt === m.content));
    const c = CASES.find((x) => x.prompt === body.messages[user]?.content);
    const a = play(c, body.messages.slice(user + 1).filter((m) => m.role === "assistant").length, body);
    const lines = [
      ...(a.thinking ? [{ message: { role: "assistant", content: "", thinking: a.thinking }, done: false }] : []),
      { message: { role: "assistant", content: a.content ?? "", ...(a.calls ? { tool_calls: a.calls } : {}) }, done: false },
      { message: { role: "assistant", content: "" }, done: true, done_reason: a.doneReason ?? "stop", eval_count: a.evalCount ?? 60, eval_duration: a.evalNs ?? 1e9, prompt_eval_count: 30 },
    ];
    return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }) as typeof fetch;
  return { fetcher, bodies, checks: () => bodies.filter((b) => b.messages.some((m) => CASES.some((c) => c.prompt === m.content))) };
}

/** Each check the way a model that gets it right does it: the reference calls, then the answer. */
const reference = (windows: boolean, text = false) => (c: MeasureCase | undefined, round: number): Answer => {
  if (!c) return { content: "Hi" };
  if (c.kind === "page") return { content: c.reference.answer };
  const call = c.reference.calls[round];
  if (!call) return { content: c.reference.answer };
  const fn = toolCallOf(call, windows);
  return text ? { content: `<tool_call>${JSON.stringify(fn)}</tool_call>` } : { calls: [{ function: fn }] };
};

const run = (rt: ReturnType<typeof fakeRuntime>, extra: Partial<MeasureInput> = {}) => {
  const data = dir();
  return measureModel({
    baseUrl: "http://runtime", model: "m", fetch: rt.fetcher, signal: new AbortController().signal,
    sources: ensureFixtures(data), numCtx: 8192, platform: "win32", ...extra,
  });
};
const check = (m: { checks: readonly ModelMeasure["checks"][number][] }, id: string) => m.checks.find((c) => c.id === id)!;

describe("Measure's fixtures", () => {
  it("hold the facts the checks ask about", async () => {
    const [notes, shop] = ensureFixtures(dir());
    const read = (name: string) => readFileSync(path.join(notes!.path, name), "utf8");
    expect(read("to-do.md")).toMatch(/1\. Renew the boat insurance/);
    expect(readdirSync(notes!.path).filter((f) => statSync(path.join(notes!.path, f)).isFile())).toHaveLength(6);
    const amounts = read("expenses.csv").trim().split("\n").slice(1).map((l) => Number(l.split(",").at(-1)));
    expect(Math.round(amounts.reduce((a, b) => a + b, 0) * 100) / 100).toBe(412.35);
    expect(read("meeting-notes.md")).toMatch(/inspection was set for 2 March[\s\S]*inspection moved to 14 March/);
    expect(read("meeting-notes.md").length).toBeGreaterThan(5000);
    expect(read("archive/2023/boat.md")).toContain("Sea Lark");
    expect(read("contacts.md")).toMatch(/Ana Silva: our main client in Lisbon/);
    // every database check's reference query gives a row that passes its grade
    for (const c of CASES) {
      if (c.kind !== "answer" || !c.db) continue;
      const sql = c.reference.calls.flatMap((x) => "sql" in x ? [x.sql] : []).at(-1)!;
      const rows = await runSnapshotQuery({ file: shop!.snapshotPath!, query: sql, limit: 5, signal: new AbortController().signal });
      const steps = [{ callId: "1", name: "read", state: "done" as const, summary: "" }, { callId: "2", name: "sql", state: "done" as const, summary: "" }];
      const answer = c.id === "tools-chain" ? `Ana Silva: ${JSON.stringify(rows[0])}` : JSON.stringify(rows[0]);
      expect(c.grade({ answer, steps }), c.id).toBeUndefined();
    }
  });

  it("weigh to 100, with a budget for each part", () => {
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    expect(new Set(CASES.map((c) => c.part))).toEqual(new Set(Object.keys(BUDGET)));
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
  });
});

describe("grading words", () => {
  it("reads numbers with thousands commas and decimals, not inside words", () => {
    expect(numbersIn("1,204.50 and 3 or v2 and 412.35.")).toEqual([1204.5, 3, 412.35]);
  });

  it("finds the page in a reply: an html block, any block that is a page, or a reply that is one", () => {
    expect(pageIn("Here:\n```html\n<p>a</p>\n```\nDone.")).toBe("<p>a</p>");
    expect(pageIn("```\n<!doctype html><p>b</p>\n```")).toBe("<!doctype html><p>b</p>");
    expect(pageIn("```css\np{}\n```\n```HTML\n<p>c</p>\n```")).toBe("<p>c</p>");
    expect(pageIn("Sure. <!DOCTYPE html><html><p>d</p></html>")).toBe("<!DOCTYPE html><html><p>d</p></html>");
    expect(pageIn("No page here.")).toBeUndefined();
  });

  it("takes a small whole number written as a word, and stays strict otherwise", () => {
    const carry = CASES.find((c) => c.id === "instr-carry")! as Extract<MeasureCase, { kind: "answer" }>;
    const graded = (answer: string) => carry.grade({ answer, steps: [] });
    // a night run's reply, marked "The answer was not 14."
    expect(graded("Fourteen. OVER")).toBeUndefined();
    expect(graded("It is fourteen OVER")).toBeUndefined();
    expect(graded("Fourteen hundred. OVER")).toBe("The answer was not 14.");
    expect(graded("14.5 OVER")).toBe("The answer was not 14.");
    expect(graded("Twenty-fourteen OVER")).toBe("The answer was not 14.");
    const count = CASES.find((c) => c.id === "tools-count")! as Extract<MeasureCase, { kind: "answer" }>;
    const read = [{ callId: "1", name: "read", state: "done" as const, summary: "" }];
    expect(count.grade({ answer: "There are six files.", steps: read })).toBeUndefined();
    expect(count.grade({ answer: "There are sixty files.", steps: read })).toBe("The count, 6, was not given.");
  });
});

describe("measureModel", () => {
  it("passes a model that does each check right through the chat's loop and the real tools, and leaves its pages for a window", async () => {
    const rt = fakeRuntime(["completion", "tools"], reference(true));
    const steps: number[] = [];
    const m = await run(rt, { onStep: (done) => steps.push(done), now: () => 5 });
    const answers = CASES.filter((c) => c.kind === "answer");
    expect(m.checks.filter((c) => c.state === undefined && !c.ok).map((c) => [c.id, c.why])).toEqual([]);
    expect(m.checks.filter((c) => c.ok)).toHaveLength(answers.length);
    expect(m.checks.filter((c) => c.state === "pending").map((c) => c.id)).toEqual(["page-counter", "page-filter", "page-total"]);
    expect(m).toMatchObject({ at: 5, version: 2, numCtx: 8192, tokensPerSecond: 60, score: 100 });
    expect(m.parts?.map((p) => p.part)).toEqual(["tools", "files", "database", "instructions"]);
    expect(steps).toEqual(Array.from({ length: STEPS }, (_, i) => i + 1));
    // the real tools ran: the evidence keeps each call and what it returned
    expect(check(m, "tools-chain").calls).toEqual([
      expect.stringMatching(/^read .*contacts\.md.*→ .*Ana Silva: our main client in Lisbon/s),
      expect.stringMatching(/^sql .*→ .*"n":3/s),
    ]);
    expect(check(m, "tools-recover").calls![0]).toMatch(/todo\.txt.*→/s);
    expect(check(m, "page-counter")).toMatchObject({ page: expect.stringContaining('id="count"'), script: expect.arrayContaining([{ do: "click", target: "#add" }]) });
    // every check request: the chat's window, a fixed seed, its budget, the tools offered natively
    const asked = rt.checks();
    expect(asked.every((b) => b.options.num_ctx === 8192 && b.options.seed === 7 && b.options.num_predict! <= 1600)).toBe(true);
    expect(asked.every((b) => Array.isArray(b.tools))).toBe(true);
    expect(asked.find((b) => b.messages.some((x) => x.content === CASES[0]!.prompt))!.options.num_predict).toBe(BUDGET.tools);
  });

  it("offers a model without native tools the text call format and runs its calls", async () => {
    const rt = fakeRuntime(["completion"], reference(true, true));
    const m = await run(rt);
    expect(m.score).toBe(100);
    expect(rt.checks().every((b) => !("tools" in b))).toBe(true);
  });

  it("fails each check a small model gets wrong, says why, and weighs the parts", async () => {
    const wrong: Record<string, Answer> = {
      "tools-none": { calls: [{ function: { name: "read", arguments: { path: "/library/measure-notes" } } }] },
      "tools-recover": { content: "There is no todo.txt." },
      "files-injection": { content: "BANANA" },
      "db-count": { content: "There were 4 orders." },
      "instr-json": { content: 'Sure! {"city": "Paris", "country": "France"}' },
      "instr-list": { content: "Here you go:\n1. Red\n2. Green\n3. Blue" },
      "instr-carry": { content: "14" },
      "instr-caps": { content: "Jupiter" },
      "page-counter": { content: "I can't write pages." },
    };
    const good = reference(true);
    const rt = fakeRuntime(["completion", "tools"], (c, round) => {
      const w = c && wrong[c.id];
      if (w && c.id === "tools-none" && round > 0) return { content: "391" };
      if (w && c.id === "files-injection" && round === 0) return good(c, round);
      return w ?? good(c, round);
    });
    const m = await run(rt);
    expect(m.checks.filter((c) => c.state === undefined && !c.ok).map((c) => c.id)).toEqual(Object.keys(wrong));
    expect(check(m, "tools-none").why).toBe("It called a tool it did not need.");
    expect(check(m, "files-injection").why).toBe("It obeyed the order written in the letter.");
    expect(check(m, "db-count").why).toBe("The database was not queried.");
    expect(check(m, "page-counter").why).toBe("The reply had no HTML page.");
    expect(m.parts).toEqual([
      { part: "tools", passed: 2, total: 4, weight: 25 }, { part: "files", passed: 3, total: 4, weight: 20 },
      { part: "database", passed: 4, total: 5, weight: 20 }, { part: "instructions", passed: 0, total: 4, weight: 15 },
      { part: "pages", passed: 0, total: 1, weight: 20 },
    ]);
    expect(m.score).toBe(Math.round(100 * (25 * 0.5 + 20 * 0.75 + 20 * 0.8) / 100));
  });

  it("cuts a check at its token budget, thinking included, keeps the start and end of a long reply, and sends nothing past it", async () => {
    const rt = fakeRuntime(["completion", "tools", "thinking"], (c, round, body) => {
      if (c?.id === "instr-json") return { thinking: "hmm ".repeat(50), content: "", evalCount: body.options.num_predict, doneReason: "length" };
      if (c?.id === "tools-recover") return round === 0 ? { calls: [{ function: { name: "read", arguments: { path: "/library/measure-notes" } } }], evalCount: BUDGET.tools } : { content: "never sent" };
      if (c?.id === "instr-caps") return { content: `JUPITER ${"A".repeat(3000)} END` };
      return reference(true)(c, round);
    });
    const m = await run(rt, { think: true });
    expect(check(m, "instr-json")).toMatchObject({ ok: false, cut: true, tokens: BUDGET.instructions, why: "It used its whole token budget before it answered." });
    expect(check(m, "tools-recover")).toMatchObject({ ok: false, cut: true, tokens: BUDGET.tools });
    const recover = CASES.find((c) => c.id === "tools-recover")!.prompt;
    expect(rt.checks().filter((b) => b.messages.some((x) => x.content === recover))).toHaveLength(1);
    const caps = check(m, "instr-caps");
    expect(caps.reply!.length).toBeLessThan(900);
    expect(caps.reply).toMatch(/^JUPITER[\s\S]*characters[\s\S]*END$/);
    // thinking as the chat has it, sent to a model that can think
    expect(rt.checks().every((b) => b.think === true)).toBe(true);
    expect(m.think).toBe(true);
  });

  it("sends no think flag to a model that cannot think, and marks a slow model beside its score", async () => {
    const rt = fakeRuntime(["completion", "tools"], (c, round) => ({ ...reference(true)(c, round), evalCount: 40, evalNs: 8e9 }));
    const m = await run(rt, { think: true });
    expect(rt.bodies.every((b) => !("think" in b))).toBe(true);
    expect(m).toMatchObject({ tokensPerSecond: 5, slow: "decode", score: 100 });
    expect(m.think).toBeUndefined();
  });

  it("marks a model slow to its first word, from the middle check", async () => {
    let t = 0;
    const rt = fakeRuntime(["completion", "tools"], (c, round) => { t += 12_000; return reference(true)(c, round); });
    const m = await run(rt, { now: () => t });
    expect(m.firstTokenMs).toBeGreaterThan(10_000);
    expect(m.slow).toBe("first-token");
  });

  it("skips the database checks when Run commands is off on Linux, and scores the rest", async () => {
    const rt = fakeRuntime(["completion", "tools"], reference(false));
    const m = await run(rt, { platform: "linux", shell: { state: "off", word: "Sandbox check failed" } });
    const skipped = CASES.filter((c) => c.db).map((c) => c.id);
    expect(m.checks.filter((c) => c.state === "skipped").map((c) => c.id)).toEqual(skipped);
    expect(m.parts?.find((p) => p.part === "database")).toBeUndefined();
    expect(m.parts?.find((p) => p.part === "tools")).toMatchObject({ total: 3 });
    // the database is not offered, so no check turn says it can't be read
    expect(rt.checks().every((b) => !b.messages[0]!.content.includes("measure-shop"))).toBe(true);
    expect(m.score).toBe(100);
  });

  it("stops on a runtime error, saying what the runtime said", async () => {
    const fetcher = (async (url: URL | string) =>
      new URL(String(url)).pathname === "/api/show" ? Response.json({ capabilities: [] }) : new Response("model requires more system memory", { status: 500 })) as typeof fetch;
    await expect(measureModel({ baseUrl: "http://runtime", model: "m", fetch: fetcher, signal: new AbortController().signal, sources: [], numCtx: 4096 })).rejects.toThrow(/more system memory/);
  });

  it("stops at a check whose turn failed on the runtime, rather than grading it wrong", async () => {
    const rt = fakeRuntime(["completion", "tools"], reference(true));
    const fifth = CASES[4]!.prompt;
    const fetcher = (async (url: URL | string, init?: RequestInit) => {
      // the runtime goes away at the fifth check: every request from there fails
      if (String(init?.body ?? "").includes(JSON.stringify(fifth).slice(1, -1)) || rt.checks().some((b) => b.messages.some((m) => m.content === fifth))) throw new TypeError("fetch failed");
      return rt.fetcher(url, init);
    }) as typeof fetch;
    await expect(run({ ...rt, fetcher })).rejects.toThrow(/^Measure stopped at check 5 of 20: fetch failed$/);
  });
});

const pending = async () => run(fakeRuntime(["completion", "tools"], reference(true)));

/** Waits for the n-th run to end (done or error). */
const endings = (pushes: [string, unknown][], n: number) => new Promise<void>((resolve) => {
  const tick = () => pushes.filter(([c, p]) => c === "models.measuring" && ["done", "error"].includes((p as MeasureRun).state)).length >= n ? resolve() : setTimeout(tick, 5);
  tick();
});

describe("page grading", () => {
  it("passes each page on what a window saw, fails one that did wrong or could not run, and scores again", async () => {
    const m = { model: "m", digest: "d", ...await pending() };
    const graded = gradePages(m, [
      { id: "page-counter", seen: ["0", "3"] },
      { id: "page-filter", seen: ["Apple|Banana|Cherry|Date|Elderberry|Fig|Grape", "Cherry|Elderberry", "Apple|Banana|Cherry|Date|Elderberry|Fig|Grape"] },
      { id: "page-total", seen: ["37.5", "50"], },
    ]);
    expect(graded.checks.filter((c) => c.kind === "pages").map((c) => [c.id, c.ok, c.state])).toEqual([["page-counter", true, undefined], ["page-filter", true, undefined], ["page-total", false, undefined]]);
    expect(check(graded, "page-total").why).toBe("12.5 times 3 did not show 37.50.");
    expect(graded.parts?.at(-1)).toEqual({ part: "pages", passed: 2, total: 3, weight: 20 });
    expect(graded.score).toBe(scoreOf(partsOf(graded.checks)));
    expect(graded.score).toBe(Math.round(80 + 20 * (2 / 3)));
    const broken = gradePages(m, [{ id: "page-counter", seen: [], error: "The page left for another address." }]);
    expect(check(broken, "page-counter")).toMatchObject({ ok: false, why: "The page left for another address." });
    expect(check(broken, "page-filter").state).toBe("pending");
  });

  it("a page the window skipped is skipped with its reason, and the score is the one with no Pages part, not lower", async () => {
    const m = { model: "m", digest: "d", ...await pending() };
    const why = "Pages were not run: Chromium's sandbox is off in this copy.";
    const skipped = gradePages(m, ["page-counter", "page-filter", "page-total"].map((id) => ({ id, seen: [], skipped: why })));
    expect(skipped.checks.filter((c) => c.kind === "pages").map((c) => [c.state, c.why, c.ok, c.page, c.script])).toEqual(Array.from({ length: 3 }, () => ["skipped", why, false, undefined, undefined]));
    const noPages = partsOf(m.checks.filter((c) => c.kind !== "pages"));
    expect(skipped.parts).toEqual(noPages);
    expect(skipped.score).toBe(scoreOf(noPages));
    // a failed page would lower it: the skip does not
    const failed = gradePages(m, ["page-counter", "page-filter", "page-total"].map((id) => ({ id, seen: [], error: why })));
    expect(failed.score).toBeLessThan(skipped.score);
    expect(skipped.score).toBe(100);
  });
});

describe("models.measure", () => {
  const info = { name: "m", digest: "sha256:abc", sizeBytes: 1, maxContext: 4096 } as unknown as ModelInfo;
  function setup(verdict: "fits" | "refuse", pageWaitMs = 5_000, extra: Pick<MeasureDeps, "loader"> = {}) {
    const pushes: [string, unknown][] = [];
    const kinds: string[] = [];
    let released = 0;
    const rt = fakeRuntime(["completion", "tools", "thinking"], reference(true));
    /** `at`: from the request that asks this check on, the runtime is gone. `onCheck`: runs at each check's first request. */
    const broken: { at?: string; onCheck?: () => void } = {};
    let failing = false;
    const fetcher = (async (url: URL | string, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      const asks = CASES.some((c) => body.includes(JSON.stringify(c.prompt).slice(1, -1)));
      if (asks) broken.onCheck?.();
      if (broken.at !== undefined && body.includes(JSON.stringify(broken.at).slice(1, -1))) failing = true;
      if (failing && (asks || new URL(String(url)).pathname === "/api/show")) throw new TypeError("fetch failed");
      return rt.fetcher(url, init);
    }) as typeof fetch;
    const dataDir = dir();
    const measure = createMeasure({
      ...extra,
      dataDir,
      baseUrl: () => "http://runtime",
      installed: async () => [info],
      plan: async () => ({ verdict, message: verdict === "refuse" ? "m needs 20 GB; this computer has 16 GB." : undefined }) as unknown as FitReport,
      push: ((channel: string, payload: unknown) => pushes.push([channel, payload])) as Push,
      lease: { acquire: async (kind) => { kinds.push(kind); return () => { released += 1; }; } },
      settings: { get: () => ({ defaultNumCtx: 8192, thinking: false, theme: "dark", runtimeMode: "system", tools: true, imageGen: false, systemPrompt: "Talk like a pirate." }) },
      platform: "win32",
      fetch: fetcher,
      pageWaitMs,
    });
    const until = (states: string[]) => new Promise<void>((resolve) => {
      const tick = () => pushes.some(([c, p]) => c === "models.measuring" && states.includes((p as MeasureRun).state)) ? resolve() : setTimeout(tick, 5);
      tick();
    });
    const saved = () => new Promise<ModelMeasure>((resolve) => {
      const tick = () => { const s = measure.handlers["models.measures"]().measures[0]; if (s) resolve(s); else setTimeout(tick, 5); };
      tick();
    });
    return { measure, pushes, kinds, released: () => released, ended: () => until(["done", "error"]), saved, rt, broken, dataDir };
  }

  it("answers at once, holds the GPU alone, measures at the chat's window and setting, then waits for a window to run its pages", async () => {
    const t = setup("fits");
    const first = await t.measure.handlers["models.measure"]({ name: "m" });
    expect(first).toEqual({ model: "m", state: "waiting", done: 0, total: STEPS + 1 });
    await expect(t.measure.handlers["models.measure"]({ name: "m" })).rejects.toMatchObject({ code: "measure-busy" });
    const saved = await t.saved();
    expect(saved.checks.filter((c) => c.state === undefined && !c.ok).map((c) => [c.id, c.why, c.reply, c.calls])).toEqual([]);
    expect(saved).toMatchObject({ model: "m", digest: "sha256:abc", numCtx: 4096, think: false, score: 100 });
    // the window: the default context capped at the model's own; the person's system prompt left out
    expect(t.rt.checks().every((b) => b.options.num_ctx === 4096 && b.think === false && !b.messages[0]!.content.includes("pirate"))).toBe(true);
    // the GPU is given back before the wait for pages; the run is not done until they are graded
    expect(t.kinds).toEqual(["bench"]);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.released()).toBe(1);
    expect(t.pushes.filter(([c]) => c === "models.measuring").at(-1)?.[1]).toMatchObject({ state: "running", done: STEPS });
    expect(() => t.measure.handlers["models.measurePages"]({ model: "m", at: saved.at + 1, pages: [] })).toThrow(expect.objectContaining({ code: "not-measured" }));
    const graded = t.measure.handlers["models.measurePages"]({ model: "m", at: saved.at, pages: [
      { id: "page-counter", seen: ["0", "3"] }, { id: "page-filter", seen: [], error: "The page did not finish within 5 seconds." }, { id: "page-total", seen: ["37.50", "50.00"] },
    ] });
    expect(graded.parts?.at(-1)).toMatchObject({ part: "pages", passed: 2, total: 3 });
    await t.ended();
    expect(t.pushes.filter(([c]) => c === "models.measuring").at(-1)?.[1]).toMatchObject({ state: "done", done: STEPS + 1 });
    expect(t.pushes.filter(([c]) => c === "models.measures").at(-1)?.[1]).toEqual([graded]);
    // a finished run lets the next one start
    await expect(t.measure.handlers["models.measure"]({ name: "m" })).resolves.toMatchObject({ state: "waiting" });
  });

  it("one window at a time holds the pages: the starter first while connected, else the first to ask, and a closed holder lets them go", async () => {
    const t = setup("fits");
    const starter = new AbortController();
    const a = new AbortController();
    const b = new AbortController();
    const claim = (clientId: number, signal: AbortSignal, at: number) => t.measure.handlers["models.measurePagesClaim"]({ model: "m", at }, { clientId, signal }).claimed;
    await t.measure.handlers["models.measure"]({ name: "m" }, { clientId: 1, signal: starter.signal });
    const saved = await t.saved();
    // the starter is connected: another window is refused, the starter holds them
    expect(claim(2, a.signal, saved.at)).toBe(false);
    expect(claim(1, starter.signal, saved.at)).toBe(true);
    // the starter reloads: its hold goes, the list is pushed again, and the first to ask holds them
    const pushed = t.pushes.filter(([c]) => c === "models.measures").length;
    starter.abort();
    expect(t.pushes.filter(([c]) => c === "models.measures").length).toBe(pushed + 1);
    expect(claim(2, a.signal, saved.at)).toBe(true);
    expect(claim(3, b.signal, saved.at)).toBe(false);
    expect(claim(2, a.signal, saved.at + 1)).toBe(false);
    // a window that does not hold them cannot send them
    const pages = [{ id: "page-counter", seen: ["0", "3"] }, { id: "page-filter", seen: [] }, { id: "page-total", seen: [] }];
    expect(() => t.measure.handlers["models.measurePages"]({ model: "m", at: saved.at, pages }, { clientId: 3 })).toThrow(expect.objectContaining({ code: "not-claimed" }));
    t.measure.handlers["models.measurePages"]({ model: "m", at: saved.at, pages }, { clientId: 2 });
    await t.ended();
    // the run no longer waits: nobody holds them
    expect(claim(3, b.signal, saved.at)).toBe(false);
  });

  it("skips the pages no window ran while it waited, says why, leaves them out of the score, and refuses them later", async () => {
    const t = setup("fits", 10);
    await t.measure.handlers["models.measure"]({ name: "m" });
    await t.ended();
    const { measures: [saved] } = t.measure.handlers["models.measures"]();
    expect(saved!.checks.filter((c) => c.kind === "pages").map((c) => [c.state, c.why])).toEqual(Array.from({ length: 3 }, () => ["skipped", PAGES_UNRUN]));
    expect(saved!.parts?.map((p) => p.part)).toEqual(["tools", "files", "database", "instructions"]);
    expect(saved!.score).toBe(100);
    expect(t.pushes.filter(([c]) => c === "models.measures").at(-1)?.[1]).toEqual([saved]);
    expect(t.pushes.filter(([c]) => c === "models.measuring").at(-1)?.[1]).toMatchObject({ state: "done" });
    expect(() => t.measure.handlers["models.measurePages"]({ model: "m", at: saved!.at, pages: [{ id: "page-counter", seen: ["0", "3"] }] })).toThrow(expect.objectContaining({ code: "not-waiting" }));
  });

  it("a window that could not run the pages says so, and the store keeps them skipped with its reason", async () => {
    const t = setup("fits");
    await t.measure.handlers["models.measure"]({ name: "m" });
    const saved = await t.saved();
    const why = "Pages were not run: Chromium's sandbox is off in this copy.";
    t.measure.handlers["models.measurePages"]({ model: "m", at: saved.at, pages: ["page-counter", "page-filter", "page-total"].map((id) => ({ id, seen: [], skipped: why })) });
    // the run does not wait out its time for pages nobody will run
    await t.ended();
    const kept = measureStore(t.dataDir).list()[0]!;
    expect(kept.checks.filter((c) => c.kind === "pages").map((c) => [c.state, c.why])).toEqual(Array.from({ length: 3 }, () => ["skipped", why]));
    expect(kept.parts?.map((p) => p.part)).toEqual(["tools", "files", "database", "instructions"]);
    expect(kept.score).toBe(100);
    expect(t.pushes.filter(([c]) => c === "models.measuring").at(-1)?.[1]).toMatchObject({ state: "done" });
  });

  it("shows a page an earlier build left waiting as skipped", () => {
    const d = dir();
    const waiting = { model: "w", digest: "d", at: 1, version: 2 as const, numCtx: 4096, tokensPerSecond: 50, score: 100, checks: [{ id: "page-counter", kind: "pages" as const, ok: false, state: "pending" as const, page: "<p></p>", script: [] }] };
    measureStore(d).put(waiting);
    const measure = createMeasure({ dataDir: d, baseUrl: () => undefined, installed: async () => [], plan: async () => ({}) as FitReport, push: (() => undefined) as Push });
    expect(measure.handlers["models.measures"]().measures[0]!.checks[0]).toMatchObject({ state: "skipped", why: PAGES_UNRUN });
  });

  it("answers the measures read with the run going now, and with none once it is done", async () => {
    const t = setup("fits");
    expect(t.measure.handlers["models.measures"]()).toEqual({ measures: [] });
    await t.measure.handlers["models.measure"]({ name: "m" });
    expect(t.measure.handlers["models.measures"]().run).toEqual({ model: "m", state: "waiting", done: 0, total: STEPS + 1 });
    const saved = await t.saved();
    await new Promise((r) => setTimeout(r, 20));
    // waiting for its pages: the run's last step
    expect(t.measure.handlers["models.measures"]()).toEqual({ measures: [saved], run: { model: "m", state: "running", done: STEPS, total: STEPS + 1 } });
    t.measure.handlers["models.measurePages"]({ model: "m", at: saved.at, pages: [{ id: "page-counter", seen: ["0", "3"] }, { id: "page-filter", seen: [] }, { id: "page-total", seen: [] }] });
    await t.ended();
    expect(t.measure.handlers["models.measures"]().run).toBeUndefined();
  });

  it("a run whose turns fail on the runtime ends as an error, saves nothing, and the earlier measure stays", async () => {
    const t = setup("fits", 10);
    await t.measure.handlers["models.measure"]({ name: "m" });
    await endings(t.pushes, 1);
    const earlier = t.measure.handlers["models.measures"]().measures;
    expect(earlier).toHaveLength(1);
    // the runtime crashes: every check's request fails from the first one
    t.broken.at = CASES[0]!.prompt;
    await t.measure.handlers["models.measure"]({ name: "m" });
    await endings(t.pushes, 2);
    const stopped = { model: "m", state: "error", done: 0, total: STEPS + 1, message: "Measure stopped at check 1 of 20: fetch failed" };
    expect(t.pushes.filter(([c]) => c === "models.measuring").at(-1)?.[1]).toEqual(stopped);
    expect(t.measure.handlers["models.measures"]()).toEqual({ measures: earlier, run: stopped });
    expect(measureStore(t.dataDir).list()).toEqual(earlier);
    expect(t.pushes.filter(([c]) => c === "models.measures")).toHaveLength(2);
  });

  it("a runtime switch stops a running measure the way it ends a chat turn, and waits for its end", async () => {
    const gone = new AbortController();
    let ends = 0;
    const loader = { reserve: () => ({ signal: gone.signal, end: () => { ends += 1; } }) as unknown as TurnReservation };
    const t = setup("fits", 10, { loader });
    t.broken.onCheck = () => gone.abort(new Error("The runtime is switching."));
    await t.measure.handlers["models.measure"]({ name: "m" });
    await t.ended();
    expect(t.pushes.filter(([c]) => c === "models.measuring").at(-1)?.[1]).toMatchObject({ state: "error", message: "The Ollama runtime changed while Measure ran, so it stopped." });
    expect(ends).toBe(1);
    expect(t.released()).toBe(1);
    expect(t.measure.handlers["models.measures"]().measures).toEqual([]);
  });

  it("refuses to start while the runtime switches", async () => {
    const loader = { reserve: () => { throw new ModelActionError("runtime-switching", "The Ollama runtime is switching. Try again in a moment."); } };
    const t = setup("fits", 10, { loader });
    await expect(t.measure.handlers["models.measure"]({ name: "m" })).rejects.toMatchObject({ code: "runtime-switching" });
    expect(t.kinds).toEqual([]);
    await expect(t.measure.handlers["models.measure"]({ name: "m" })).rejects.toMatchObject({ code: "runtime-switching" });
  });

  it("sends nothing to the model when the fit check refuses, and says why", async () => {
    const t = setup("refuse");
    await t.measure.handlers["models.measure"]({ name: "m" });
    await t.ended();
    expect(t.rt.bodies).toEqual([]);
    expect(t.pushes.filter(([c]) => c === "models.measuring").at(-1)?.[1]).toMatchObject({ state: "error", message: "m needs 20 GB; this computer has 16 GB." });
    expect(t.released()).toBe(1);
    expect(t.measure.handlers["models.measures"]().measures).toEqual([]);
  });

  it("refuses a model that is not installed before taking anything", async () => {
    const t = setup("fits");
    await expect(t.measure.handlers["models.measure"]({ name: "other" })).rejects.toMatchObject({ code: "not-installed" });
    expect(t.kinds).toEqual([]);
  });

  /** The memory owner over a runtime where `idle` sits in memory until it is asked to leave. */
  function withOwner(verdict: "fits" | "refuse") {
    const order: string[] = [];
    let listed: LoadedModel[] = [{ name: "idle:7b", sizeBytes: 1, sizeVramBytes: 1 }];
    const rt = fakeRuntime(["completion", "tools"], reference(true));
    const fetcher = (async (url: URL | string, init?: RequestInit) => {
      if (new URL(String(url)).pathname === "/api/generate") {
        const body = JSON.parse(String(init?.body)) as { model: string; keep_alive: number };
        order.push(`unload ${body.model}`);
        listed = listed.filter((m) => m.name !== body.model);
        return Response.json({ done: true });
      }
      return rt.fetcher(url, init);
    }) as typeof fetch;
    const owner = createMemoryOwner({ ollamaUrl: () => "http://runtime", listLoaded: async () => listed, replying: () => [], fetch: fetcher, waitMs: 50, pollMs: 1 });
    const pushes: [string, unknown][] = [];
    const measure = createMeasure({
      dataDir: dir(),
      baseUrl: () => "http://runtime",
      installed: async () => [info],
      plan: async (_b, _m, _n, _s, measured) => {
        order.push(`plan ${measured === true ? "measured" : "beside"}`);
        return { verdict, message: verdict === "refuse" ? "m needs 20 GB; this computer has 16 GB." : undefined } as unknown as FitReport;
      },
      push: ((channel: string, payload: unknown) => pushes.push([channel, payload])) as Push,
      lease: { acquire: async (kind) => { order.push(`lease ${kind}`); return () => undefined; } },
      memory: owner,
      platform: "win32",
      fetch: fetcher,
      pageWaitMs: 10,
    });
    const ended = () => new Promise<void>((resolve) => {
      const tick = () => pushes.some(([c, p]) => c === "models.measuring" && ["done", "error"].includes((p as MeasureRun).state)) ? resolve() : setTimeout(tick, 5);
      tick();
    });
    return { measure, owner, order, rt, ended };
  }

  it("asks an idle model in memory to leave before it plans and loads, and then says the measured model is the one in memory", async () => {
    const t = withOwner("fits");
    await t.measure.handlers["models.measure"]({ name: "m" });
    await t.ended();
    expect(t.order).toEqual(["lease bench", "unload idle:7b", "plan measured"]);
    expect(t.owner.status()).toEqual({ resident: { kind: "chat", model: "m:latest", numCtx: 4096, since: expect.any(Number) } });
  });

  it("a refused measure loads nothing and leaves no handoff open", async () => {
    const t = withOwner("refuse");
    await t.measure.handlers["models.measure"]({ name: "m" });
    await t.ended();
    expect(t.rt.bodies).toEqual([]);
    expect(t.order).toEqual(["lease bench", "unload idle:7b", "plan measured"]);
    expect(t.owner.status()).toEqual({});
  });
});

/**
 * v0.2.4's measures file, as that release reads it (`git show v0.2.4:packages/contracts/src/shapes.ts`
 * and `git show v0.2.4:apps/server/src/measure/store.ts`): one check it cannot read and the whole file
 * reads as empty there, and its next Measure rewrites the file with one result.
 */
const V024Check = S.Struct({ id: S.String, kind: S.Literals(["tools", "sql"]), ok: S.Boolean });
const V024Measure = S.Struct({
  model: S.String,
  digest: S.String,
  at: S.Finite,
  numCtx: S.Int,
  tokensPerSecond: S.Finite.check(S.isGreaterThanOrEqualTo(0)),
  score: S.Int.check(S.isBetween({ minimum: 0, maximum: 100 })),
  checks: S.Array(V024Check),
});
const decodeV024 = S.decodeUnknownSync(S.Struct({ version: S.Literal(1), measures: S.Array(V024Measure) }));

describe("measureStore", () => {
  it("never writes a check 0.2.4 cannot read into the file 0.2.4 reads, and reads that file for older measures", async () => {
    const d = dir();
    const old = { model: "old", digest: "d", at: 1, numCtx: 4096, tokensPerSecond: 50, score: 75, checks: [{ id: "tools-weather", kind: "tools" as const, ok: true }] };
    writeFileSync(path.join(d, "measures.json"), `${JSON.stringify({ version: 1, measures: [old] })}\n`);
    const store = measureStore(d);
    store.put({ model: "m", digest: "d", ...await run(fakeRuntime(["completion", "tools"], reference(true))) });
    // rolled back to 0.2.4: its file still reads, with its measure
    expect(decodeV024(JSON.parse(readFileSync(path.join(d, "measures.json"), "utf8"))).measures).toEqual([old]);
    // this build: the new measure, and the older one from the old file
    expect(measureStore(d).list().map((m) => [m.model, m.version])).toEqual([["old", undefined], ["m", 2]]);
    // a new measure of the old file's model wins over the old one
    store.put({ ...old, version: 2, score: 90 });
    expect(measureStore(d).list().map((m) => [m.model, m.score])).toEqual([["m", 100], ["old", 90]]);
    expect(decodeV024(JSON.parse(readFileSync(path.join(d, "measures.json"), "utf8"))).measures).toEqual([old]);
  });

  it("keeps a saved measure it cannot read when it writes the file again", () => {
    const d = dir();
    const later = { model: "later", digest: "d", at: 1, version: 3, numCtx: 4096, tokensPerSecond: 50, score: 75, checks: [{ id: "x", kind: "video", ok: true }] };
    const store = measureStore(d);
    store.put({ model: "a", digest: "d", at: 1, numCtx: 4096, tokensPerSecond: 50, score: 80, checks: [] });
    const file = readdirSync(d).find((f) => f !== "measures.json" && f.startsWith("measures"))!;
    const saved = JSON.parse(readFileSync(path.join(d, file), "utf8")) as { measures: unknown[] };
    writeFileSync(path.join(d, file), JSON.stringify({ ...saved, measures: [...saved.measures, later] }));
    const again = measureStore(d);
    expect(again.list().map((m) => m.model)).toEqual(["a"]);
    again.put({ model: "b", digest: "d", at: 1, numCtx: 4096, tokensPerSecond: 50, score: 80, checks: [] });
    expect((JSON.parse(readFileSync(path.join(d, file), "utf8")) as { measures: { model: string }[] }).measures.map((m) => m.model)).toEqual(["a", "b", "later"]);
  });

  it("keeps one measure per model, newest wins, and reads it back from disk", () => {
    const d = dir();
    const base = { digest: "d1", at: 1, numCtx: 4096, tokensPerSecond: 50, score: 80, checks: [] };
    const store = measureStore(d);
    expect(store.list()).toEqual([]);
    store.put({ ...base, model: "a" });
    store.put({ ...base, model: "b" });
    store.put({ ...base, model: "a", digest: "d2", score: 90 });
    expect(measureStore(d).list()).toEqual([{ ...base, model: "b" }, { ...base, model: "a", digest: "d2", score: 90 }]);
  });

  it("reads an older measure of eight checks beside a new one", async () => {
    const d = dir();
    const old = { model: "old", digest: "d", at: 1, numCtx: 4096, tokensPerSecond: 50, score: 75, checks: [
      { id: "tools-weather", kind: "tools" as const, ok: true }, { id: "sql-count", kind: "sql" as const, ok: false, reply: "SELECT 1", result: '{"1":1}' },
    ] };
    const store = measureStore(d);
    store.put(old);
    store.put({ model: "m", digest: "d", ...await run(fakeRuntime(["completion", "tools"], reference(true))) });
    expect(measureStore(d).list().map((m) => [m.model, m.version])).toEqual([["old", undefined], ["m", 2]]);
    expect(measureStore(d).list()[0]).toEqual(old);
  });
});
