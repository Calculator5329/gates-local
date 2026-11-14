import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runSnapshotQuery } from "../../../../packages/harness/src/sql.ts";
import { CASES, MEASURE_CTX, ensureShopDb, measureModel } from "./suite.ts";
import { measureStore } from "./store.ts";
import { createMeasure } from "./handlers.ts";
import type { FitReport, MeasureRun, ModelInfo } from "@gates-local/contracts";
import type { Push } from "../app.ts";

const dir = () => mkdtempSync(path.join(tmpdir(), "measure-"));

type Answer = { content?: string; calls?: unknown[] };
/** A runtime that answers /api/show with `capabilities` and each /api/chat with `answer(prompt)`, streamed as NDJSON. */
function fakeRuntime(capabilities: string[], answer: (prompt: string, body: Record<string, unknown>) => Answer) {
  const bodies: Record<string, unknown>[] = [];
  const fetcher = (async (url: URL | string, init?: RequestInit) => {
    const route = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (route === "/api/show") return Response.json({ capabilities });
    bodies.push(body);
    const messages = body.messages as { role: string; content: string }[];
    const prompt = messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
    const a = answer(prompt, body);
    const lines = [
      { message: { role: "assistant", content: a.content ?? "", ...(a.calls ? { tool_calls: a.calls } : {}) }, done: false },
      { message: { role: "assistant", content: "" }, done: true, done_reason: "stop", eval_count: 120, eval_duration: 2e9, prompt_eval_count: 30 },
    ];
    return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }) as typeof fetch;
  return { fetcher, bodies };
}

/** The right call for each case, the way a strong model answers. */
function goodAnswer(prompt: string): Answer {
  const c = CASES.find((x) => x.prompt === prompt);
  if (!c) return { content: "A lighthouse stands on the rocks." };
  if (c.kind === "sql") return { calls: [{ function: { name: "sql", arguments: { query: c.reference } } }] };
  if (c.id === "tools-weather") return { calls: [{ function: { name: "get_weather", arguments: { city: "Lisbon" } } }] };
  if (c.id === "tools-convert") return { calls: [{ function: { name: "convert_currency", arguments: { amount: 250, from: "USD", to: "EUR" } } }] };
  return { content: "Paris" };
}

describe("the built-in shop database", () => {
  it("gives each question's stated answer from its reference query", async () => {
    const file = ensureShopDb(dir());
    for (const c of CASES) {
      if (c.kind !== "sql") continue;
      const rows = await runSnapshotQuery({ file, query: c.reference, limit: 5, signal: new AbortController().signal });
      expect(Object.values(rows[0] as object).map(String), c.id).toContain(String(c.answer));
    }
  });
});

describe("measureModel", () => {
  it("measures decode speed, passes a model that calls each tool right, and reports every step", async () => {
    const rt = fakeRuntime(["completion", "tools"], goodAnswer);
    const steps: number[] = [];
    const m = await measureModel({ baseUrl: "http://runtime", model: "m", fetch: rt.fetcher, signal: new AbortController().signal, dbFile: ensureShopDb(dir()), onStep: (done) => steps.push(done), now: () => 5 });
    expect(m.tokensPerSecond).toBe(60);
    expect(m.score).toBe(100);
    expect(m.checks.every((c) => c.ok)).toBe(true);
    expect(m.checks.map((c) => c.kind)).toEqual(CASES.map((c) => c.kind));
    expect(m).toMatchObject({ at: 5, numCtx: MEASURE_CTX });
    expect(steps).toEqual(Array.from({ length: CASES.length + 1 }, (_, i) => i + 1));
    // every request runs at the check's window, at temperature 0, with the tools offered natively
    expect(rt.bodies.every((b) => (b.options as { num_ctx: number; temperature: number }).num_ctx === MEASURE_CTX && (b.options as { temperature: number }).temperature === 0)).toBe(true);
    expect(rt.bodies.slice(1).every((b) => Array.isArray(b.tools))).toBe(true);
    expect(rt.bodies.every((b) => !("think" in b))).toBe(true);
  });

  it("fails a check for a wrong tool, wrong arguments, a needless call, a wrong query and a plain-text answer", async () => {
    const rt = fakeRuntime(["completion", "tools", "thinking"], (prompt) => {
      const c = CASES.find((x) => x.prompt === prompt);
      if (!c) return { content: "words" };
      if (c.id === "tools-weather") return { calls: [{ function: { name: "convert_currency", arguments: { amount: 1, from: "USD", to: "EUR" } } }] };
      if (c.id === "tools-convert") return { calls: [{ function: { name: "convert_currency", arguments: { amount: 25, from: "USD", to: "EUR" } } }] };
      if (c.id === "tools-none") return { calls: [{ function: { name: "get_weather", arguments: { city: "Paris" } } }] };
      if (c.id === "sql-count") return { calls: [{ function: { name: "sql", arguments: { query: "SELECT COUNT(*) FROM orders" } } }] };
      if (c.id === "sql-top") return { content: `The answer is ${c.kind === "sql" ? c.answer : ""}.` };
      return goodAnswer(prompt);
    });
    const m = await measureModel({ baseUrl: "http://runtime", model: "m", fetch: rt.fetcher, signal: new AbortController().signal, dbFile: ensureShopDb(dir()) });
    const failed = m.checks.filter((c) => !c.ok).map((c) => c.id);
    expect(failed).toEqual(["tools-weather", "tools-convert", "tools-none", "sql-count", "sql-top"]);
    expect(m.score).toBe(Math.round((100 * (CASES.length - 5)) / CASES.length));
    // a thinking model is asked not to think, so the check stays short
    expect(rt.bodies.every((b) => b.think === false)).toBe(true);
  });

  it("offers a model without native tools the text call format and reads its calls from the reply", async () => {
    const rt = fakeRuntime(["completion"], (prompt) => {
      const a = goodAnswer(prompt);
      const call = a.calls?.[0] as { function: unknown } | undefined;
      return call ? { content: `<tool_call>${JSON.stringify(call.function)}</tool_call>` } : a;
    });
    const m = await measureModel({ baseUrl: "http://runtime", model: "m", fetch: rt.fetcher, signal: new AbortController().signal, dbFile: ensureShopDb(dir()) });
    expect(m.score).toBe(100);
    expect(rt.bodies.every((b) => !("tools" in b))).toBe(true);
    expect(String((rt.bodies[1]!.messages as { content: string }[])[0]!.content)).toContain("<tool_call>");
  });

  it("stops on a runtime error, saying what the runtime said", async () => {
    const fetcher = (async (url: URL | string) =>
      new URL(String(url)).pathname === "/api/show" ? Response.json({ capabilities: [] }) : new Response(`${JSON.stringify({ error: "model requires more system memory" })}\n`)) as typeof fetch;
    await expect(measureModel({ baseUrl: "http://runtime", model: "m", fetch: fetcher, signal: new AbortController().signal, dbFile: ensureShopDb(dir()) })).rejects.toThrow(/more system memory/);
  });
});

