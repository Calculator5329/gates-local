import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { comfyInfo } from "../../test/comfy/info.ts";
import { ComfyCancelTimeoutError, createComfyClient, INTERRUPT_AGAIN_MS, type RenderSaid } from "./client.ts";
import type { ApiGraph } from "./convert.ts";
import type { Preset } from "./presets.ts";

afterEach(() => vi.useRealTimers());

it("cancels its prompt if it moves from pending to running during cancellation, leaving other prompts alone", async () => {
  const calls: string[] = [];
  let polls = 0, interrupted = false;
  const client = createComfyClient("http://fake", { fetch: async (input, init) => {
    const route = new URL(String(input)).pathname; calls.push(route);
    if (route === "/queue") {
      polls++;
      if (polls === 1) return Response.json({ queue_pending: [[1, "ours"]], queue_running: [[0, "other"]] });
      if (polls > 3 && !interrupted) throw new Error("cancellation never interrupted the transitioned prompt");
      return Response.json({ queue_pending: [], queue_running: interrupted ? [[2, "other-next"]] : [[1, "ours"]] });
    }
    if (route === "/interrupt") { expect(JSON.parse(String(init?.body))).toEqual({ prompt_id: "ours" }); interrupted = true; return Response.json({}); }
    throw new Error(`unexpected ${route}`);
  } });
  await client.cancelPrompt("ours");
  expect(calls.filter((route) => route === "/interrupt")).toHaveLength(1);
  const other = createComfyClient("http://fake", { fetch: async (input) => {
    expect(new URL(String(input)).pathname).toBe("/queue");
    return Response.json({ queue_pending: [], queue_running: [[0, "other"]] });
  } });
  await other.cancelPrompt("ours-already-finished");
});

it("a running prompt is interrupted once, however many polls ComfyUI takes to stop it", async () => {
  // A processor-only engine checks the interrupt between pieces of a step that runs for minutes:
  // asking again on every poll filled its log with "Interrupting prompt" and changed nothing.
  const calls: string[] = [];
  let polls = 0;
  const client = createComfyClient("http://fake", { fetch: async (input) => {
    const route = new URL(String(input)).pathname; calls.push(route);
    if (route === "/queue") return Response.json({ queue_pending: [], queue_running: ++polls < 12 ? [[1, "ours"]] : [] });
    if (route === "/interrupt") return Response.json({});
    throw new Error(`unexpected ${route}`);
  } });
  await client.cancelPrompt("ours");
  expect(polls).toBe(12);
  expect(calls.filter((route) => route === "/interrupt")).toHaveLength(1);
});

it("asks again only every INTERRUPT_AGAIN_MS, for an interrupt ComfyUI dropped as the prompt started", async () => {
  vi.useFakeTimers();
  let interrupts = 0;
  const client = createComfyClient("http://fake", { fetch: async (input) => {
    const route = new URL(String(input)).pathname;
    if (route === "/queue") return Response.json({ queue_pending: [], queue_running: Date.now() < start + 25_000 ? [[1, "ours"]] : [] });
    if (route === "/interrupt") { interrupts++; return Response.json({}); }
    throw new Error(`unexpected ${route}`);
  } });
  const start = Date.now();
  const ended = client.cancelPrompt("ours");
  await vi.advanceTimersByTimeAsync(26_000); await ended;
  // asked at 0, 10 and 20 s, never on each poll
  expect(INTERRUPT_AGAIN_MS).toBe(10_000);
  expect(interrupts).toBe(3);
});

it("on the processor the cancel waits as long as a step runs, and its deadline names that wait", async () => {
  // A processor step runs for minutes and ComfyUI checks the interrupt between steps: a 30 s wait
  // gave up on a picture that was stopping as asked.
  vi.useFakeTimers();
  const start = Date.now();
  const client = createComfyClient("http://fake", { fetch: async (input) => {
    const route = new URL(String(input)).pathname;
    if (route === "/queue") return Response.json({ queue_pending: [], queue_running: Date.now() < start + 4 * 60_000 ? [[1, "ours"]] : [] });
    if (route === "/interrupt") return Response.json({});
    throw new Error(`unexpected ${route}`);
  } });
  let failure: unknown, done = false;
  const ended = client.cancelPrompt("ours", 30 * 60_000).then(() => { done = true; }, (error: unknown) => { failure = error; });
  await vi.advanceTimersByTimeAsync(31_000);
  expect(failure).toBeUndefined();
  await vi.advanceTimersByTimeAsync(4 * 60_000); await ended;
  expect(failure).toBeUndefined();
  expect(done).toBe(true);
  expect(new ComfyCancelTimeoutError(30 * 60_000).message).toBe("ComfyUI did not release the image job within 30 minutes");
  expect(new ComfyCancelTimeoutError(30_000).message).toBe("ComfyUI did not release the image job within 30 s");
});

