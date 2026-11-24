import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AttachedFile } from "@gates-local/contracts";
import { AppError, createApp } from "../app.ts";
import { sendTaken } from "../chat/send-started.ts";
import type * as Alternatives from "../fit/alternatives.ts";
import type * as Fit from "../fit/fit.ts";
import { openThreadStore } from "../threads/store.ts";
import type { TurnEvent, TurnSaid } from "./turn.ts";

const spies = vi.hoisted(() => ({ offerBusy: [] as string[][], planBusy: [] as { model: string; busy: string[] }[] }));

vi.mock("../fit/alternatives.ts", async (importOriginal) => {
  const real = await importOriginal<typeof Alternatives>();
  return {
    ...real,
    offerAfterRefusal: (deps: Alternatives.OfferDeps, refused: Parameters<typeof real.offerAfterRefusal>[1]) => {
      spies.offerBusy.push([...deps.busy]);
      return real.offerAfterRefusal(deps, refused);
    },
  };
});

vi.mock("../fit/fit.ts", async (importOriginal) => {
  const real = await importOriginal<typeof Fit>();
  return {
    ...real,
    planLoad: (deps: Parameters<typeof real.planLoad>[0]) => {
      spies.planBusy.push({ model: deps.model, busy: [...deps.busy] });
      return real.planLoad(deps);
    },
  };
});

const MODEL = "qwen3.5:9b";
const OTHER = "gemma3:4b";
const ROOT = path.join(os.homedir(), ".cache", "gates-local-tests");
const SHOW: unknown = JSON.parse(readFileSync(new URL("../fit/fixtures/show-qwen3-5-9b.json", import.meta.url), "utf8"));
const ctx = { clientId: 1 };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).toReversed()) await clean();
  vi.unstubAllGlobals();
  spies.offerBusy.length = 0;
  spies.planBusy.length = 0;
});