describe("models.measure", () => {
  const info = { name: "m", digest: "sha256:abc", sizeBytes: 1 } as unknown as ModelInfo;
  function setup(verdict: "fits" | "refuse") {
    const pushes: [string, unknown][] = [];
    const kinds: string[] = [];
    let released = 0;
    const rt = fakeRuntime(["completion", "tools"], goodAnswer);
    const measure = createMeasure({
      dataDir: dir(),
      baseUrl: () => "http://runtime",
      installed: async () => [info],
      plan: async () => ({ verdict, message: verdict === "refuse" ? "m needs 20 GB; this computer has 16 GB." : undefined }) as unknown as FitReport,
      push: ((channel: string, payload: unknown) => pushes.push([channel, payload])) as Push,
      lease: { acquire: async (kind) => { kinds.push(kind); return () => { released += 1; }; } },
      fetch: rt.fetcher,
    });
    const ended = () => new Promise<void>((resolve) => {
      const tick = () => pushes.some(([c, p]) => c === "models.measuring" && ["done", "error"].includes((p as MeasureRun).state)) ? resolve() : setTimeout(tick, 5);
      tick();
    });
    return { measure, pushes, kinds, released: () => released, ended, rt };
  }

  it("answers at once, holds the GPU alone, refuses a second run, and saves the numbers against the digest", async () => {
    const t = setup("fits");
    const first = await t.measure.handlers["models.measure"]({ name: "m" });
    expect(first).toEqual({ model: "m", state: "waiting", done: 0, total: CASES.length + 1 });
    await expect(t.measure.handlers["models.measure"]({ name: "m" })).rejects.toMatchObject({ code: "measure-busy" });
    await t.ended();
    expect(t.kinds).toEqual(["bench"]);
    expect(t.released()).toBe(1);
    const saved = t.measure.handlers["models.measures"]();
    expect(saved).toMatchObject([{ model: "m", digest: "sha256:abc", score: 100 }]);
    expect(t.pushes.find(([c]) => c === "models.measures")?.[1]).toEqual(saved);
    expect(t.pushes.filter(([c]) => c === "models.measuring").at(-1)?.[1]).toMatchObject({ state: "done", done: CASES.length + 1 });
    // a finished run lets the next one start
    await expect(t.measure.handlers["models.measure"]({ name: "m" })).resolves.toMatchObject({ state: "waiting" });
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
});

describe("measureStore", () => {
  it("keeps one measure per model, newest wins, and reads it back from disk", () => {
    const d = dir();
    const base = { digest: "d1", at: 1, numCtx: MEASURE_CTX, tokensPerSecond: 50, score: 80, checks: [] };
    const store = measureStore(d);
    expect(store.list()).toEqual([]);
    store.put({ ...base, model: "a" });
    store.put({ ...base, model: "b" });
    store.put({ ...base, model: "a", digest: "d2", score: 90 });
    expect(measureStore(d).list()).toEqual([{ ...base, model: "b" }, { ...base, model: "a", digest: "d2", score: 90 }]);
  });
});