it("throws the named cancellation deadline even if the queue HTTP request hangs", async () => {
  vi.useFakeTimers();
  const client = createComfyClient("http://fake", { requestTimeoutMs: 90_000, fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  }) });
  let failure: unknown;
  const ended = client.cancelPrompt("ours").catch((error: unknown) => { failure = error; });
  await vi.advanceTimersByTimeAsync(29_999); expect(failure).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1); const atDeadline = failure;
  // Allow a mutated 60-second deadline to finish without leaving work behind.
  await vi.advanceTimersByTimeAsync(30_000); await ended;
  expect(atDeadline).toMatchObject({ name: "ComfyCancelTimeoutError", message: "ComfyUI did not release the image job within 30 s" });
});

const SDXL_GRAPH = JSON.parse(readFileSync(new URL("../../test/comfy/api/image_sdxl_simple.json", import.meta.url), "utf8")) as ApiGraph;
const INFO = comfyInfo({ checkpoints: ["sd_xl_base_1.0.safetensors"] });
const PNG = Buffer.from("iVBORw0KGgo=", "base64");
const preset = (workflow: ApiGraph): Preset => ({ id: "sdxl-test", name: "SDXL test", short: "SDXL", family: "sdxl", group: "test", workflow, sizes: [{ width: 1024, height: 1024, bytes: 1 }], measured: false });
const CHOICE = { preset: "sdxl-test", width: 1024, height: 1024 };
const frame = (type: string, data: Record<string, unknown> = {}) => JSON.stringify({ type, data: { prompt_id: "p1", ...data } });
const noop = () => {};
const FINISHED = { p1: { outputs: { "7": { images: [{ filename: "out.png", subfolder: "", type: "output" }] } } } };

interface FakeComfy {
  frames?: readonly string[];
  foreign?: boolean;
  lands?: "pending" | "running";
  prompt?: (init: RequestInit | undefined) => Promise<Response>;
  history?: () => Response;
  folders?: () => Response;
}

function fakeComfy(fake: FakeComfy = {}) {
  const calls: { route: string; body?: unknown }[] = [];
  const queued = { pending: [] as string[], running: [] as string[] };
  let sockets = 0;
  let socket: EventTarget | undefined;
  const send = (data: string) => socket?.dispatchEvent(new MessageEvent("message", { data }));
  const client = createComfyClient("http://fake", {
    socket: () => {
      sockets++;
      socket = new EventTarget();
      Object.defineProperty(socket, "readyState", { value: 1 });
      Object.assign(socket, { close() {} });
      return socket as WebSocket;
    },
    fetch: async (input, init) => {
      const route = new URL(String(input)).pathname;
      const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      calls.push(body === undefined ? { route } : { route, body });
      if (route === "/queue" && init?.method === "POST") {
        const removed = (body as { delete: string[] }).delete;
        queued.pending = queued.pending.filter((id) => !removed.includes(id));
        return Response.json({});
      }
      if (route === "/queue") return Response.json({ queue_pending: queued.pending.map((id, i) => [i, id]), queue_running: [...fake.foreign ? [[0, "foreign"]] : [], ...queued.running.map((id, i) => [i + 1, id])] });
      if (route === "/interrupt") { queued.running = []; return Response.json({}); }
      if (route === "/free") return Response.json({});
      if (route === "/system_stats") return Response.json({ system: {}, devices: [] });
      if (route === "/object_info") return Response.json(INFO);
      if (route === "/internal/folder_paths") return fake.folders?.() ?? new Response("not found", { status: 404 });
      if (route === "/prompt") {
        const answer = await (fake.prompt?.(init) ?? Promise.resolve(Response.json({ prompt_id: "p1" })));
        if (fake.lands !== undefined) queued[fake.lands].push("p1");
        setTimeout(() => { for (const one of fake.frames ?? []) send(one); }, 0);
        return answer;
      }
      if (route === "/history/p1") return fake.history?.() ?? Response.json(FINISHED);
      if (route === "/view") return new Response(PNG);
      throw new Error(`unexpected ${route}`);
    },
  });
  const said: (RenderSaid | undefined)[] = [];
  const render = (graph: ApiGraph = SDXL_GRAPH, signal: AbortSignal = new AbortController().signal) =>
    client.render("a tree", "client", signal, (_value, next) => { said.push(next); }, () => {}, CHOICE, [preset(graph)], 7);
  return { client, calls, said, render, sockets: () => sockets };
}