const noop = (): void => {};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = noop;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const until = async (ok: () => boolean | Promise<boolean>, what: string) => {
  for (let i = 0; i < 400; i++) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const resident = (name: string, vram: number) => ({ name, size: vram, size_vram: vram, context_length: 16384 });

const installed = (name: string) => ({ name, digest: name, sizeBytes: 6_600_000_000, modifiedAt: "2026-11-01T00:00:00Z", capabilities: ["completion" as const] });

const line = (body: unknown) => `${JSON.stringify(body)}\n`;

const answerLine = (content: string) => new Response(line({ model: MODEL, message: { role: "assistant", content }, done: true, done_reason: "stop" }));

type Answer = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

interface RigOptions {
  readonly noLoader?: true;
  readonly current?: string;
  readonly captured?: string;
  readonly gated?: true;
  readonly freeMib?: number;
  readonly memKb?: number;
}

function rig(options: RigOptions = {}) {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(path.join(ROOT, "admit-plan-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = openThreadStore(path.join(dir, "threads.sqlite"));
  const thread = db.createThread({ title: "A" });
  let ps: readonly ReturnType<typeof resident>[] = [];
  const log: string[] = [];
  const answers = new Map<string, Answer>();
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    log.push(`${url.host}${url.pathname}`);
    const own = answers.get(url.pathname);
    if (own !== undefined) return own(url, init);
    if (url.pathname === "/api/show") return Response.json(SHOW);
    if (url.pathname === "/api/ps") return Response.json({ models: ps });
    if (url.pathname === "/api/tags") return Response.json({ models: [MODEL, OTHER].map((name) => ({ name, size: 6_600_000_000, digest: name, modified_at: "2026-11-01T00:00:00Z" })) });
    if (url.pathname === "/api/chat") return answerLine("ok");
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const gate = deferred();
  if (options.gated !== true) gate.resolve();
  const reservations: { model: string; controller: AbortController }[] = [];
  const holds = new Map<string, Promise<void>>();
  const refusals: Error[] = [];
  const said: TurnSaid[] = [];
  const freeMib = options.freeMib ?? 15000;
  const current = options.current ?? "http://fake";
  const models = [installed(MODEL), installed(OTHER)];
  const app = createApp({
    store: db,
    dataDir: dir,
    runtime: { status: () => ({ state: "ready", owner: "external", baseUrl: current }), baseUrl: () => current, onChange: () => noop, ensure: async () => ({ state: "ready", owner: "external", baseUrl: current }), lookIfDown: async () => ({ state: "ready", owner: "external", baseUrl: current }) },
    catalog: { current: () => models, refresh: async () => ({ models, changed: false }), onChange: () => noop, stop: noop },
    push: noop,
    turnSaid: (s) => {
      said.push(s);
      if (s.event.type === "start") log.push("start");
    },
    fit: {
      runNvidiaSmi: async (args) => (args[0]?.startsWith("--query-gpu") ? `16303, ${16303 - freeMib}, ${freeMib}\n` : ""),
      readMeminfo: async () => `MemTotal: ${options.memKb ?? 32000000} kB\nMemAvailable: ${options.memKb ?? 32000000} kB\n`,
    },
    ...(options.noLoader === true ? {} : {
      models: { handlers: {}, loader: { reserve: (model: string) => {
        const controller = new AbortController();
        reservations.push({ model, controller });
        return {
          baseUrl: options.captured ?? current, signal: controller.signal, cold: false, firstToken: noop, end: noop,
          admit: async (_numCtx, admitOptions) => {
            await gate.promise;
            const no = refusals.shift();
            if (no !== undefined) throw no;
            if (admitOptions?.fit === undefined) throw new Error("missing app fit");
            const report = await admitOptions.fit(admitOptions.signal ?? controller.signal, { handoff: undefined, leave: async () => undefined });
            await holds.get(model);
            return report;
          },
        };
      } } },
    }),
  });
  cleanups.push(async () => { gate.resolve(); await app.shutdown(); db.close(); });
  const events = (turnId: string): TurnEvent[] => said.flatMap((s) => (s.turnId === turnId ? [s.event] : []));
  const terminal = (turnId: string) => events(turnId).filter((e) => e.type === "error" || e.type === "done");
  return {
    app, db, thread, dir, log, answers, reservations, holds, refusals, events, terminal,
    open: gate.resolve,
    setPs: (rows: readonly ReturnType<typeof resident>[]) => { ps = rows; },
    h: app.handlers as Required<typeof app.handlers>,
  };
}

const body64 = (text: string) => Buffer.from(text).toString("base64");

it("a Stop before the start ends the turn at the moment of the Stop, not when its work let go", async () => {
  const r = rig({ gated: true });
  const sent = await sendTaken(r.app, { threadId: r.thread.id, content: "hi", model: MODEL, numCtx: 16384 }, ctx);
  sent.admission.catch(noop);
  const before = Date.now();
  expect(r.h["reply.stop"]({ id: sent.turnId }, ctx)).toMatchObject({ answer: "done" });
  const after = Date.now();
  await sleep(60);
  r.open();
  await until(() => r.terminal(sent.turnId).length > 0, "the end");
  const [end] = r.terminal(sent.turnId);
  expect(end).toMatchObject({ type: "error", code: "cancelled", ended: { reason: "stopped" } });
  const at = end?.type === "error" ? end.ended?.at : undefined;
  expect(at).toBeGreaterThanOrEqual(before);
  expect(at).toBeLessThanOrEqual(after);
});

it("a reply cut by a runtime switch still holds its model in every plan until it has ended", async () => {
  const r = rig();
  r.setPs([resident(OTHER, 4_000_000_000)]);
  const held = deferred();
  r.holds.set(OTHER, held.promise);
  const other = r.db.createThread({ title: "Long answer" });
  const x = await sendTaken(r.app, { threadId: other.id, content: "write a lot", model: OTHER, numCtx: 16384 }, ctx);
  x.admission.catch(noop);
  const blocking = () => r.h["turns.blocking"]({ model: MODEL, numCtx: 16384 }, ctx);
  await until(async () => (await blocking()).length > 0, "X in memory");
  const reservation = r.reservations.find((s) => s.model === OTHER);
  if (reservation === undefined) throw new Error("X reserved nothing");
  reservation.controller.abort();
  await sleep(20);
  expect(r.terminal(x.turnId), "X has not ended yet").toEqual([]);
  expect(await blocking()).toEqual([{ threadId: other.id, title: "Long answer", model: OTHER, turnId: x.turnId }]);
  held.resolve();
  await x.ended;
  expect(r.terminal(x.turnId)).toMatchObject([{ type: "error", code: "runtime-changed" }]);
  expect(await blocking()).toEqual([]);
});

it("what a refused send is offered instead is planned around the same busy replies as its refusal", async () => {
  const r = rig({ freeMib: 1000, memKb: 1_000_000 });
  r.setPs([resident(OTHER, 4_000_000_000)]);
  const held = deferred();
  r.holds.set(OTHER, held.promise);
  cleanups.push(held.resolve);
  const other = r.db.createThread({ title: "Long answer" });
  const x = await sendTaken(r.app, { threadId: other.id, content: "write a lot", model: OTHER, numCtx: 16384 }, ctx);
  x.admission.catch(noop);
  await until(() => spies.planBusy.some((p) => p.model === OTHER), "X's fit");
  await sleep(20);
  spies.planBusy.length = 0;
  const y = await sendTaken(r.app, { threadId: r.thread.id, content: "hi", model: MODEL, numCtx: 16384, askFirst: true }, ctx);
  y.admission.catch(noop);
  await until(() => r.terminal(y.turnId).length > 0, "the refusal");
  expect(r.terminal(y.turnId)).toMatchObject([{ type: "error", code: "wont-fit" }]);
  const planned = spies.planBusy.filter((p) => p.model === MODEL).map((p) => p.busy);
  expect(planned.length).toBeGreaterThan(0);
  expect(planned.at(-1)).toEqual([OTHER]);
  expect(spies.offerBusy).toEqual([[OTHER]]);
});

it("a send refused for memory goes out with no offer when what would run cannot be worked out", async () => {
  const r = rig({ freeMib: 1000, memKb: 1_000_000, captured: "http://refusing:1" });
  let shown = false;
  r.answers.set("/api/show", (url) => {
    if (url.host === "refusing:1") shown = true;
    return Response.json(SHOW);
  });
  r.answers.set("/api/ps", (url) => (shown && url.host === "refusing:1" ? new Response("down", { status: 500 }) : Response.json({ models: [] })));
  const sent = await sendTaken(r.app, { threadId: r.thread.id, content: "hi", model: MODEL, numCtx: 16384 }, ctx);
  sent.admission.catch(noop);
  await until(() => r.terminal(sent.turnId).length > 0, "the refusal");
  const [refusal] = r.terminal(sent.turnId);
  expect(refusal).toMatchObject({ type: "error", code: "wont-fit", fit: { model: MODEL, verdict: "refuse" }, ended: { reason: "failed" } });
  expect(refusal).not.toHaveProperty("offer");
});

it("a refused start rejects its admission only after its error event has gone out", async () => {
  const r = rig({ gated: true });
  r.refusals.push(new AppError("would-stop", "needs the GPU memory of a running reply"));
  const sent = await sendTaken(r.app, { threadId: r.thread.id, content: "hi", model: MODEL, numCtx: 16384 }, ctx);
  let toldFirst: boolean | undefined;
  const settled = sent.admission.then(noop, () => { toldFirst = r.terminal(sent.turnId).length > 0; });
  r.open();
  await settled;
  expect(toldFirst).toBe(true);
  expect(r.terminal(sent.turnId)).toMatchObject([{ type: "error", code: "would-stop" }]);
});

it("a refused Retry keeps the replaced question's attached file on disk along with its rows", async () => {
  const r = rig({ gated: true });
  const file: AttachedFile = await r.h["files.attach"]({ name: "notes.txt", type: "text/plain", data: body64("kept words") }, ctx);
  const question = r.db.appendMessage({ threadId: r.thread.id, role: "user", content: "read this", files: [file] });
  r.db.appendMessage({ threadId: r.thread.id, role: "assistant", content: "half", interrupted: true });
  r.refusals.push(new AppError("would-stop", "needs the GPU memory of a running reply"));
  const sent = await sendTaken(r.app, { threadId: r.thread.id, content: "read this", model: MODEL, numCtx: 16384, retryOf: question.id }, ctx);
  r.open();
  await expect(sent.admission).rejects.toMatchObject({ code: "would-stop" });
  await new Promise((done) => setImmediate(done));
  await r.h["files.release"]({ paths: [] }, ctx);
  expect(r.db.getThread(r.thread.id).messages.map((m) => [m.role, m.content])).toEqual([["user", "read this"], ["assistant", "half"]]);
  expect(existsSync(path.join(r.dir, file.path))).toBe(true);
});

it("a start that waits behind its model's preload is said as loading before its start", async () => {
  const r = rig({ gated: true });
  r.app.fitTable.load({ model: MODEL, numCtx: 16384, state: "loading" });
  const sent = await sendTaken(r.app, { threadId: r.thread.id, content: "hi", model: MODEL, numCtx: 16384 }, ctx);
  sent.admission.catch(noop);
  expect(r.events(sent.turnId), "nothing before the answer").toEqual([]);
  await until(async () => JSON.stringify(await r.h["reply.list"]({}, ctx)).includes("\"loading\":true"), "the record to say loading");
  expect(await r.h["reply.list"]({}, ctx)).toEqual([{ reply: expect.objectContaining({ id: sent.id, stage: "starting", loading: true }) }]);
  expect(r.events(sent.turnId).map((e) => e.type)).not.toContain("start");
  expect(r.events(sent.turnId).findLast((e) => e.type === "reply")).toMatchObject({ reply: { stage: "loading" } });
  r.open();
  await until(() => r.events(sent.turnId).some((e) => e.type === "start"), "the start");
});

it("with tools on, a file attached to an earlier message in the thread opens by its label in a later turn", async () => {
  const r = rig();
  const file = await r.h["files.attach"]({ name: "Notes.txt", type: "text/plain", data: body64("EARLIER-WORDS") }, ctx);
  r.db.appendMessage({ threadId: r.thread.id, role: "user", content: "keep this", files: [file] });
  r.db.appendMessage({ threadId: r.thread.id, role: "assistant", content: "kept" });
  const results: string[] = [];
  r.answers.set("/api/chat", (_url, init) => {
    const last = (JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }).messages.at(-1);
    if (last?.role === "tool") {
      results.push(last.content);
      return answerLine("Read it.");
    }
    return new Response(line({ model: MODEL, message: { role: "assistant", content: "", tool_calls: [{ function: { name: "read", arguments: { path: "/library/notes-txt" } } }] }, done: true, done_reason: "stop" }));
  });
  const sent = await sendTaken(r.app, { threadId: r.thread.id, content: "what did the notes say?", model: MODEL, numCtx: 16384, tools: true }, ctx);
  await sent.admission;
  await until(() => r.terminal(sent.turnId).length > 0, "the reply");
  expect(r.terminal(sent.turnId)).toMatchObject([{ type: "done" }]);
  expect(results).toEqual([expect.stringContaining("EARLIER-WORDS")]);
});

it("a start's fit, admission and reply all talk to the runtime its reservation captured", async () => {
  const r = rig({ current: "http://current:1", captured: "http://captured:1" });
  const sent = await sendTaken(r.app, { threadId: r.thread.id, content: "hi", model: MODEL, numCtx: 16384 }, ctx);
  await sent.admission;
  await until(() => r.terminal(sent.turnId).length > 0, "the reply");
  const started = r.log.indexOf("start");
  expect(started).toBeGreaterThan(0);
  const before = r.log.slice(0, started);
  expect(before).toContain("captured:1/api/ps");
  expect(before.filter((l) => l.startsWith("current:1/"))).toEqual([]);
  const chats = r.log.filter((l) => l.endsWith("/api/chat"));
  expect(chats.length).toBeGreaterThan(0);
  expect(chats.every((l) => l === "captured:1/api/chat")).toBe(true);
});

it("without a loader, a Stop that lands while the fit is reading ends the start as stopped", async () => {
  const r = rig({ noLoader: true, current: "http://plain:1" });
  const reading = deferred();
  const release = deferred();
  cleanups.push(release.resolve);
  r.answers.set("/api/ps", async (url) => {
    if (url.host !== "plain:1") return Response.json({ models: [] });
    reading.resolve();
    await release.promise;
    return new Response("gone", { status: 500 });
  });
  const sent = await sendTaken(r.app, { threadId: r.thread.id, content: "hi", model: MODEL, numCtx: 16384 }, ctx);
  sent.admission.catch(noop);
  await reading.promise;
  r.h["reply.stop"]({ id: sent.turnId }, ctx);
  release.resolve();
  await until(() => r.terminal(sent.turnId).length > 0, "the end");
  expect(r.terminal(sent.turnId)).toMatchObject([{ type: "error", code: "cancelled", ended: { reason: "stopped" } }]);
  expect(r.db.getThread(r.thread.id).messages).toEqual([]);
});
