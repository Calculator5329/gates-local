import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageChoice, ImageEvent, ImageStatus, Params } from "@gates-local/contracts";
import { createApp } from "../app.ts";
import { endOf, replySend, type Sending } from "../chat/send-started.ts";
import { IMAGES_UNSET, notRunning, type ImageModule } from "../image/module.ts";
import { openThreadStore, type ThreadStore } from "../threads/store.ts";
import { chatCatalog } from "../../test/send-rig.ts";
import type { TurnEvent, TurnSaid } from "./turn.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).toReversed()) await clean();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const DRAWN: ImageChoice = { preset: "flux2-klein-4b-pixel", width: 512, height: 512 };
const COMFY = "http://fake-comfy";
const STOPPED: ImageStatus = { state: "stopped", owner: "none" };
const READY: ImageStatus = { state: "ready", owner: "external", baseUrl: COMFY };
const UNSET: ImageStatus = { state: "missing", owner: "none", baseUrl: COMFY };
const SET_BUT_DOWN: ImageStatus = { state: "missing", owner: "none", baseUrl: COMFY, addressSet: true };
const RUNTIME = { state: "ready" as const, owner: "external" as const, baseUrl: "http://fake" };

interface Job {
  readonly ended: Promise<void>;
  readonly settle: (state: "done" | "cancelled") => void;
}

interface Options {
  readonly current?: ImageStatus;
  readonly probe?: () => Promise<ImageStatus>;
  readonly hold?: boolean;
  readonly queueing?: Promise<void>;
  readonly failAt?: number;
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeImage(store: ThreadStore, options: Options) {
  const jobs = new Map<string, Job>();
  let calls = 0;
  const generate = vi.fn(async (params: Params<"image.generate">): Promise<{ jobId: string }> => {
    const index = calls++;
    if (index === 0) await options.queueing;
    if (index === options.failAt) throw Object.assign(new Error("There is no image preset nope."), { code: "image-model" });
    const jobId = `job-${index + 1}`;
    const card = (state: ImageEvent["state"], rest: Partial<ImageEvent> = {}) => store.saveImageJob({
      jobId, state,
      ...(params.threadId === undefined ? {} : { threadId: params.threadId }),
      ...(params.choice === undefined ? {} : { choice: params.choice }),
      ...(params.group === undefined ? {} : { group: params.group }),
      ...rest,
    }, params.prompt);
    card("queued");
    let settled = false;
    const end = deferred();
    const settle = (state: "done" | "cancelled") => {
      if (settled) return;
      settled = true;
      card(state, state === "done" ? { progress: 1, imagePath: `images/${jobId}.png` } : { message: "The image was cancelled; try again when you are ready.", errorKind: "cancelled" });
      end.resolve();
    };
    jobs.set(jobId, { ended: end.promise, settle });
    if (options.hold !== true) queueMicrotask(() => settle("done"));
    return { jobId };
  });
  const cancel = vi.fn((jobId: string) => {
    const job = jobs.get(jobId);
    job?.settle("cancelled");
    return { cancelled: job !== undefined };
  });
  const current = vi.fn(() => options.current ?? STOPPED);
  const status = vi.fn(options.probe ?? (async () => options.current ?? STOPPED));
  const wait = async (jobId: string) => { await jobs.get(jobId)?.ended; };
  const finishAll = () => { for (const job of jobs.values()) job.settle("done"); };
  const image = { current, status, generate, cancel, wait } as unknown as ImageModule;
  return { image, generate, cancel, status, finishAll };
}

function rig(options: Options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "gl-image-start-"));
  const store = openThreadStore(path.join(root, "threads.db"));
  const fake = fakeImage(store, options);
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
    requests.push(new URL(String(url)).pathname);
    return Response.json({});
  }));
  const said: TurnSaid[] = [];
  const changed: string[] = [];
  const app = createApp({
    store,
    image: fake.image,
    runtime: { status: () => RUNTIME, baseUrl: () => "http://fake", onChange: () => () => {}, ensure: async () => RUNTIME, lookIfDown: async () => RUNTIME },
    catalog: chatCatalog(),
    push: (channel, payload) => {
      if (channel === "threads.changed") changed.push((payload as { threadId: string }).threadId);
    },
    turnSaid: (s) => { said.push(s); },
    fit: { runNvidiaSmi: async (args) => (args[0]?.startsWith("--query-gpu") ? "16384, 1024, 15360\n" : ""), readMeminfo: async () => "MemAvailable: 32000000 kB\n" },
  });
  const thread = store.createThread();
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cleanups.push(async () => { fake.finishAll(); await app.shutdown(); store.close(); });
  const events = (): TurnEvent[] => said.filter((s) => s.threadId === thread.id).map((s) => s.event).filter((e) => e.type !== "reply");
  const send = async (extra: Pick<Sending, "drawCount"> = {}) => {
    const params = replySend({ threadId: thread.id, content: "a lighthouse at dusk", model: "m", numCtx: 16384, draw: DRAWN, ...extra });
    await app.handlers["reply.send"](params, { clientId: 1 });
    return { id: params.id, ended: endOf(app, params.id) };
  };
  const stop = (id: string) => app.handlers["reply.stop"]({ id }, { clientId: 1 });
  const record = async (id: string) => (await app.handlers["reply.list"]!({}, { clientId: 1 })).find((l) => l.reply.id === id)?.reply;
  const messages = () => store.getThread(thread.id).messages;
  return { ...fake, app, store, thread, send, stop, record, events, messages, requests, changed };
}