describe("a render, as ComfyUI reports it", () => {
  it("ComfyUI running the Save Image node says no new stage: the picture stays at the stage it was", async () => {
    const comfy = fakeComfy({ frames: [frame("executing", { node: "15" }), frame("executing", { node: "12" }), frame("progress", { value: 1, max: 4 }), frame("executing", { node: "7" }), frame("executing", { node: null })] });
    await comfy.render();
    expect(comfy.said.map((s) => s?.stage)).toEqual(["queued", "loading", "sampling", "sampling"]);
  });

  it("progress counted while the picture decodes (a tiled decode) stays decoding, never a sampler step", async () => {
    const comfy = fakeComfy({ frames: [frame("executing", { node: "12" }), frame("executing", { node: "14" }), frame("progress", { value: 2, max: 4 }), frame("executing", { node: null })] });
    await comfy.render();
    expect(comfy.said).toEqual([{ stage: "queued" }, { stage: "sampling" }, { stage: "decoding" }, { stage: "decoding" }]);
  });

  it("a frame that is not JSON or not shaped like ComfyUI's is dropped, and the render goes on", async () => {
    const comfy = fakeComfy({ frames: ["{not json", JSON.stringify({ type: "progress" }), JSON.stringify({ type: 3, data: {} }), frame("executing", { node: "12" }), frame("executing", { node: null })] });
    const result = await comfy.render();
    expect(result.bytes.equals(PNG)).toBe(true);
    expect(comfy.said.map((s) => s?.stage)).toEqual(["queued", "sampling"]);
  });

  it("a graph with one step count gives the picture its steps; one with none or several gives none", async () => {
    const done = [frame("executing", { node: null })];
    expect((await fakeComfy({ frames: done }).render()).steps).toBe(25);
    const several = structuredClone(SDXL_GRAPH);
    several["20"] = { class_type: "BasicScheduler", inputs: { scheduler: "simple", steps: 10, denoise: 1, model: ["15", 0] } };
    expect(await fakeComfy({ frames: done }).render(several)).not.toHaveProperty("steps");
    const none = structuredClone(SDXL_GRAPH);
    delete none["12"]!.inputs["steps"];
    expect(await fakeComfy({ frames: done }).render(none)).not.toHaveProperty("steps");
  });

  it("a ComfyUI busy with another client's job is refused as busy, and nothing is sent to its queue", async () => {
    const comfy = fakeComfy({ foreign: true });
    await expect(comfy.render()).rejects.toMatchObject({ code: "image-busy", message: "ComfyUI is busy with another job. Wait for it to finish, then retry." });
    expect(comfy.calls.map((c) => c.route)).not.toContain("/prompt");
    expect(comfy.sockets()).toBe(0);
  });

  it("a Stop while ComfyUI is still taking the prompt keeps its id, and that prompt is taken back out of the queue", async () => {
    let accept: () => void = noop;
    const comfy = fakeComfy({ lands: "pending", prompt: async (init) => new Promise<Response>((resolve, reject) => {
      accept = () => resolve(Response.json({ prompt_id: "p1" }));
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }) });
    const stop = new AbortController();
    const ended = comfy.render(SDXL_GRAPH, stop.signal).catch((error: unknown) => error);
    while (!comfy.calls.some((c) => c.route === "/prompt")) await new Promise((r) => setTimeout(r, 1));
    stop.abort();
    accept();
    expect(await ended).toMatchObject({ message: "Image cancelled." });
    expect(comfy.calls).toContainEqual({ route: "/queue", body: { delete: ["p1"] } });
  });

  it("a prompt ComfyUI finishes without a completion frame (a cached result) ends through its history", async () => {
    const comfy = fakeComfy();
    const result = await comfy.render();
    expect(result.bytes.equals(PNG)).toBe(true);
    expect(comfy.calls.filter((c) => c.route === "/history/p1").length).toBeGreaterThanOrEqual(2);
  });

  it("a history check that fails while no frame comes fails the render with ComfyUI's answer", async () => {
    const comfy = fakeComfy({ history: () => new Response("down", { status: 500 }) });
    await expect(comfy.render()).rejects.toThrow("ComfyUI /history/p1 returned HTTP 500.");
  });
});

describe("asking ComfyUI about its queue", () => {
  it("is not idle while a prompt waits in its queue, even with nothing running", async () => {
    expect(await fakeComfy().client.idle()).toBe(true);
    const pending = createComfyClient("http://fake", { fetch: async () => Response.json({ queue_pending: [[0, "other"]], queue_running: [] }) });
    expect(await pending.idle()).toBe(false);
    expect(await pending.idle("other")).toBe(false);
  });

  it("frees memory only with the queue empty: a running job alone makes it busy and sends nothing else", async () => {
    const running = createComfyClient("http://fake", { fetch: async (input) => {
      expect(new URL(String(input)).pathname).toBe("/queue");
      return Response.json({ queue_pending: [], queue_running: [[0, "other"]] });
    } });
    expect(await running.free()).toBe("busy");
    const empty = fakeComfy();
    expect(await empty.client.free()).toBe("freed");
    expect(empty.calls).toEqual([{ route: "/queue" }, { route: "/free", body: { unload_models: true, free_memory: true } }]);
  });

  it("reads no model folders, without an error, where ComfyUI does not say them or says them in another shape", async () => {
    expect(await fakeComfy().client.folders()).toBeUndefined();
    expect(await fakeComfy({ folders: () => new Response("<html>", { status: 200 }) }).client.folders()).toBeUndefined();
    expect(await fakeComfy({ folders: () => Response.json(["/models"]) }).client.folders()).toBeUndefined();
    expect(await fakeComfy({ folders: () => Response.json({ checkpoints: ["/models/checkpoints"] }) }).client.folders()).toEqual({ checkpoints: ["/models/checkpoints"] });
  });
});
