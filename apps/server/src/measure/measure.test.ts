import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runSnapshotQuery } from "../../../../packages/harness/src/sql.ts";
import { BUDGET, CASES, WEIGHTS, ensureFixtures, numbersIn, pageIn, toolCallOf, type MeasureCase } from "./cases.ts";
import { STEPS, measureModel, type MeasureInput } from "./suite.ts";
import { gradePages, partsOf, scoreOf } from "./score.ts";
import { measureStore } from "./store.ts";
import { createMeasure } from "./handlers.ts";
import { createMemoryOwner } from "../gpu/memory.ts";
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
});

const pending = async () => run(fakeRuntime(["completion", "tools"], reference(true)));

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
});

describe("models.measure", () => {
  const info = { name: "m", digest: "sha256:abc", sizeBytes: 1, maxContext: 4096 } as unknown as ModelInfo;
  function setup(verdict: "fits" | "refuse", pageWaitMs = 5_000) {
    const pushes: [string, unknown][] = [];
    const kinds: string[] = [];
    let released = 0;
    const rt = fakeRuntime(["completion", "tools", "thinking"], reference(true));
    const measure = createMeasure({
      dataDir: dir(),
      baseUrl: () => "http://runtime",
      installed: async () => [info],
      plan: async () => ({ verdict, message: verdict === "refuse" ? "m needs 20 GB; this computer has 16 GB." : undefined }) as unknown as FitReport,
      push: ((channel: string, payload: unknown) => pushes.push([channel, payload])) as Push,
      lease: { acquire: async (kind) => { kinds.push(kind); return () => { released += 1; }; } },
      settings: { get: () => ({ defaultNumCtx: 8192, thinking: false, theme: "dark", runtimeMode: "system", tools: true, imageGen: false, systemPrompt: "Talk like a pirate." }) },
      platform: "win32",
      fetch: rt.fetcher,
      pageWaitMs,
    });
    const until = (states: string[]) => new Promise<void>((resolve) => {
      const tick = () => pushes.some(([c, p]) => c === "models.measuring" && states.includes((p as MeasureRun).state)) ? resolve() : setTimeout(tick, 5);
      tick();
    });
    const saved = () => new Promise<ModelMeasure>((resolve) => {
      const tick = () => { const s = measure.handlers["models.measures"]()[0]; if (s) resolve(s); else setTimeout(tick, 5); };
      tick();
    });
    return { measure, pushes, kinds, released: () => released, ended: () => until(["done", "error"]), saved, rt };
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

  it("ends with the pages pending when no window runs them, and a window opened later still can", async () => {
    const t = setup("fits", 10);
    await t.measure.handlers["models.measure"]({ name: "m" });
    await t.ended();
    const [saved] = t.measure.handlers["models.measures"]();
    expect(saved!.checks.filter((c) => c.state === "pending")).toHaveLength(3);
    expect(t.pushes.filter(([c]) => c === "models.measuring").at(-1)?.[1]).toMatchObject({ state: "done" });
    const later = t.measure.handlers["models.measurePages"]({ model: "m", at: saved!.at, pages: [{ id: "page-counter", seen: ["0", "3"] }] });
    expect(check(later, "page-counter").ok).toBe(true);
  });

  it("sends nothing to the model when the fit check refuses, and says why", async () => {
    const t = setup("refuse");
    await t.measure.handlers["models.measure"]({ name: "m" });
    await t.ended();
    expect(t.rt.bodies).toEqual([]);
    expect(t.pushes.filter(([c]) => c === "models.measuring").at(-1)?.[1]).toMatchObject({ state: "error", message: "m needs 20 GB; this computer has 16 GB." });
    expect(t.released()).toBe(1);
    expect(t.measure.handlers["models.measures"]()).toEqual([]);
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

describe("measureStore", () => {
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