const ended = (reason: "failed" | "stopped") => ({ reason, at: expect.any(Number) });
const cancelledBeforeStart = { type: "error", code: "cancelled", message: "the turn was cancelled before it started", ended: ended("stopped") };

describe("an Image mode send's start", () => {
  it("is answered before its question is saved or its picture queued, and its start comes after both", async () => {
    const t = rig();
    const append = vi.spyOn(t.store, "appendMessage");
    await t.send();
    expect(append).not.toHaveBeenCalled();
    expect(t.generate).not.toHaveBeenCalled();
    expect(t.events()).toEqual([]);
    await vi.waitFor(() => expect(t.events().map((e) => e.type)).toEqual(["start", "done"]));
    expect(append).toHaveBeenCalledOnce();
    expect(t.generate).toHaveBeenCalledOnce();
    expect(append.mock.invocationCallOrder[0]!).toBeLessThan(t.generate.mock.invocationCallOrder[0]!);
  });

  it("a refusal after the answer ends the turn with one error event saying why, and keeps no question and no picture", async () => {
    const t = rig({ current: SET_BUT_DOWN });
    await (await t.send()).ended;
    expect(t.events()).toEqual([{ type: "error", code: "image-input", message: notRunning(COMFY), ended: ended("failed") }]);
    expect(t.messages()).toEqual([]);
    expect(t.generate).not.toHaveBeenCalled();
  });

  it("with no ComfyUI address set, a missing ComfyUI refuses the send with the line that says images are not set up", async () => {
    const t = rig({ current: UNSET });
    await t.send();
    await vi.waitFor(() => expect(t.events()).toHaveLength(1));
    expect(t.events()[0]).toMatchObject({ type: "error", code: "image-input", message: IMAGES_UNSET });
    expect(t.messages()).toEqual([]);
  });

  it("a ComfyUI that was missing but answers when asked again lets the send through", async () => {
    const t = rig({ current: UNSET, probe: async () => READY });
    await t.send();
    await vi.waitFor(() => expect(t.events().map((e) => e.type)).toEqual(["start", "done"]));
    expect(t.status).toHaveBeenCalledOnce();
    expect(t.generate).toHaveBeenCalledOnce();
    expect(t.messages().map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("a Stop while ComfyUI is asked again writes nothing: no question, no picture, no chat change", async () => {
    const probe = deferred<ImageStatus>();
    const t = rig({ current: UNSET, probe: () => probe.promise });
    const append = vi.spyOn(t.store, "appendMessage");
    const { id } = await t.send();
    await vi.waitFor(() => expect(t.status).toHaveBeenCalledOnce());
    t.stop(id);
    probe.resolve(READY);
    await vi.waitFor(() => expect(t.events()).toEqual([cancelledBeforeStart]));
    expect(append).not.toHaveBeenCalled();
    expect(t.generate).not.toHaveBeenCalled();
    expect(t.changed).toEqual([]);
    expect(t.messages()).toEqual([]);
  });

  it("a Stop between pictures queues no more, and takes back the question and the pictures already queued", async () => {
    const queueing = deferred();
    const t = rig({ hold: true, queueing: queueing.promise });
    const { id } = await t.send({ drawCount: 3 });
    await vi.waitFor(() => expect(t.generate).toHaveBeenCalledOnce());
    t.stop(id);
    queueing.resolve();
    await vi.waitFor(() => expect(t.events()).toEqual([cancelledBeforeStart]));
    expect(t.generate).toHaveBeenCalledOnce();
    expect(t.cancel).toHaveBeenCalledWith("job-1");
    expect(t.messages()).toEqual([]);
  });

  it("a Stop while its only picture is being queued undoes the start: no start, no question, the picture cancelled and its card gone", async () => {
    const queueing = deferred();
    const t = rig({ hold: true, queueing: queueing.promise });
    const { id } = await t.send();
    await vi.waitFor(() => expect(t.generate).toHaveBeenCalledOnce());
    t.stop(id);
    queueing.resolve();
    await vi.waitFor(() => expect(t.events()).toEqual([cancelledBeforeStart]));
    expect(t.cancel).toHaveBeenCalledWith("job-1");
    expect(t.messages()).toEqual([]);
    expect(await t.record(id)).toMatchObject({ stage: "held", held: { why: "stopped" } });
  });

  it("when a later picture of several cannot be queued, the earlier ones are cancelled and their cards go with the question", async () => {
    const t = rig({ hold: true, failAt: 1 });
    await t.send({ drawCount: 3 });
    await vi.waitFor(() => expect(t.events()).toHaveLength(1));
    expect(t.events()).toEqual([{ type: "error", code: "image-model", message: "There is no image preset nope.", ended: ended("failed") }]);
    expect(t.generate).toHaveBeenCalledTimes(2);
    expect(t.cancel).toHaveBeenCalledWith("job-1");
    expect(t.messages()).toEqual([]);
  });

  it("a refused send's message waits on hold with the refusal's own reason", async () => {
    const t = rig({ current: UNSET });
    const { id, ended: over } = await t.send();
    await over;
    expect(await t.record(id)).toMatchObject({ stage: "held", held: { why: "refused", code: "image-input", message: IMAGES_UNSET } });
  });

  it("a send stopped before it started stays on hold as stopped, not as refused, and its turn ends as stopped", async () => {
    const t = rig();
    const { id, ended: over } = await t.send();
    t.stop(id);
    await over;
    expect(t.events()).toEqual([cancelledBeforeStart]);
    expect(await t.record(id)).toMatchObject({ stage: "held", held: { why: "stopped" } });
    expect(t.messages()).toEqual([]);
    expect(t.requests).toEqual([]);
  });
});
