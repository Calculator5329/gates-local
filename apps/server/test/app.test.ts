// app.ts end to end: the real ws server, the contracts client, the real
// thread store, runtime and catalog against a fake Ollama on port 0. The fit
// check reads fake nvidia-smi and meminfo text; nothing touches the GPU or a
// real Ollama, and the runtime only ever runs discover() (never ensure()).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { type Channel, type Client, type ImageEvent, type Message, type Params, type Payload, type SocketLike, WireError, createClient } from "@gates-local/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { type App, type AppDeps, createApp } from "../src/app.ts";
import * as imageFiles from "../src/chat/image-lifecycle.ts";
import { saveAttachments } from "../src/chat/attachments.ts";
import { createGpuLease, type GpuLease } from "../src/gpu/lease.ts";
import { createImageModule, type ImageModule } from "../src/image/module.ts";
import { comfyInfo, ZIMAGE_FILES } from "./comfy/info.ts";
import { json, startFakeServer, type FakeServer } from "../src/fit/fake-http.ts";
import { createModelCatalog, listLoaded } from "../src/runtime/models.ts";
import { createModelLoader, type ModelLoader } from "../src/runtime/load.ts";
import { planLoad } from "../src/fit/fit.ts";
import { createMemoryOwner, ENGINE_BUSY_NOTE, type MemoryEngine, type MemoryOwner } from "../src/gpu/memory.ts";
import { createOllamaRuntime, type OllamaRuntime } from "../src/runtime/runtime.ts";
import { createRuntimeSwitch } from "../src/runtime/switch.ts";
import { defaultSettings } from "../src/settings/store.ts";
import { installedBinary } from "../src/runtime/paths.ts";
import { FAKE_RELEASE_FORMAT, freePort, startFakeOllama, startReleaseServer, writeFakeBinary } from "../src/runtime/test-fakes.ts";
import { openThreadStore, type ThreadStore } from "../src/threads/store.ts";
import { type WsServer, startWsServer } from "../src/ws/server.ts";

const TOKEN = "app-test-token";
const MODEL = "qwen3.5:9b";
const SHOW = JSON.parse(readFileSync(new URL("../src/fit/fixtures/show-qwen3-5-9b.json", import.meta.url), "utf8")) as unknown;
const TAGS = { models: [{ name: MODEL, model: MODEL, size: 6594474711, digest: "sha256:a", modified_at: "2026-11-01T10:00:00Z" }] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const piece = (text: string) => line({ model: MODEL, message: { role: "assistant", content: text }, done: false });
const doneLine = line({
  model: MODEL,
  message: { role: "assistant", content: "" },
  done: true,
  done_reason: "stop",
  total_duration: 500_000_000,
  prompt_eval_count: 11,
  eval_count: 3,
});

type ChatRoute = (res: ServerResponse, body: unknown) => Promise<void> | void;

/** Streams the pieces with a pause between them; stops early if the client hangs up. */
async function stream(res: ServerResponse, pieces: readonly string[], delayMs = 0): Promise<void> {
  res.writeHead(200, { "content-type": "application/x-ndjson" });
  for (const p of pieces) {
    if (res.destroyed) return;
    res.write(p);
    if (delayMs) await sleep(delayMs);
  }
  res.end();
}

const quickReply: ChatRoute = (res) => stream(res, [piece("hi"), doneLine]);
/** About 750 ms of reply, slow enough to cancel or delete mid-stream. */
const slowReply: ChatRoute = (res) => stream(res, [piece("one "), piece("two "), piece("three "), piece("four "), doneLine], 150);

// --------------------------------------------------------------- harness

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).toReversed()) await c();
});

function cacheTmp(): string {
  const base = path.join(os.homedir(), ".cache", "gates-local-tests");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, "app-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface Gpu {
  freeMib: number;
  memAvailableKb: number;
  /** nvidia-smi --query-compute-apps rows (pid, name, MiB); none by default. */
  apps?: string;
  /** The card's memory.total; 16,303 MiB unless a test says (a 6 GiB laptop card says 6,144). */
  totalMib?: number;
  /** memory.used; total minus free unless a test says (the driver keeps some of neither). */
  usedMib?: number;
}

/** One /api/ps row of the rig's Ollama. */
interface PsRow {
  name: string;
  size: number;
  size_vram: number;
  context_length?: number;
}

interface Rig {
  app: App;
  server: WsServer;
  client: Client;
  store: ThreadStore;
  runtime: OllamaRuntime;
  ollama: FakeServer;
  gpu: Gpu;
  /** The app's GPU lease; present only when the rig was built with an image module. */
  lease: GpuLease | undefined;
  setChat(route: ChatRoute): void;
  /** Replaces the /api/show answer (every caller: the fit check, the think probe, the tool turn). */
  setShow(route: ChatRoute): void;
  pushes: Array<{ channel: Channel; payload: unknown }>;
  /** Stored message count of the thread at the moment each done event left app.ts (in process, before the socket). */
  storedAtDonePush: number[];
  replayedAtDone: Payload<"chat.event">[];
  /** The model catalog the app reads; a finished download forces its refresh. */
  catalog: ReturnType<typeof createModelCatalog>;
  /** Replaces the /api/tags answer: what Ollama has installed. */
  setTags(tags: typeof TAGS): void;
  /** What the rig's Ollama lists on /api/ps: an unload (keep_alive 0) takes a row out, a preload puts one in. */
  ps: PsRow[];
  /** The memory owner, when the rig was built with `loader`. */
  memory: MemoryOwner | undefined;
  loader: ModelLoader | undefined;
  waitFor<C extends Channel>(channel: C, match: (p: Payload<C>) => boolean, timeoutMs?: number): Promise<Payload<C>>;
}

/**
 * `image` builds an image module over the rig's GPU lease; only then does the app get a lease.
 * `loader` gives the app the model loader and the memory owner services.ts gives it, so a send
 * takes the load gate and its handoff. `ps` is what Ollama has in memory at the start; `onUnload`
 * runs when an unload request takes a row out (a test moves the GPU and RAM readings there).
 */
async function rig(opts: { ollamaUp?: boolean; image?: (lease: GpuLease, store: ThreadStore, dir: string, memory?: MemoryOwner) => ImageModule; show?: unknown; admit?: () => void; onTerminal?: () => void; onDelta?: (turnId: string) => void; log?: (line: string) => void; dbPath?: string; draftEveryMs?: number; settings?: AppDeps["settings"]; loader?: boolean; ps?: PsRow[]; tags?: typeof TAGS; gpu?: Partial<Gpu>; onUnload?: (model: string) => void; engine?: () => MemoryEngine | undefined } = {}): Promise<Rig> {
  const ollamaUp = opts.ollamaUp ?? true;
  let chat: ChatRoute = quickReply;
  let show: ChatRoute = (res) => json(res, 200, opts.show ?? SHOW);
  let tags = opts.tags ?? TAGS;
  const ps: PsRow[] = [...(opts.ps ?? [])];
  const ollama = await startFakeServer({
    "GET /": (_b, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("Ollama is running");
    },
    "GET /api/version": (_b, res) => json(res, 200, { version: "0.0.9-fake" }),
    "GET /api/tags": (_b, res) => json(res, 200, tags),
    "GET /api/ps": (_b, res) => json(res, 200, { models: ps }),
    "POST /api/show": (body, res) => show(res, body),
    "POST /api/chat": (body, res) => {
      // With the loader, a chat request loads its model the way Ollama does.
      const { model, options } = body as { model: string; options?: { num_ctx?: number } };
      if (opts.loader && !ps.some((m) => m.name === model)) {
        const size = tags.models.find((m) => m.name === model)?.size ?? 0;
        ps.push({ name: model, size, size_vram: size, ...(options?.num_ctx === undefined ? {} : { context_length: options.num_ctx }) });
      }
      return chat(res, body);
    },
    // Ollama's own: keep_alive 0 unloads the model; an empty prompt loads it at its num_ctx.
    "POST /api/generate": (body, res) => {
      const { model, keep_alive, options } = body as { model: string; keep_alive?: unknown; options?: { num_ctx?: number } };
      if (keep_alive === 0) {
        const at = ps.findIndex((m) => m.name === model);
        if (at >= 0) {
          ps.splice(at, 1);
          opts.onUnload?.(model);
        }
        return json(res, 200, { model, response: "", done: true, done_reason: "unload" });
      }
      const size = tags.models.find((m) => m.name === model)?.size ?? 0;
      if (!ps.some((m) => m.name === model)) ps.push({ name: model, size, size_vram: size, ...(options?.num_ctx === undefined ? {} : { context_length: options.num_ctx }) });
      return json(res, 200, { model, response: "", done: true, done_reason: "load" });
    },
  });
  cleanups.push(() => ollama.close());

  const dir = cacheTmp();
  const store = openThreadStore(opts.dbPath ?? path.join(dir, "threads.sqlite"));
  cleanups.push(() => store.close());
  // Both ports are ours: the fake (or a dead port) as external, a free port
  // for the app-owned slot, so classify never probes 11434 or 11435.
  const external = ollamaUp ? ollama.baseUrl : `http://127.0.0.1:${await freePort()}`;
  const runtime = createOllamaRuntime({
    externalBaseUrl: external,
    appPort: await freePort(),
    appDataDir: path.join(dir, "appdata"),
    allowInstall: false,
    env: { PATH: "" },
    // Not this machine's home: on Windows an installed Ollama in its
    // %LOCALAPPDATA%\Programs would read as "stopped" instead of missing.
    home: path.join(dir, "home"),
    systemModelsDirs: [],
    probeTimeoutMs: 500,
  });
  const catalog = createModelCatalog(() => runtime.baseUrl());
  cleanups.push(() => catalog.stop()); // no discovery retry outlives the test (MP2-04)
  const gpu: Gpu = { freeMib: 15000, memAvailableKb: 30_000_000, ...opts.gpu };
  const storedAtDonePush: number[] = [];
  const replayedAtDone: Payload<"chat.event">[] = [];
  const fitReads = {
    runNvidiaSmi: async (args: readonly string[]) => {
      if (!args[0]?.startsWith("--query-gpu")) return gpu.apps ?? "";
      const total = gpu.totalMib ?? 16303;
      return `${total}, ${gpu.usedMib ?? total - gpu.freeMib}, ${gpu.freeMib}\n`;
    },
    // A send judges system memory by what the computer has, so a test that wants a refusal for
    // memory needs a small computer, not a busy one: under 2 GB free here is a 3 GB machine.
    readMeminfo: async () => `MemTotal: ${gpu.memAvailableKb < 2_000_000 ? 3_000_000 : 32541464} kB\nMemAvailable: ${gpu.memAvailableKb} kB\n`,
  };

  let server: WsServer | undefined;
  const lease = opts.image || opts.loader ? createGpuLease() : undefined;
  // As services.ts wires them: one memory owner, its gate the loader's.
  let loader: ModelLoader | undefined;
  let imageModule: ImageModule | undefined;
  const memory = opts.loader
    ? createMemoryOwner({
        ollamaUrl: () => runtime.baseUrl(),
        listLoaded: (url, signal) => listLoaded(url, undefined, signal),
        replying: () => loader?.replying() ?? [],
        engine: opts.engine ?? (() => imageModule),
        readFree: async () => gpu.freeMib * 1024 ** 2,
        onUnloaded: (model) => loader?.unloaded(model),
        waitMs: 2000,
        pollMs: 20,
      })
    : undefined;
  if (memory) {
    loader = createModelLoader({
      baseUrl: () => runtime.baseUrl(),
      push: () => undefined,
      listLoaded: (url, signal) => listLoaded(url, undefined, signal),
      fit: async (model, numCtx, baseUrl, signal) => (await planLoad({ ...fitReads, baseUrl, model, numCtx, signal, busy: loader?.busyModels() ?? [] })).report,
      memory,
      ...(lease ? { lease } : {}),
    });
    const made = loader;
    cleanups.push(() => made.close());
  }
  imageModule = lease && opts.image ? opts.image(lease, store, dir, memory) : undefined;
  const app: App = createApp({
    dataDir: dir,
    store,
    runtime: createRuntimeSwitch({ initialMode: "system", make: () => runtime }),
    catalog,
    ...(loader ? { models: { handlers: {}, loader }, ...(lease && !opts.image ? { lease } : {}) } : {}),
    ...(opts.admit ? { admit: opts.admit } : {}),
    ...(opts.draftEveryMs === undefined ? {} : { draftEveryMs: opts.draftEveryMs }),
    ...(opts.settings === undefined ? {} : { settings: opts.settings }),
    // Tools › Make images on: a send with tools: true offers the chat model the image tool.
    ...(lease && imageModule ? { lease, image: imageModule, imageTool: () => ({ preset: "z-image-int8", width: 1024, height: 1024 }) } : {}),
    push: (c, p) => {
      if (c === "chat.event") {
        const { turnId, threadId, event } = p as Payload<"chat.event">;
        if (event.type === "delta") opts.onDelta?.(turnId);
        if (event.type === "done") {
          storedAtDonePush.push(store.getThread(threadId).messages.length);
          app.replayTurns((channel, payload) => { if (channel === "chat.event") replayedAtDone.push(payload as Payload<"chat.event">); });
        }
        if (event.type === "done" || event.type === "error") opts.onTerminal?.();
      }
      server?.push(c, p);
    },
    fit: fitReads,
    log: opts.log ?? (() => undefined),
  });
  cleanups.push(() => app.shutdown());
  server = await startWsServer({ port: 0, token: TOKEN, allowedOrigins: [], handlers: app.handlers, onClientReady: (push) => app.replayTurns(push), log: () => undefined });
  const ws = server;
  cleanups.push(() => ws.close());

  const sock = new WebSocket(`ws://127.0.0.1:${server.port}/?token=${TOKEN}`);
  cleanups.push(() => sock.terminate());
  const protocolErrors: WireError[] = [];
  const client = createClient(sock as unknown as SocketLike, { timeoutMs: 5000, onProtocolError: (e) => protocolErrors.push(e) });
  cleanups.push(() => expect(protocolErrors).toEqual([]));
  await new Promise<void>((resolve, reject) => {
    sock.once("open", () => resolve());
    sock.once("error", reject);
  });

  const pushes: Rig["pushes"] = [];
  const waiters = new Set<() => void>();
  for (const channel of ["chat.event", "runtime.changed", "models.changed", "threads.changed", "models.speed", "fit.changed"] as const) {
    client.subscribe(channel, (payload) => {
      pushes.push({ channel, payload });
      for (const w of waiters) w(); // a waiter deleting itself mid-iteration is safe on a Set
    });
  }
  const waitFor: Rig["waitFor"] = (channel, match, timeoutMs = 3000) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const hit = pushes.find((p) => p.channel === channel && match(p.payload as never));
        if (hit === undefined) return false;
        waiters.delete(check);
        clearTimeout(timer);
        resolve(hit.payload as never);
        return true;
      };
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`no ${channel} push matched within ${timeoutMs} ms; saw ${JSON.stringify(pushes)}`));
      }, timeoutMs);
      if (!check()) waiters.add(check);
    });

  // The pushes below come from this discover(): runtime.changed, then the
  // catalog refresh it triggers, then models.changed.
  await runtime.discover();
  return { app, server, client, store, runtime, ollama, gpu, lease, setChat: (r) => (chat = r), setShow: (r) => (show = r), pushes, storedAtDonePush, replayedAtDone, catalog, setTags: (t) => (tags = t), waitFor, ps, memory, loader };
}

const turnEvents = (r: Rig, turnId: string) =>
  r.pushes.filter((p) => p.channel === "chat.event" && (p.payload as Payload<"chat.event">).turnId === turnId).map((p) => (p.payload as Payload<"chat.event">).event);
/** The turn's events but its reply records (decision 33), which `stages` reads on their own. */
const events = (r: Rig, turnId: string) => turnEvents(r, turnId).filter((e) => e.type !== "reply");
/** The stages the turn's reply records went through, in order. */
const stages = (r: Rig, turnId: string) => turnEvents(r, turnId).flatMap((e) => (e.type === "reply" ? [e.reply.stage] : []));

/**
 * chat.send over the socket, then the turn's start (chat row 32): the answer names the turn, its
 * start brings the saved question, and a refusal after the answer is its error event, thrown here
 * as the WireError a refused answer would be.
 */
async function sendStarted(r: Rig, params: Params<"chat.send">): Promise<{ turnId: string; userMessage: Message; replayed?: boolean }> {
  const answer = await r.client.call("chat.send", params);
  if (answer.userMessage !== undefined) return { ...answer, userMessage: answer.userMessage };
  const first = await r.waitFor("chat.event", (p) => p.turnId === answer.turnId && (p.event.type === "start" || p.event.type === "error"), 10_000);
  if (first.event.type === "error") throw new WireError(first.event.code, first.event.message, first.event.blocking);
  if (first.event.type !== "start") throw new Error("unreachable");
  return { turnId: answer.turnId, userMessage: first.event.userMessage };
}

it("vision paste reaches the model, saves paths, and survives Retry and thread reload", async () => {
  const r = await rig({ show: { ...(SHOW as Record<string, unknown>), capabilities: ["completion", "vision"] } });
  const thread = await r.client.call("threads.create", { title: "Pasted images" });
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOor6//DwAFewJ94ITM6gAAAABJRU5ErkJggg==";
  const first = await sendStarted(r, { threadId: thread.id, content: "look", model: MODEL, numCtx: 16384, images: [`data:image/png;base64,${png}`] });
  await r.waitFor("chat.event", p => p.turnId === first.turnId && p.event.type === "done");
  expect(first.userMessage.images?.[0]).toMatch(/^images\/paste-.*\.png$/);
  const loaded = await r.client.call("threads.get", { threadId: thread.id });
  expect(loaded.messages[0]?.images).toEqual(first.userMessage.images);
  const again = await sendStarted(r, { threadId: thread.id, content: "look again", model: MODEL, numCtx: 16384, images: first.userMessage.images });
  await r.waitFor("chat.event", p => p.turnId === again.turnId && p.event.type === "done");
  const body = r.ollama.requests.filter(q => q.path === "/api/chat").at(-1)?.body;
  expect(body).toMatchObject({ messages: [{ role: "user", content: "look", images: [png] }, { role: "assistant" }, { role: "user", content: "look again", images: [png] }], options: { num_ctx: 16384 } });
  expect((body as { options: unknown }).options).not.toHaveProperty("num_gpu");
});

it("the server refuses pasted images on non-vision models before a load or saved message", async () => {
  const r = await rig({ show: { ...(SHOW as Record<string, unknown>), capabilities: ["completion"] } });
  const thread = await r.client.call("threads.create", { title: "Pasted images" });
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOor6//DwAFewJ94ITM6gAAAABJRU5ErkJggg==";
  await expect(sendStarted(r, { threadId: thread.id, content: "look", model: MODEL, numCtx: 16384, images: [`data:image/png;base64,${png}`] })).rejects.toMatchObject({ code: "image-input", message: expect.stringContaining("cannot see images") });
  expect(r.store.getThread(thread.id).messages).toEqual([]);
  expect(r.ollama.requests.filter(q => q.path === "/api/chat")).toEqual([]);
});

it("an image-only turn uses T3's model prompt while the saved message stays image-only", async () => {
  const r = await rig({ show: { ...(SHOW as Record<string, unknown>), capabilities: ["completion", "vision"] } });
  const thread = r.store.createThread();
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOor6//DwAFewJ94ITM6gAAAABJRU5ErkJggg==";
  const sent = await sendStarted(r, { threadId: thread.id, content: "", model: MODEL, numCtx: 16384, images: [`data:image/png;base64,${png}`] });
  await r.waitFor("chat.event", p => p.turnId === sent.turnId && p.event.type === "done");
  expect(sent.userMessage.content).toBe("");
  expect(r.ollama.requests.find(q => q.path === "/api/chat")?.body).toMatchObject({ messages: [{ content: "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]", images: [png] }] });
});

it.each([false, true])("PC-03: retrying after a lost acknowledgement returns the saved message without a second turn (finished: %s)", async finished => {
  const r = await rig();
  const thread = r.store.createThread();
  const input = { threadId: thread.id, messageId: "public-lost-ack", content: "saved before disconnect", model: MODEL, numCtx: 16384 };
  const first = await sendStarted(r, input);
  if (finished) await r.waitFor("chat.event", p => p.turnId === first.turnId && p.event.type === "done");
  const retry = await sendStarted(r, input);
  await r.waitFor("chat.event", p => p.turnId === first.turnId && p.event.type === "done");
  expect(r.store.getThread(thread.id).messages.filter(m => m.role === "user")).toHaveLength(1);
  expect(retry.userMessage.id).toBe(first.userMessage.id);
  expect(r.ollama.requests.filter(q => q.path === "/api/chat")).toHaveLength(1);
  await expect(sendStarted(r, { ...input, content: "different words" })).rejects.toMatchObject({ code: "image-input" });
});

it("tells the model, and only the model, when a text-only follow-up omits earlier images", async () => {
  const r = await rig({ show: { ...(SHOW as Record<string, unknown>), capabilities: ["completion", "vision"] } });
  const thread = r.store.createThread();
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOor6//DwAFewJ94ITM6gAAAABJRU5ErkJggg==";
  const first = await sendStarted(r, { threadId: thread.id, content: "chart", model: MODEL, numCtx: 16384, images: [`data:image/png;base64,${png}`] });
  await r.waitFor("chat.event", p => p.turnId === first.turnId && p.event.type === "done");
  r.setShow(res => json(res, 200, { ...(SHOW as Record<string, unknown>), capabilities: ["completion"] }));
  r.setChat(slowReply);
  const next = await sendStarted(r, { threadId: thread.id, content: "read chart", model: MODEL, numCtx: 16384 });
  await r.waitFor("chat.event", p => p.turnId === next.turnId && p.event.type === "delta" && p.event.text !== "");
  const replayed: Payload<"chat.event">[] = [];
  r.app.replayTurns((channel, payload) => { if (channel === "chat.event") replayed.push(payload as Payload<"chat.event">); });
  await r.waitFor("chat.event", p => p.turnId === next.turnId && p.event.type === "done");
  expect(JSON.stringify(r.ollama.requests.filter(q => q.path === "/api/chat").at(-1)?.body)).toContain("image was here and is unavailable");
  // the person sees nothing of it (owner, chat row 17): not live, not replayed, not saved
  expect(JSON.stringify([replayed, events(r, next.turnId)])).not.toContain("contextNotice");
  expect(r.store.getThread(thread.id).messages.at(-1)).not.toHaveProperty("contextNotice");
  expect(r.store.getThread(thread.id).messages[0]?.content).toBe("chart");
});

it("thread deletion removes its unshared pasted image file", async () => {
  const r = await rig({ show: { ...(SHOW as Record<string, unknown>), capabilities: ["completion", "vision"] } });
  const thread = r.store.createThread();
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOor6//DwAFewJ94ITM6gAAAABJRU5ErkJggg==";
  const sent = await sendStarted(r, { threadId: thread.id, content: "chart", model: MODEL, numCtx: 16384, images: [`data:image/png;base64,${png}`] });
  await r.waitFor("chat.event", p => p.turnId === sent.turnId && p.event.type === "done");
  const filename = path.join(path.dirname(r.store.dbPath), sent.userMessage.images![0]!);
  expect(existsSync(filename)).toBe(true);
  await r.client.call("threads.delete", { threadId: thread.id });
  expect(existsSync(filename)).toBe(false);
});

it("a shared image survives until the last saved message is removed", async () => {
  const r = await rig({ show: { ...(SHOW as Record<string, unknown>), capabilities: ["completion", "vision"] } });
  const first = r.store.createThread(), second = r.store.createThread();
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOor6//DwAFewJ94ITM6gAAAABJRU5ErkJggg==";
  const sent = await sendStarted(r, { threadId: first.id, content: "chart", model: MODEL, numCtx: 16384, images: [`data:image/png;base64,${png}`] });
  await r.waitFor("chat.event", p => p.turnId === sent.turnId && p.event.type === "done");
  const images = [...sent.userMessage.images!], filename = path.join(path.dirname(r.store.dbPath), images[0]!);
  const copy = r.store.appendMessage({ threadId: second.id, role: "user", content: "shared", images });
  await r.client.call("threads.delete", { threadId: first.id });
  expect(existsSync(filename)).toBe(true);
  await r.client.call("messages.delete", { threadId: second.id, messageId: copy.id });
  expect(existsSync(filename)).toBe(false);
});

it.each(["threads.delete", "messages.delete"] as const)("%s still removes its images after the start-up image sweep failed", async method => {
  const lifecycle = imageFiles.imageLifecycle;
  const sweep = vi.fn().mockRejectedValue(new Error("EACCES: image folder denied"));
  const factory = vi.spyOn(imageFiles, "imageLifecycle").mockImplementation((...args) => ({ ...lifecycle(...args), sweep }));
  try {
    const logs: string[] = [];
    const r = await rig({ log: message => logs.push(message) });
    const thread = r.store.createThread();
    const images = await saveAttachments(path.dirname(r.store.dbPath), ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOor6//DwAFewJ94ITM6gAAAABJRU5ErkJggg=="]);
    const message = r.store.appendMessage({ threadId: thread.id, role: "user", content: "chart", images });
    const filename = path.join(path.dirname(r.store.dbPath), images[0]!);
    expect(existsSync(filename)).toBe(true);
    const result = method === "threads.delete"
      ? await r.client.call(method, { threadId: thread.id })
      : await r.client.call(method, { threadId: thread.id, messageId: message.id });
    expect(result).toEqual(method === "threads.delete" ? { threadId: thread.id } : { messageId: message.id });
    expect(existsSync(filename)).toBe(false);
    // every later wait on the same sweep stays quiet: one report, not one per call
    const other = r.store.createThread();
    await r.client.call("threads.delete", { threadId: other.id });
    expect(logs.filter(entry => /image sweep.*EACCES/.test(entry))).toHaveLength(1);
  } finally { factory.mockRestore(); }
});

it.each(["threads.delete", "messages.delete"] as const)("TT-01: %s succeeds and publishes after image collection fails", async method => {
  const lifecycle = imageFiles.imageLifecycle;
  const collect = vi.fn().mockRejectedValue(new Error("EACCES: image cleanup denied"));
  const factory = vi.spyOn(imageFiles, "imageLifecycle").mockImplementation((...args) => ({ ...lifecycle(...args), collect }));
  try {
    const logs: string[] = [];
    const r = await rig({ log: message => logs.push(message) });
    const thread = r.store.createThread();
    const images = await saveAttachments(path.dirname(r.store.dbPath), ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOor6//DwAFewJ94ITM6gAAAABJRU5ErkJggg=="]);
    const message = r.store.appendMessage({ threadId: thread.id, role: "user", content: "chart", images });
    const result = method === "threads.delete"
      ? await r.client.call(method, { threadId: thread.id })
      : await r.client.call(method, { threadId: thread.id, messageId: message.id });
    expect(result).toEqual(method === "threads.delete" ? { threadId: thread.id } : { messageId: message.id });
    if (method === "threads.delete") expect(() => r.store.getThread(thread.id)).toThrow();
    else expect(r.store.getThread(thread.id).messages).toEqual([]);
    await r.waitFor("threads.changed", payload => payload.threadId === thread.id);
    expect(collect).toHaveBeenCalledWith(images);
    expect(logs).toContainEqual(expect.stringMatching(/image cleanup.*EACCES/));
    expect(existsSync(path.join(path.dirname(r.store.dbPath), images[0]!))).toBe(true);
  } finally { factory.mockRestore(); }
});

it("failed admission leaves no new image file", async () => {
  const r = await rig({ show: { ...(SHOW as Record<string, unknown>), capabilities: ["completion", "vision"] } });
  const thread = r.store.createThread();
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOor6//DwAFewJ94ITM6gAAAABJRU5ErkJggg==";
  const append = vi.spyOn(r.store, "appendMessage").mockImplementationOnce(() => { throw new Error("synthetic database write failure"); });
  await expect(sendStarted(r, { threadId: thread.id, content: "chart", model: MODEL, numCtx: 16384, images: [`data:image/png;base64,${png}`] })).rejects.toThrow("synthetic database write failure");
  append.mockRestore();
  expect(readdirSync(path.join(path.dirname(r.store.dbPath), "images"))).toEqual([]);
});

it("a draft referencing an image that is gone is refused in plain words before saving", async () => {
  const r = await rig({ show: { ...(SHOW as Record<string, unknown>), capabilities: ["completion", "vision"] } });
  const thread = r.store.createThread();
  await expect(sendStarted(r, { threadId: thread.id, content: "keep my words", model: MODEL, numCtx: 16384, images: ["images/paste-00000000-0000-4000-8000-000000000000.png"] })).rejects.toMatchObject({ code: "image-input", message: expect.stringContaining("Paste it again; your words are kept") });
  expect(r.store.getThread(thread.id).messages).toEqual([]);
  expect(r.ollama.requests.filter(q => q.path === "/api/chat")).toEqual([]);
});

async function rejection(p: Promise<unknown>): Promise<WireError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WireError) return e;
    throw e;
  }
  throw new Error("expected the call to fail");
}

// ----------------------------------------------------------------- tests

describe("pushes from the runtime and the catalog", () => {
  it("runtime.changed on discover, then models.changed from the refresh it triggers", async () => {
    const r = await rig();
    const status = await r.waitFor("runtime.changed", (s) => s.state === "ready");
    expect(status).toMatchObject({ state: "ready", owner: "external", baseUrl: r.ollama.baseUrl, version: "0.0.9-fake" });
    const models = await r.waitFor("models.changed", (m) => m.length === 1);
    expect(models[0]).toMatchObject({ name: MODEL, sizeBytes: 6594474711 });
    expect(await r.client.call("runtime.status", {})).toMatchObject({ state: "ready" });
    expect((await r.client.call("models.list", {})).map((m) => m.name)).toEqual([MODEL]);
    expect((await r.client.call("models.refresh", {})).map((m) => m.name)).toEqual([MODEL]);
  });
});

describe("threads.*", () => {
  it("create, list, rename, get and delete go straight to the store and push threads.changed", async () => {
    const r = await rig();
    const t = await r.client.call("threads.create", { title: "First" });
    await r.waitFor("threads.changed", (p) => p.threadId === t.id);
    expect((await r.client.call("threads.list", {})).map((x) => x.id)).toEqual([t.id]);
    expect((await r.client.call("threads.rename", { threadId: t.id, title: "Second" })).title).toBe("Second");
    expect(await r.client.call("threads.get", { threadId: t.id })).toEqual({ thread: expect.objectContaining({ title: "Second" }), messages: [] });
    expect(await r.client.call("threads.delete", { threadId: t.id })).toEqual({ threadId: t.id });
    expect((await rejection(r.client.call("threads.get", { threadId: t.id }))).code).toBe("thread-not-found");
  });
});

describe("chat.send", () => {
  it("answers with the turn id before any event of that turn reaches the socket (chat row 32)", async () => {
    const r = await rig();
    const thread = await r.client.call("threads.create", { title: "answer first" });
    let answered = false;
    const firstEvent: Array<{ type: string; answered: boolean }> = [];
    const off = r.client.subscribe("chat.event", (p) => { if (firstEvent.length === 0) firstEvent.push({ type: p.event.type, answered }); });
    cleanups.push(off);
    const answer = await r.client.call("chat.send", { threadId: thread.id, content: "hello", model: MODEL, numCtx: 16384 }).then((a) => { answered = true; return a; });
    expect(answer).toEqual({ turnId: expect.any(String) });
    await r.waitFor("chat.event", (p) => p.turnId === answer.turnId && p.event.type === "done");
    expect(firstEvent).toEqual([{ type: "start", answered: true }]);
  });

  it.each([false, true])("TE-02: a reply starting before the first request crosses the snapshot boundary once (already finished: %s)", async (finishedFirst) => {
    const r = await rig();
    let response: ServerResponse | undefined;
    r.setChat((res) => {
      response = res;
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(piece("one "));
    });
    const thread = await r.client.call("threads.create", { title: "join before start" });
    const socket = new WebSocket(`ws://127.0.0.1:${r.server.port}/?token=${TOKEN}`);
    cleanups.push(() => socket.terminate());
    const newcomer = createClient(socket as unknown as SocketLike);
    const joined: Payload<"chat.event">[] = [];
    newcomer.subscribe("chat.event", (event) => joined.push(event));
    await new Promise<void>((resolve) => socket.once("open", resolve));
    const receivedEarlierFrames = () => new Promise<void>((resolve) => { socket.once("pong", () => resolve()); socket.ping(); });
    const sent = await sendStarted(r, { threadId: thread.id, content: "hello", model: MODEL, numCtx: 16384 });
    await r.waitFor("chat.event", (event) => event.turnId === sent.turnId && event.event.type === "delta");
    await receivedEarlierFrames();
    expect.soft(joined.length).toBe(0);
    const reply = response;
    if (reply === undefined) throw new Error("No held model response");
    const finish = () => { reply.write(piece("two ")); reply.end(doneLine); };
    if (finishedFirst) {
      finish();
      await r.waitFor("chat.event", (event) => event.turnId === sent.turnId && event.event.type === "done");
      await receivedEarlierFrames();
    }
    // This is the newcomer's first request; its chat subscriptions are already installed.
    await newcomer.call("threads.get", { threadId: thread.id });
    if (!finishedFirst) {
      finish();
      await r.waitFor("chat.event", (event) => event.turnId === sent.turnId && event.event.type === "done");
    }
    const history = await newcomer.call("threads.get", { threadId: thread.id });
    expect(history.messages.map((message) => [message.role, message.content])).toEqual([["user", "hello"], ["assistant", "one two "]]);
    if (finishedFirst) {
      // A completed reply comes from durable history, with no stale live replay.
      expect(joined.length).toBe(0);
    } else {
      expect.soft(joined.filter((event) => event.event.type === "start")).toHaveLength(1);
      expect(joined.flatMap((event) => event.event.type === "delta" ? [event.event.text] : []).join("")).toBe("one two ");
      expect(joined.filter((event) => event.event.type === "done")).toHaveLength(1);
    }
  });

  it("a late client receives an in-flight snapshot once, without replaying words to existing clients", async () => {
    const r = await rig();
    r.setChat(slowReply);
    const thread = await r.client.call("threads.create", { title: "late join" });
    await sendStarted(r, { threadId: thread.id, content: "hello", model: MODEL, numCtx: 16384 });
    await r.waitFor("chat.event", (p) => p.event.type === "delta");
    const socket = new WebSocket(`ws://127.0.0.1:${r.server.port}/?token=${TOKEN}`);
    cleanups.push(() => socket.terminate());
    const client = createClient(socket as unknown as SocketLike);
    const joined: Payload<"chat.event">[] = [];
    client.subscribe("chat.event", (event) => joined.push(event));
    await new Promise<void>((resolve) => socket.once("open", resolve));
    await client.call("threads.list", {});
    await vi.waitFor(() => expect(joined.filter((p) => p.event.type === "start")).toHaveLength(1), { timeout: 1000 });
    await vi.waitFor(() => expect(joined.some((p) => p.event.type === "done")).toBe(true), { timeout: 2000 });
    const words = joined.flatMap((p) => p.event.type === "delta" ? [p.event.text] : []).join("");
    expect(words).toBe("one two three four ");
    const originalWords = r.pushes.flatMap((p) => {
      if (p.channel !== "chat.event") return [];
      const event = (p.payload as Payload<"chat.event">).event;
      return event.type === "delta" ? [event.text] : [];
    }).join("");
    expect(originalWords).toBe(words);
  });

  it("streams every event, persists the done message before pushing done, and returns at once", async () => {
    let terminalSnapshot: unknown;
    const r = await rig({ onTerminal: () => { terminalSnapshot = r.app.handlers["turns.active"]?.({}, { clientId: 1 }); } });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let seenBody: unknown;
    r.setChat(async (res, body) => {
      seenBody = body;
      await gate; // hold the reply until chat.send has returned
      await stream(res, [piece("Two plus "), piece("two is four."), doneLine]);
    });
    const t = await r.client.call("threads.create", {});
    const sent = await sendStarted(r, { threadId: t.id, content: "2+2?", model: MODEL, numCtx: 16384 });
    expect(sent.userMessage).toMatchObject({ threadId: t.id, role: "user", content: "2+2?" });
    // returned before any reply byte; the start push came first, for every client (PH-02)
    expect(events(r, sent.turnId)).toEqual([{ type: "start", model: MODEL, userMessage: sent.userMessage }]);
    expect(r.app.activeTurns()).toBe(1);
    // a window that opens now gets the reply's record as it is: the model was in memory, but nothing has come back yet,
    // and the runtime may be holding it behind another reply, so it is waiting
    expect(await r.client.call("turns.active", {})).toEqual([{ threadId: t.id, turnId: sent.turnId, reply: expect.objectContaining({ stage: "waiting", attempt: 1 }) }]);

    // The store already has the user message; the turn is streaming.
    expect((await r.client.call("threads.get", { threadId: t.id })).messages.map((m) => m.role)).toEqual(["user"]);
    release();
    const done = await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "done");
    // A reconnect can read during asynchronous stream cleanup, after the last event.
    expect(await terminalSnapshot).toEqual([]);
    // The assistant message was in the store when the done event was pushed.
    expect(r.storedAtDonePush).toEqual([2]);
    expect(r.replayedAtDone).toEqual([]);

    expect(events(r, sent.turnId).map((e) => e.type)).toEqual(["start", "delta", "delta", "done"]);
    // every window drew the stage from the server: after the start, and once at the first word, not at every word
    expect(stages(r, sent.turnId)).toEqual(["waiting", "writing"]);
    if (done.event.type !== "done") throw new Error("unreachable");
    expect(done.event.stopReason).toBe("stop");
    expect(done.event.message).toMatchObject({
      threadId: t.id,
      role: "assistant",
      content: "Two plus two is four.",
      model: MODEL,
      stats: { promptTokens: 11, completionTokens: 3, durationMs: 500, numCtx: 16384 },
    });
    expect(seenBody).toMatchObject({ model: MODEL, options: { num_ctx: 16384 }, messages: [{ role: "user", content: "2+2?" }] });

    const got = await r.client.call("threads.get", { threadId: t.id });
    expect(got.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "2+2?"],
      ["assistant", "Two plus two is four."],
    ]);
    expect(got.messages[1]?.id).toBe(done.event.message.id);
    await r.waitFor("threads.changed", (p) => p.threadId === t.id);
    expect(r.app.activeTurns()).toBe(0);
    expect(await r.client.call("turns.active", {})).toEqual([]);
  });

  it("sends the whole thread as history on the next turn", async () => {
    const r = await rig();
    const bodies: unknown[] = [];
    r.setChat((res, body) => {
      bodies.push(body);
      return stream(res, [piece("ok"), doneLine]);
    });
    const t = await r.client.call("threads.create", {});
    const a = await sendStarted(r, { threadId: t.id, content: "one", model: MODEL, numCtx: 16384 });
    await r.waitFor("chat.event", (p) => p.turnId === a.turnId && p.event.type === "done");
    const b = await sendStarted(r, { threadId: t.id, content: "two", model: MODEL, numCtx: 16384 });
    await r.waitFor("chat.event", (p) => p.turnId === b.turnId && p.event.type === "done");
    expect((bodies[1] as { messages: unknown }).messages).toEqual([
      { role: "user", content: "one" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "two" },
    ]);
  });

  it("a second send on a streaming thread throws turn-active; another thread is free", async () => {
    const r = await rig();
    r.setChat((res) => stream(res, [piece("a"), piece("b"), piece("c"), doneLine], 100));
    const t = await r.client.call("threads.create", {});
    const other = await r.client.call("threads.create", {});
    const first = await sendStarted(r, { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 });
    const err = await rejection(sendStarted(r, { threadId: t.id, content: "y", model: MODEL, numCtx: 16384 }));
    expect(err.code).toBe("turn-active");
    expect(err.message).toContain(first.turnId);
    const parallel = await sendStarted(r, { threadId: other.id, content: "z", model: MODEL, numCtx: 16384 });
    await r.waitFor("chat.event", (p) => p.turnId === first.turnId && p.event.type === "done");
    await r.waitFor("chat.event", (p) => p.turnId === parallel.turnId && p.event.type === "done");
    // The refused send stored nothing.
    expect(r.store.getThread(t.id).messages.map((m) => m.content)).toEqual(["x", "abc"]);
  });

  it("two sends racing through the fit check still get one turn", async () => {
    const r = await rig();
    const t = await r.client.call("threads.create", {});
    const results = await Promise.allSettled([
      sendStarted(r, { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 }),
      sendStarted(r, { threadId: t.id, content: "y", model: MODEL, numCtx: 16384 }),
    ]);
    expect(results.map((x) => x.status).toSorted()).toEqual(["fulfilled", "rejected"]);
    const refused = results.find((x) => x.status === "rejected");
    expect((refused as PromiseRejectedResult).reason).toMatchObject({ code: "turn-active" });
  });

  it("throws runtime-not-ready when no Ollama answers, and stores nothing", async () => {
    const r = await rig({ ollamaUp: false });
    expect(r.runtime.status().state).toBe("missing");
    const t = await r.client.call("threads.create", {});
    const err = await rejection(sendStarted(r, { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 }));
    expect(err.code).toBe("runtime-not-ready");
    expect(err.message).toContain("missing");
    expect((await r.client.call("fit.table", {})).rows).toEqual([]);
    expect(r.store.getThread(t.id).messages).toEqual([]);
    expect(r.app.activeTurns()).toBe(0);
    expect(r.ollama.requests.filter((q) => q.path === "/api/chat")).toEqual([]);
  });

  it("throws wont-fit with the fit report's message on refuse; spills is allowed", async () => {
    const r = await rig();
    const t = await r.client.call("threads.create", {});
    r.gpu.freeMib = 3000;
    r.gpu.memAvailableKb = 1_000_000;
    const report = await freshRow(r, MODEL, 16384, "refuse");
    const err = await rejection(sendStarted(r, { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 }));
    expect(err.code).toBe("wont-fit");
    expect(err.message).toBe(report.message);
    expect(err.message).toMatch(/refused, short by/);
    expect(r.store.getThread(t.id).messages).toEqual([]);
    expect(r.ollama.requests.filter((q) => q.path === "/api/chat")).toEqual([]);

    r.gpu.freeMib = 6000;
    r.gpu.memAvailableKb = 40_000_000;
    await freshRow(r, MODEL, 16384, "spills");
    const sent = await sendStarted(r, { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 });
    await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "done");
  });
});

/** Builds a fit table now, as a new GPU reading does, and waits for one with this verdict for `model` at `numCtx`. */
async function freshRow(r: Rig, model: string, numCtx: number, verdict: string) {
  const at = (t: Payload<"fit.changed">) => t.rows.find((x) => x.model === model && x.numCtx === numCtx);
  const seen = Math.max(0, ...r.pushes.filter((p) => p.channel === "fit.changed").map((p) => (p.payload as Payload<"fit.changed">).reading.seq));
  r.app.fitTable.changed();
  return at(await r.waitFor("fit.changed", (t) => t.reading.seq > seen && at(t)?.verdict === verdict))!;
}

/** One turn against a fake whose /api/show is `show`; returns the chat request body. */
const sendWith = async (show: unknown, think: boolean) => {
  const r = await rig({ show });
  const bodies: Array<Record<string, unknown>> = [];
  r.setChat((res, body) => {
    bodies.push(body as Record<string, unknown>);
    return quickReply(res, body);
  });
  const t = await r.client.call("threads.create", {});
  const sent = await sendStarted(r, { threadId: t.id, content: "x", model: MODEL, numCtx: 16384, think });
  await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "done");
  return bodies[0]!;
};
/** The qwen3.5 show fixture with these capabilities, or with none listed. */
const caps = (capabilities: string[] | undefined) => {
  const { capabilities: _drop, ...rest } = SHOW as Record<string, unknown>;
  return capabilities === undefined ? rest : { ...rest, capabilities };
};

/** /api/show for a chat model whose own window is 2,048 tokens. */
const TINY_SHOW = {
  model_info: {
    "general.architecture": "tiny",
    "tiny.block_count": 4,
    "tiny.context_length": 2048,
    "tiny.attention.head_count": 4,
    "tiny.attention.head_count_kv": 4,
    "tiny.attention.key_length": 64,
    "tiny.attention.value_length": 64,
  },
  capabilities: ["completion"],
};

describe("the fit table", () => {
  it("builds once when a turn starts and once when it ends", async () => {
    const r = await rig();
    await fitSettled(r);
    const before = (await r.client.call("fit.table", {})).reading.seq;
    const t = await r.client.call("threads.create", {});
    const sent = await sendStarted(r, { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 });
    await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "done");
    await fitSettled(r);
    expect((await r.client.call("fit.table", {})).reading.seq).toBe(before + 2);
  });

  it("a finished download gives the new model its rows, with no restart", async () => {
    const r = await rig();
    await fitSettled(r);
    const PULLED = "pulled-here:9b";
    expect((await r.client.call("fit.table", {})).rows.some((row) => row.model === PULLED)).toBe(false);
    r.setTags({ models: [...TAGS.models, { ...TAGS.models[0]!, name: PULLED, model: PULLED, digest: "sha256:b" }] });
    // What the pull manager does when a download finishes (runtime/services.ts, onDone).
    await r.catalog.refresh({ force: true });
    const table = await r.waitFor("fit.changed", (t) => t.rows.some((row) => row.model === PULLED));
    expect(table.rows.filter((row) => row.model === PULLED).map((row) => row.numCtx)).toEqual([8192, 16384, 32768, 65536]);
  });
});

describe("a model with a 2,048 context window", () => {
  it("is allowed, runs at 2,048 when 16k is asked for, and says so in its stats", async () => {
    const r = await rig({ show: TINY_SHOW });
    const bodies: unknown[] = [];
    r.setChat((res, body) => {
      bodies.push(body);
      return quickReply(res, body);
    });
    // One row for the size it runs at, whatever context is offered.
    const rows = (await r.client.call("fit.table", {})).rows.filter((row) => row.model === MODEL);
    expect(rows).toEqual([expect.objectContaining({ verdict: "fits", numCtx: 2048 })]);
    expect(await r.client.call("models.list", {})).toEqual([expect.objectContaining({ name: MODEL, maxContext: 2048 })]);

    const t = await r.client.call("threads.create", {});
    const sent = await sendStarted(r, { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 });
    const done = await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "done");
    expect(bodies[0]).toMatchObject({ options: { num_ctx: 2048 } });
    expect(done.event).toMatchObject({ message: { stats: { numCtx: 2048 } } });
  });
});

describe("chat.send and the think flag", () => {
  it("sends think as asked to a model that can think", async () => {
    expect(await sendWith(caps(["completion", "thinking"]), true)).toMatchObject({ think: true });
    expect(await sendWith(caps(["completion", "thinking"]), false)).toMatchObject({ think: false });
  });

  it("leaves think off the request for a model whose capabilities lack thinking", async () => {
    expect(await sendWith(caps(["completion", "tools"]), true)).not.toHaveProperty("think");
  });

  it("keeps think as asked when Ollama lists no capabilities", async () => {
    expect(await sendWith(caps(undefined), true)).toMatchObject({ think: true });
  });

  it("cancel ends a turn whose think probe stalls at once and releases its GPU claim", async () => {
    const { r, sent } = await stalledThinkTurn();
    expect(await r.client.call("chat.cancel", { turnId: sent.turnId })).toEqual({ cancelled: true });
    const end = await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "error", 1000);
    expect(end.event).toMatchObject({ type: "error", code: "cancelled" });
    expect(r.app.activeTurns()).toBe(0);
    expect(r.lease?.status().holders).toBe(0);
    expect(r.ollama.requests.filter((q) => q.path === "/api/chat")).toEqual([]);
  });

  it("cancel during the installed system prompt's read ends the turn as cancelled, not as a failure", async () => {
    const { r, sent } = await stalledThinkTurn({ settings: { get: () => defaultSettings("system") } }, undefined);
    expect(await r.client.call("chat.cancel", { turnId: sent.turnId })).toEqual({ cancelled: true });
    const end = await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "error", 1000);
    expect(end.event).toMatchObject({ type: "error", code: "cancelled" });
    expect(r.app.activeTurns()).toBe(0);
    expect(r.ollama.requests.filter((q) => q.path === "/api/chat")).toEqual([]);
  });

  it("thread delete and shutdown do not wait on a stalled think probe", async () => {
    const a = await stalledThinkTurn();
    expect(await within(1000, a.r.client.call("threads.delete", { threadId: a.t.id }), "threads.delete")).toEqual({ threadId: a.t.id });
    expect(a.r.app.activeTurns()).toBe(0);
    const b = await stalledThinkTurn();
    await within(1000, b.r.app.shutdown(), "shutdown");
    expect(b.r.app.activeTurns()).toBe(0);
    expect(b.r.lease?.status().holders).toBe(0);
  });
});

/** Polls until `ok` holds; throws after `timeoutMs`. */
async function until(ok: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await sleep(10);
  }
}

/** `p`, or a rejection naming `what` once `ms` pass first. */
function within<T>(ms: number, p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} still pending after ${ms} ms`)), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/**
 * A started turn whose think probe never answers: the fit check's /api/show
 * answers, every later one hangs. The rig has a lease, so the turn holds a claim.
 */
/** The fit table reads /api/show too, after the runtime, the catalog or a job changes: let its builds finish. */
async function fitSettled(r: Rig): Promise<void> {
  await r.client.call("fit.table", {});
  for (let seen = -1; seen !== r.ollama.requests.length; ) {
    seen = r.ollama.requests.length;
    await sleep(60);
  }
}

/** With `settings` and no think asked, the stalled show is the one that reads the installed system prompt. */
async function stalledThinkTurn(more: Pick<Parameters<typeof rig>[0] & object, "settings"> = {}, think: boolean | undefined = true) {
  const r = await rig({ image: idleComfy("external", () => undefined).build, ...more });
  // The catalog reads each model's capabilities with /api/show too (runtime/models.ts), on the
  // runtime's ready event. Wait until it lists the model: its capabilities are then cached by
  // digest, so the stall below meets only the turn's own calls (fit check, then think probe).
  for (let i = 0; !(await r.client.call("models.list", {})).some((m) => m.name === MODEL); i += 1) {
    if (i > 100) throw new Error("the catalog never listed the model");
    await sleep(20);
  }
  await fitSettled(r);
  let shows = 0;
  r.setShow((res) => {
    shows += 1;
    if (shows === 1) json(res, 200, SHOW);
  });
  const t = await r.client.call("threads.create", {});
  const sent = await sendStarted(r, { threadId: t.id, content: "x", model: MODEL, numCtx: 16384, ...(think === undefined ? {} : { think }) });
  // The fit check, then the turn's start builds a fit table (its /api/show stalls too) beside the think probe.
  await until(() => shows === 3);
  expect(r.app.activeTurns()).toBe(1);
  expect(r.lease?.status().holders).toBe(1);
  return { r, t, sent };
}

/**
 * A fake image module: an idle ComfyUI with this owner (MainPID 4242 when the app's); stopIdle
 * claims the GPU alone, as image/module.ts does; leave is the handoff's ask (POST /free), and
 * `onFree` is what that gives back.
 */
function idleComfy(owner: "app" | "external" | "none", onStop: () => void, onFree: () => void = () => undefined) {
  let stops = 0;
  let frees = 0;
  let current = owner;
  const build = (lease: GpuLease) => ({
    current: () => ({ state: "ready", owner: current }),
    reclaimable: () => (current === "app" && stops === 0 ? 4242 : undefined),
    stopIdle: () => lease.run("image", undefined, async () => { stops += 1; onStop(); }),
    leave: async () => {
      if (current === "none") return "absent";
      frees += 1;
      onFree();
      return "freed";
    },
  }) as unknown as ImageModule;
  return { build, stops: () => stops, frees: () => frees, setOwner: (next: typeof owner) => (current = next) };
}

describe("chat.send frees an idle ComfyUI the app started", () => {
  it("asks it to free its memory (never stops it) and measures again when the turn would not fit beside it", async () => {
    let gpu: Gpu | undefined;
    const comfy = idleComfy("app", () => undefined, () => { if (gpu) { gpu.freeMib = 15000; delete gpu.apps; } });
    const r = await rig({ image: comfy.build, loader: true });
    gpu = r.gpu;
    const t = await r.client.call("threads.create", {});
    r.gpu.freeMib = 3000;
    r.gpu.memAvailableKb = 1_000_000;
    // The app's ComfyUI is listed holding what the turn needs beside the 3000 MiB free.
    r.gpu.apps = "4242, /usr/bin/python3 main.py --port 8188, 12000\n";
    const sent = await sendStarted(r, { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 });
    await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "done");
    expect(comfy.frees()).toBe(1);
    expect(comfy.stops()).toBe(0);
  });

  it("decides after the turn's claim: a ComfyUI an image job started while the turn waited is freed, and the turn admitted", async () => {
    let gpu: Gpu | undefined;
    const comfy = idleComfy("none", () => undefined, () => { if (gpu) gpu.freeMib = 15000; });
    const r = await rig({ image: comfy.build, loader: true });
    gpu = r.gpu;
    const t = await r.client.call("threads.create", {});
    // An image job holds the GPU alone; no ComfyUI the app started is up yet.
    const releaseImage = await r.lease!.acquire("image");
    const sending = sendStarted(r, { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 });
    await until(() => r.lease!.status().waiting.includes("chat"));
    // The job started ComfyUI and finished; it keeps its weights, so the turn would not fit beside it.
    comfy.setOwner("app");
    r.gpu.freeMib = 3000;
    r.gpu.memAvailableKb = 1_000_000;
    releaseImage();
    const sent = await sending;
    await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "done");
    expect(comfy.frees()).toBe(1);
    expect(comfy.stops()).toBe(0);
    expect(r.lease!.status()).toEqual({ holder: null, holders: 0, waiting: [] });
  });

  it("leaves it running when the turn fits beside it", async () => {
    const comfy = idleComfy("app", () => undefined);
    const r = await rig({ image: comfy.build });
    const t = await r.client.call("threads.create", {});
    const sent = await sendStarted(r, { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 });
    await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "done");
    expect(comfy.stops()).toBe(0);
  });

  it("never stops a ComfyUI the app did not start, and still refuses", async () => {
    const comfy = idleComfy("external", () => undefined);
    const r = await rig({ image: comfy.build });
    const t = await r.client.call("threads.create", {});
    r.gpu.freeMib = 3000;
    r.gpu.memAvailableKb = 1_000_000;
    const err = await rejection(sendStarted(r, { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 }));
    expect(err.code).toBe("wont-fit");
    expect(comfy.stops()).toBe(0);
  });
});

/**
 * The real image module against a fake remote ComfyUI (injected fetch and
 * socket): a remote host skips the VRAM fit, a custom URL never touches the
 * systemd unit, and no request leaves the process.
 */
const refuseUnit = async (): Promise<never> => { throw new Error("a custom ComfyUI URL must not touch the unit"); };

function fakeComfyImage() {
  const imageEvents: ImageEvent[] = [];
  const comfyCalls: string[] = [];
  let module: ImageModule | undefined;
  let dataDir = "";
  const build = (lease: GpuLease, store: ThreadStore, dir: string) => {
    dataDir = path.join(dir, "image-data");
    let socket: EventTarget | undefined;
    module = createImageModule({
      dataDir, lease, store,
      settings: () => ({ imageGen: true, comfyUrl: "http://remote-comfy:8188" }),
      lookupHost: async () => ["10.0.0.5"], localAddresses: () => [],
      service: { inspect: refuseUnit, start: refuseUnit, stop: refuseUnit },
      socket: () => {
        socket = Object.assign(new EventTarget(), { close() {} });
        Object.defineProperty(socket, "readyState", { value: 1 });
        return socket as unknown as globalThis.WebSocket; // the image client's DOM socket, not the ws import above
      },
      fetch: async (input) => {
        const { pathname } = new URL(String(input));
        comfyCalls.push(pathname);
        if (pathname === "/system_stats") return Response.json({ system: {}, devices: [] });
        if (pathname === "/object_info") return Response.json(comfyInfo(ZIMAGE_FILES));
        if (pathname === "/queue") return Response.json({ queue_running: [], queue_pending: [] });
        if (pathname === "/prompt") {
          queueMicrotask(() => socket?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "executing", data: { prompt_id: "p1", node: null } }) })));
          return Response.json({ prompt_id: "p1" });
        }
        if (pathname === "/history/p1") return Response.json({ p1: { outputs: { "8": { images: [{ filename: "out.png" }] } } } });
        if (pathname === "/view") return new Response(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        throw new Error(`unexpected ComfyUI request ${pathname}`);
      },
      push: (channel, payload) => { if (channel === "image.event") imageEvents.push(payload as ImageEvent); },
    });
    return module;
  };
  return { build, events: imageEvents, comfyCalls, module: () => module!, png: (jobId: string) => path.join(dataDir, "images", `${jobId}.png`) };
}

/**
 * The real image module over a managed ComfyUI: the default address with no
 * comfyUrl setting, so the module starts the user unit itself and owns it.
 * Fetch, socket and the unit are injected; no request leaves the process.
 */
function managedComfy(hooks: { onStart?: () => void; onStop?: () => void; onFree?: () => void } = {}) {
  const imageEvents: ImageEvent[] = [];
  const calls: string[] = [];
  const unit: Array<"start" | "stop"> = [];
  let up = false;
  let module: ImageModule | undefined;
  let dataDir = "";
  let prompts = 0;
  const finished = new Set<string>();
  const ctl = {
    /** Another client's prompt sits in ComfyUI's queue: stopIdle declines, and so does a render. */
    busy: false,
    /** The next prompt finishes only once this resolves. */
    holdNext: undefined as Promise<void> | undefined,
    /** While set, every /system_stats (health) answer waits on it. */
    health: undefined as Promise<void> | undefined,
  };
  const build = (lease: GpuLease, store: ThreadStore, dir: string, memory?: MemoryOwner) => {
    dataDir = path.join(dir, "image-data");
    let socket: EventTarget | undefined;
    module = createImageModule({
      dataDir, lease, store, requiredBytes: 1, idleMs: 60_000,
      settings: () => ({ imageGen: true }),
      ...(memory ? { memory } : {}),
      localAddresses: () => [], lookupHost: async () => { throw new Error("no DNS in tests"); },
      readGpu: async () => ({ freeBytes: 2 ** 40, holders: "none", tenants: [] }),
      service: {
        inspect: async () => ({ present: true, active: up, activeState: up ? "active" : "inactive", pid: up ? 4242 : 0 }),
        start: async () => { unit.push("start"); up = true; hooks.onStart?.(); },
        stop: async () => { unit.push("stop"); up = false; hooks.onStop?.(); },
      },
      socket: () => {
        socket = Object.assign(new EventTarget(), { close() {} });
        Object.defineProperty(socket, "readyState", { value: 1 });
        return socket as unknown as globalThis.WebSocket;
      },
      fetch: async (input) => {
        const { pathname } = new URL(String(input));
        calls.push(pathname);
        if (pathname === "/system_stats") {
          if (ctl.health) await ctl.health;
          return up ? Response.json({ system: {}, devices: [] }) : new Response("down", { status: 503 });
        }
        if (pathname === "/object_info") return Response.json(comfyInfo(ZIMAGE_FILES));
        if (pathname === "/queue") return Response.json({ queue_running: [], queue_pending: ctl.busy ? [[0, "someone-else"]] : [] });
        // The handoff's ask: ComfyUI lets go of its weights and stays up.
        if (pathname === "/free") {
          if (!up) return new Response("down", { status: 503 });
          hooks.onFree?.();
          return new Response(null, { status: 200 });
        }
        if (pathname === "/prompt") {
          prompts += 1;
          const id = `p${prompts}`;
          const hold = ctl.holdNext;
          ctl.holdNext = undefined;
          const s = socket;
          void (async () => {
            await hold;
            finished.add(id);
            s?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "executing", data: { prompt_id: id, node: null } }) }));
          })();
          return Response.json({ prompt_id: id });
        }
        if (pathname.startsWith("/history/")) {
          const id = decodeURIComponent(pathname.slice("/history/".length));
          return Response.json(finished.has(id) ? { [id]: { outputs: { "8": { images: [{ filename: "out.png" }] } } } } : {});
        }
        if (pathname === "/view") return new Response(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        throw new Error(`unexpected ComfyUI request ${pathname}`);
      },
      push: (channel, payload) => { if (channel === "image.event") imageEvents.push(payload as ImageEvent); },
    });
    return module;
  };
  const states = (jobId: string) => imageEvents.filter((e) => e.jobId === jobId).map((e) => e.state);
  const pngs = () => (existsSync(path.join(dataDir, "images")) ? readdirSync(path.join(dataDir, "images")) : []);
  return { build, ctl, events: imageEvents, calls, unit, states, pngs, module: () => module! };
}

const gate = () => {
  let open!: () => void;
  const shut = new Promise<void>((resolve) => (open = resolve));
  return { shut, open };
};

describe("chat.send asks an app-started ComfyUI to free its memory, never stops it", () => {
  it("a second image queued behind the turn waits; the turn's handoff frees ComfyUI once, measures and is admitted", async () => {
    let gpu: Gpu | undefined;
    const comfy = managedComfy({
      // Its weights stay resident after a job; POST /free gives them back.
      onStart: () => { if (gpu) { gpu.freeMib = 3000; gpu.memAvailableKb = 1_000_000; } },
      onFree: () => { if (gpu) gpu.freeMib = 15000; },
    });
    const r = await rig({ image: comfy.build, loader: true });
    gpu = r.gpu;
    cleanups.push(() => comfy.module().close());
    const image = comfy.module();
    // A first job starts ComfyUI: the app owns it now. Its first handoff asked ComfyUI to free too
    // (what an engine holds is unknown until then); its weights are in memory again after it.
    await image.wait((await image.generate({ prompt: "warm up" })).jobId);
    expect(image.current().owner).toBe("app");
    r.gpu.freeMib = 3000;
    r.gpu.memAvailableKb = 1_000_000;
    const freesBefore = comfy.calls.filter((c) => c === "/free").length;

    // Image A holds the GPU; the turn waits for its claim; image B queues behind the turn.
    const holdA = gate();
    comfy.ctl.holdNext = holdA.shut;
    const a = await image.generate({ prompt: "a" });
    await until(() => comfy.states(a.jobId).includes("running"));
    const t = await r.client.call("threads.create", {});
    const sending = sendStarted(r, { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 });
    await until(() => r.lease!.status().waiting.includes("chat"));
    const b = await image.generate({ prompt: "b" });
    await until(() => r.lease!.status().waiting.length === 2);
    expect(r.lease!.status().waiting).toEqual(["chat", "image"]);

    holdA.open();
    const sent = await within(3000, sending, "chat.send");
    await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "done");
    await image.wait(b.jobId);
    expect(comfy.states(a.jobId).at(-1)).toBe("done");
    expect(comfy.states(b.jobId).at(-1)).toBe("done");
    // The turn's handoff freed it once; image B after the turn found it empty and asked nothing.
    expect(comfy.calls.filter((c) => c === "/free")).toHaveLength(freesBefore + 1);
    expect(comfy.unit).toEqual(["start"]);
    expect(image.current().owner).toBe("app");
    expect(r.app.activeTurns()).toBe(0);
    expect(r.lease!.status()).toEqual({ holder: null, holders: 0, waiting: [] });
  });

  it("a ComfyUI another client keeps busy: no /free, then wont-fit saying why, no claim held", async () => {
    let gpu: Gpu | undefined;
    const comfy = managedComfy({ onStart: () => { if (gpu) { gpu.freeMib = 3000; gpu.memAvailableKb = 1_000_000; } } });
    const r = await rig({ image: comfy.build, loader: true });
    gpu = r.gpu;
    cleanups.push(() => comfy.module().close());
    const image = comfy.module();
    await image.wait((await image.generate({ prompt: "warm up" })).jobId);
    expect(image.current().owner).toBe("app");

    comfy.ctl.busy = true;
    const mark = comfy.calls.length;
    const t = await r.client.call("threads.create", {});
    const err = await rejection(within(3000, sendStarted(r, { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 }), "chat.send"));
    expect(err.code).toBe("wont-fit");
    expect(err.message).toContain(ENGINE_BUSY_NOTE);
    // The handoff read the queue, saw another client's job and sent nothing.
    expect(comfy.calls.slice(mark)).toContain("/queue");
    expect(comfy.calls.slice(mark)).not.toContain("/free");
    expect(comfy.unit).toEqual(["start"]);
    expect(image.current().owner).toBe("app");
    expect(r.app.activeTurns()).toBe(0);
    expect(r.lease!.status()).toEqual({ holder: null, holders: 0, waiting: [] });
    expect(r.store.getThread(t.id).messages).toEqual([]);
  });

  it("shutdown during the fit check after ComfyUI freed ends the turn as cancelled and lets the claim go (A2-01)", async () => {
    let gpu: Gpu | undefined;
    const comfy = managedComfy({
      onStart: () => { if (gpu) { gpu.freeMib = 3000; gpu.memAvailableKb = 1_000_000; } },
      onFree: () => { if (gpu) gpu.freeMib = 15000; },
    });
    const r = await rig({ image: comfy.build, loader: true });
    gpu = r.gpu;
    cleanups.push(() => comfy.module().close());
    const image = comfy.module();
    await image.wait((await image.generate({ prompt: "warm up" })).jobId);
    expect(image.current().owner).toBe("app");

    // The fit check after the handoff's /free never answers until released.
    await fitSettled(r);
    const stalled = gate();
    let shows = 0;
    r.setShow(async (res) => {
      shows += 1;
      await stalled.shut;
      return json(res, 503, { error: "late" });
    });
    const t = await r.client.call("threads.create", {});
    const sending = rejection(sendStarted(r, { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 }));
    await until(() => shows >= 1 && comfy.calls.includes("/free"));
    expect(comfy.unit).toEqual(["start"]);
    expect(r.lease!.status().holder).toBe("chat");

    await within(1000, r.app.shutdown(), "shutdown");
    expect((await within(1000, sending, "chat.send")).code).toBe("cancelled");
    expect(r.app.activeTurns()).toBe(0);
    expect(r.lease!.status()).toEqual({ holder: null, holders: 0, waiting: [] });
    // The late answer changes nothing: the turn already ended as cancelled.
    stalled.open();
    await sleep(50);
    expect(r.store.getThread(t.id).messages).toEqual([]);
  });
});

// ------------------------------------------------- one thing in memory

const MIB = 1024 ** 2;
/** kB of `gib` GiB, as /proc/meminfo says it. */
const kbOf = (gib: number) => Math.round(gib * 1024 * 1024);
/** qwen3.5:4b as /api/ps listed it on the 6 GiB laptop (Windows report WIN-MEM-01). */
const QWEN_4B: PsRow = { name: "qwen3.5:4b", size: 3_553_760_377, size_vram: 3_553_760_377, context_length: 4096 };
/** With the show fixture's layers, this file size makes gemma4:e4b at 16,384 need 8,200,560,697 bytes: the report's estimate. */
const E4B_BYTES = 6_589_947_961;
const LAPTOP_TAGS = {
  models: [
    { name: "qwen3.5:4b", model: "qwen3.5:4b", size: 3_386_000_000, digest: "sha256:q4", modified_at: "2026-11-01T10:00:00Z" },
    { name: "gemma4:e4b", model: "gemma4:e4b", size: E4B_BYTES, digest: "sha256:e4", modified_at: "2026-11-01T10:00:00Z" },
    ...TAGS.models,
  ],
};
/** whisper on the GPU: measured, never asked anything. */
const WHISPER_ROW = "2101, /usr/bin/whisper-server, 180\n";

describe("one thing in memory: a send asks the rest to leave, then measures", () => {
  it("WIN-MEM-01: qwen3.5:4b is unloaded before gemma4:e4b's fit, and the refusal is decided from the reading after", async () => {
    let gpu: Gpu | undefined;
    const r = await rig({
      loader: true,
      tags: LAPTOP_TAGS,
      ps: [{ ...QWEN_4B }],
      gpu: { totalMib: 6144, usedMib: 5481, freeMib: 486, memAvailableKb: kbOf(2.66), apps: WHISPER_ROW },
      // His GPU reading after the unload: 1,297 MiB used, 4,670 MiB free. A send judges system memory by
      // what the computer has, and his 16 GB laptop would spill and run; under 2 GB free the rig is a
      // 3 GB computer, so the decision here is a refusal and it carries the reading it was made from.
      onUnload: () => { if (gpu) Object.assign(gpu, { usedMib: 1297, freeMib: 4670, memAvailableKb: kbOf(1.8) }); },
    });
    gpu = r.gpu;
    const t = await r.client.call("threads.create", {});
    const { turnId } = await r.client.call("chat.send", { threadId: t.id, content: "hello", model: "gemma4:e4b", numCtx: 16384 });
    const { event } = await r.waitFor("chat.event", (p) => p.turnId === turnId && p.event.type === "error", 10_000);
    if (event.type !== "error") throw new Error("unreachable");
    expect(event.code).toBe("wont-fit");
    // The one unload, then the decision: from 4,670 MiB free, not from 486 MiB plus a guess.
    expect(r.ollama.requests.filter((q) => q.path === "/api/generate").map((q) => q.body)).toEqual([{ model: "qwen3.5:4b", keep_alive: 0 }]);
    expect(r.ps).toEqual([]);
    expect(event.fit).toMatchObject({ verdict: "refuse", needVramBytes: 8_200_560_697, freeVramBytes: 4670 * MIB });
    expect(event.message).not.toMatch(/qwen3\.5:4b/);
    expect(r.ollama.requests.filter((q) => q.path === "/api/chat")).toEqual([]);
    expect(r.store.getThread(t.id).messages).toEqual([]);
  });

  it("a reply running on qwen3.5:4b in one thread keeps its model while gemma4:e4b is sent in another", async () => {
    const r = await rig({ loader: true, tags: LAPTOP_TAGS, ps: [{ ...QWEN_4B, context_length: 16384 }] });
    const held = gate();
    cleanups.push(held.open);
    r.setChat(async (res, body) => {
      if ((body as { model: string }).model !== "qwen3.5:4b") return quickReply(res, body);
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(piece("one "));
      await held.shut;
      res.end(doneLine);
    });
    const a = await r.client.call("threads.create", {});
    const b = await r.client.call("threads.create", {});
    const first = await sendStarted(r, { threadId: a.id, content: "long", model: "qwen3.5:4b", numCtx: 16384 });
    await r.waitFor("chat.event", (p) => p.turnId === first.turnId && p.event.type === "delta");
    const second = await sendStarted(r, { threadId: b.id, content: "short", model: "gemma4:e4b", numCtx: 16384 });
    await r.waitFor("chat.event", (p) => p.turnId === second.turnId && p.event.type === "done", 10_000);
    expect(r.ollama.requests.filter((q) => q.path === "/api/generate" && (q.body as { keep_alive?: unknown }).keep_alive === 0)).toEqual([]);
    expect(r.ps.map((m) => m.name)).toContain("qwen3.5:4b");
    held.open();
    await r.waitFor("chat.event", (p) => p.turnId === first.turnId && p.event.type === "done");
  });

  it("chat, then an image, then chat with both runtimes external: unload chat, free the engine, load chat, each after the last answered", async () => {
    const order: string[] = [];
    const comfy = externalComfy(order);
    const r = await rig({ loader: true, image: comfy.build, onUnload: (model) => order.push(`unload ${model}`) });
    cleanups.push(() => comfy.module().close());
    r.setChat((res, body) => {
      order.push(`chat ${(body as { model: string }).model}`);
      return quickReply(res, body);
    });
    const t = await r.client.call("threads.create", {});
    const one = await sendStarted(r, { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 });
    await r.waitFor("chat.event", (p) => p.turnId === one.turnId && p.event.type === "done");
    const image = comfy.module();
    const job = await image.generate({ prompt: "a tree" });
    await image.wait(job.jobId);
    expect(comfy.states(job.jobId).at(-1)).toBe("done");
    const two = await sendStarted(r, { threadId: t.id, content: "y", model: MODEL, numCtx: 16384 });
    await r.waitFor("chat.event", (p) => p.turnId === two.turnId && p.event.type === "done");
    // The first free: what the engine holds is unknown when the app starts, so the first handoff asks
    // it once; the image after it finds it empty, and the chat after the image frees what it loaded.
    expect(order).toEqual(["free", `chat ${MODEL}`, `unload ${MODEL}`, "prompt", "free", `chat ${MODEL}`]);
    // Neither runtime was stopped, restarted or reconfigured: the only requests were these.
    expect(comfy.calls.filter((c) => !["/system_stats", "/queue", "/object_info", "/free", "/prompt", "/view"].includes(c) && !c.startsWith("/history/"))).toEqual([]);
  });

  it("an external ComfyUI with a job of its own queued is not asked to free; the send measures and decides", async () => {
    const order: string[] = [];
    const comfy = externalComfy(order);
    const r = await rig({ loader: true, image: comfy.build, onUnload: (model) => order.push(`unload ${model}`) });
    cleanups.push(() => comfy.module().close());
    const image = comfy.module();
    await image.wait((await image.generate({ prompt: "warm" })).jobId);
    comfy.ctl.pending = [[0, "someone-else"]];
    const mark = order.length;
    const t = await r.client.call("threads.create", {});
    const sent = await sendStarted(r, { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 });
    await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "done");
    expect(order.slice(mark)).not.toContain("free");
  });
});

/**
 * The real image module over an external ComfyUI on this computer (a Settings address): the app
 * never starts, stops or reconfigures it. `order` hears its /free and /prompt; `ctl.pending` is
 * another client's queue. Fetch and socket are injected: no request leaves the process.
 */
function externalComfy(order: string[]) {
  const imageEvents: ImageEvent[] = [];
  const calls: string[] = [];
  const ctl = { pending: [] as unknown[] };
  let module: ImageModule | undefined;
  let prompts = 0;
  const build = (lease: GpuLease, store: ThreadStore, dir: string, memory?: MemoryOwner) => {
    let socket: EventTarget | undefined;
    module = createImageModule({
      dataDir: path.join(dir, "image-data"), lease, store, requiredBytes: 1,
      settings: () => ({ imageGen: true, comfyUrl: "http://127.0.0.1:18188" }),
      localAddresses: () => ["127.0.0.1"], lookupHost: async () => ["127.0.0.1"],
      ...(memory ? { memory } : {}),
      readGpu: async () => ({ freeBytes: 2 ** 40, holders: "none", tenants: [] }),
      service: { inspect: refuseUnit, start: refuseUnit, stop: refuseUnit },
      socket: () => {
        socket = Object.assign(new EventTarget(), { close() {} });
        Object.defineProperty(socket, "readyState", { value: 1 });
        return socket as unknown as globalThis.WebSocket;
      },
      fetch: async (input) => {
        const { pathname } = new URL(String(input));
        calls.push(pathname);
        // DynamicVRAM: torch reserves 32 MiB while the weights sit elsewhere (WIN-MEM-03).
        if (pathname === "/system_stats") return Response.json({ system: {}, devices: [{ name: "cuda:0", type: "cuda", vram_total: 6_442_123_264, vram_free: 3_757_325_224, torch_vram_total: 33_554_432, torch_vram_free: 0 }] });
        if (pathname === "/object_info") return Response.json(comfyInfo(ZIMAGE_FILES));
        if (pathname === "/queue") return Response.json({ queue_running: [], queue_pending: ctl.pending });
        if (pathname === "/free") { order.push("free"); return new Response(null, { status: 200 }); }
        if (pathname === "/prompt") {
          order.push("prompt");
          prompts += 1;
          const id = `p${prompts}`;
          queueMicrotask(() => socket?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "executing", data: { prompt_id: id, node: null } }) })));
          return Response.json({ prompt_id: id });
        }
        if (pathname.startsWith("/history/")) {
          const id = decodeURIComponent(pathname.slice("/history/".length));
          return Response.json({ [id]: { outputs: { "8": { images: [{ filename: "out.png" }] } } } });
        }
        if (pathname === "/view") return new Response(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        throw new Error(`unexpected ComfyUI request ${pathname}`);
      },
      push: (channel, payload) => { if (channel === "image.event") imageEvents.push(payload as ImageEvent); },
    } as Parameters<typeof createImageModule>[0]);
    return module;
  };
  const states = (jobId: string) => imageEvents.filter((e) => e.jobId === jobId).map((e) => e.state);
  return { build, ctl, calls, states, module: () => module! };
}

describe("threads.delete marks the thread before it waits", () => {
  it("a send and an image.generate for the thread while an earlier image's cancel is pending are refused; nothing outlives the delete", async () => {
    const comfy = managedComfy();
    const r = await rig({ image: comfy.build, show: caps(["completion", "tools"]) });
    cleanups.push(() => comfy.module().close());
    r.setChat(async (res, body) => {
      const last = (body as { messages: Array<{ role: string; content: string }> }).messages.at(-1)!;
      if (last.role === "tool") return stream(res, [piece("Queued it."), doneLine]);
      return stream(res, [line({ model: MODEL, message: { role: "assistant", content: "", tool_calls: [{ function: { name: "image", arguments: { prompt: "a tree" } } }] }, done: true, done_reason: "stop" })]);
    });
    const t = await r.client.call("threads.create", {});
    // The first turn's image runs and stays running until cancelled.
    comfy.ctl.holdNext = gate().shut;
    const first = await sendStarted(r, { threadId: t.id, content: "draw", model: MODEL, numCtx: 16384, tools: true });
    await r.waitFor("chat.event", (p) => p.turnId === first.turnId && p.event.type === "done");
    const jobId = comfy.events.find((e) => e.threadId === t.id && e.state === "queued")?.jobId;
    if (jobId === undefined) throw new Error(`the turn queued no image; saw ${JSON.stringify(comfy.events)}`);
    await until(() => comfy.states(jobId).includes("running"));

    // The job's cancel ends in a health check that stalls: the delete waits on it with the GPU already free.
    const health = gate();
    comfy.ctl.health = health.shut;
    cleanups.push(health.open);
    const deleting = r.client.call("threads.delete", { threadId: t.id });
    await until(() => comfy.states(jobId).includes("cancelled"));
    expect(r.lease!.status().holders).toBe(0);

    const send = await rejection(within(3000, sendStarted(r, { threadId: t.id, content: "draw", model: MODEL, numCtx: 16384, tools: true }), "chat.send"));
    expect(send.code).toBe("thread-not-found");
    const generate = await rejection(within(3000, r.client.call("image.generate", { prompt: "another", threadId: t.id }), "image.generate"));
    expect(generate.code).toBe("thread-not-found");
    expect(r.app.activeTurns()).toBe(0);

    health.open();
    expect(await within(3000, deleting, "threads.delete")).toEqual({ threadId: t.id });
    await sleep(300); // room for anything that slipped past the delete to run
    expect(new Set(comfy.events.map((e) => e.jobId))).toEqual(new Set([jobId]));
    // running twice: started, then ComfyUI took the prompt into its queue (the card's live line)
    expect(comfy.states(jobId)).toEqual(["queued", "running", "running", "cancelled"]);
    expect(comfy.events.filter((e) => e.jobId === jobId).map((e) => e.stage)).toEqual([undefined, undefined, "queued", undefined]);
    expect(comfy.calls.filter((c) => c === "/prompt")).toHaveLength(1);
    expect(comfy.pngs()).toEqual([]);
    expect((await rejection(r.client.call("threads.get", { threadId: t.id }))).code).toBe("thread-not-found");
    expect(r.lease!.status()).toEqual({ holder: null, holders: 0, waiting: [] });
  });

  it("an image.generate with a threadId, not from a turn, is taken back by threads.delete", async () => {
    const comfy = managedComfy();
    const r = await rig({ image: comfy.build });
    cleanups.push(() => comfy.module().close());
    let releaseTalk!: () => void;
    const talkGate = new Promise<void>((resolve) => (releaseTalk = resolve));
    r.setChat(async (res) => {
      await talkGate;
      return stream(res, [piece("still here"), doneLine]);
    });
    const drawing = await r.client.call("threads.create", {});
    const talking = await r.client.call("threads.create", {});
    // Another thread's turn holds its shared chat claim, so the image waits in the queue.
    const talk = await sendStarted(r, { threadId: talking.id, content: "talk", model: MODEL, numCtx: 16384 });
    const { jobId } = await r.client.call("image.generate", { prompt: "a tree", threadId: drawing.id });
    await until(() => r.lease!.status().waiting.includes("image"));

    expect(await within(3000, r.client.call("threads.delete", { threadId: drawing.id }), "threads.delete")).toEqual({ threadId: drawing.id });
    releaseTalk();
    await r.waitFor("chat.event", (p) => p.turnId === talk.turnId && p.event.type === "done");
    await comfy.module().wait(jobId);
    expect(comfy.states(jobId)).toEqual(["queued", "cancelled"]);
    expect(comfy.calls).not.toContain("/prompt");
    expect(comfy.pngs()).toEqual([]);
  });
});

describe("threads.delete and the image jobs its turns queued", () => {
  it("cancels a queued tool image whose turn already ended, before the thread goes", async () => {
    const comfy = fakeComfyImage();
    const r = await rig({ image: comfy.build, show: caps(["completion", "tools"]) });
    cleanups.push(() => comfy.module().close());
    let releaseTalk!: () => void;
    const talkGate = new Promise<void>((resolve) => (releaseTalk = resolve));
    r.setChat(async (res, body) => {
      const last = (body as { messages: Array<{ role: string; content: string }> }).messages.at(-1)!;
      if (last.role === "tool") return stream(res, [piece("Queued it."), doneLine]);
      if (last.content === "draw") {
        return stream(res, [line({ model: MODEL, message: { role: "assistant", content: "", tool_calls: [{ function: { name: "image", arguments: { prompt: "a tree" } } }] }, done: true, done_reason: "stop" })]);
      }
      await talkGate;
      return stream(res, [piece("still here"), doneLine]);
    });
    const drawing = await r.client.call("threads.create", {});
    const talking = await r.client.call("threads.create", {});
    // Another thread's turn streams the whole time and holds its shared chat claim.
    const talk = await sendStarted(r, { threadId: talking.id, content: "talk", model: MODEL, numCtx: 16384 });
    const draw = await sendStarted(r, { threadId: drawing.id, content: "draw", model: MODEL, numCtx: 16384, tools: true });
    await r.waitFor("chat.event", (p) => p.turnId === draw.turnId && p.event.type === "done");
    const jobId = comfy.events.find((e) => e.threadId === drawing.id && e.state === "queued")?.jobId;
    if (jobId === undefined) throw new Error(`the drawing turn queued no image; saw ${JSON.stringify(comfy.events)}`);
    expect(r.lease?.status().waiting).toEqual(["image"]);

    // The drawing turn is over; deleting its thread still takes its image back.
    expect(await r.client.call("threads.delete", { threadId: drawing.id })).toEqual({ threadId: drawing.id });
    releaseTalk();
    await r.waitFor("chat.event", (p) => p.turnId === talk.turnId && p.event.type === "done");
    await comfy.module().wait(jobId);
    expect(comfy.events.filter((e) => e.jobId === jobId).map((e) => e.state)).toEqual(["queued", "cancelled"]);
    expect(comfy.comfyCalls).not.toContain("/prompt");
    expect(existsSync(comfy.png(jobId))).toBe(false);
    expect((await rejection(r.client.call("threads.get", { threadId: drawing.id }))).code).toBe("thread-not-found");
  });
});

const untilWords = async (r: Rig, turnId: string, count = 1) => r.waitFor("chat.event", (p) => p.turnId === turnId && p.event.type === "delta" && r.pushes.filter((q) => q.channel === "chat.event" && (q.payload as Payload<"chat.event">).turnId === turnId && (q.payload as Payload<"chat.event">).event.type === "delta").length >= count);
/**
 * slowReply's words, held after the first `shown` until `go()`: a test acts mid-reply without racing
 * slowReply's 150 ms timer, which a loaded machine loses (chat row 25: "one two " where "one " was due).
 */
function heldReply(shown = 1): { route: ChatRoute; go: () => void } {
  const hold: { open?: () => void } = {};
  const held = new Promise<void>((resolve) => { hold.open = resolve; });
  const go = () => hold.open?.();
  cleanups.push(go);
  const words = ["one ", "two ", "three ", "four "].map(piece);
  const route: ChatRoute = async (res) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    for (const word of words.slice(0, shown)) { res.write(word); await sleep(5); }
    await held;
    if (!res.destroyed) res.end([...words.slice(shown), doneLine].join(""));
  };
  return { route, go };
}
const onDisk = (r: Rig, threadId: string) => r.store.getThread(threadId).messages.filter((m) => m.role === "assistant");
const startReply = async (r: Rig, route: ChatRoute = slowReply) => {
  r.setChat(route);
  const t = await r.client.call("threads.create", {});
  const sent = await sendStarted(r, { threadId: t.id, content: "count", model: MODEL, numCtx: 16384 });
  return { threadId: t.id, sent };
};
const stoppedReply = async (r: Rig) => {
  r.setChat(slowReply);
  const t = await r.client.call("threads.create", {});
  const sent = await sendStarted(r, { threadId: t.id, content: "the question", model: MODEL, numCtx: 16384 });
  await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "delta");
  await r.client.call("chat.cancel", { turnId: sent.turnId });
  await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "error");
  r.setChat(quickReply);
  return { threadId: t.id, sent };
};

describe("chat.cancel and threads.delete during a turn", () => {
  it("AU-01 every client's chat.send passes the server admission boundary", async () => {
    const r = await rig({ admit: () => { throw Object.assign(new Error("Gates Local is closing to update. Try again after it reopens."), { code: "update-installing" }); } });
    const thread = await r.client.call("threads.create", {});
    const error = await rejection(sendStarted(r, { threadId: thread.id, content: "Do not start", model: MODEL, numCtx: 16384 }));
    expect(error).toMatchObject({ code: "update-installing", message: expect.stringContaining("closing to update") });
    expect(r.app.activeTurns()).toBe(0);
    expect(r.store.getThread(thread.id).messages).toHaveLength(0);
  });
  it("Stop mid-reply ends the turn once and keeps the words sent so far, marked interrupted", async () => {
    const r = await rig();
    r.setChat(slowReply);
    const t = await r.client.call("threads.create", {});
    const sent = await sendStarted(r, { threadId: t.id, content: "count", model: MODEL, numCtx: 16384 });
    await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "delta");
    expect(await r.client.call("chat.cancel", { turnId: sent.turnId })).toEqual({ cancelled: true });
    const end = await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "error");
    expect(end.event).toMatchObject({ type: "error", code: "cancelled", partial: { role: "assistant", interrupted: true } });
    await sleep(800); // past where the fake would have sent done
    expect(events(r, sent.turnId).some((e) => e.type === "done")).toBe(false);
    expect(events(r, sent.turnId).filter((e) => e.type === "error")).toHaveLength(1);
    const shown = events(r, sent.turnId).filter((e) => e.type === "delta").map((e) => e.text).join("");
    const { messages } = await r.client.call("threads.get", { threadId: t.id });
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[1]).toMatchObject({ content: shown, interrupted: true });
    expect(r.app.activeTurns()).toBe(0);
    // A finished or unknown turn is not cancellable; the thread takes a new turn.
    expect(await r.client.call("chat.cancel", { turnId: sent.turnId })).toEqual({ cancelled: false });
    expect(await r.client.call("chat.cancel", { turnId: "no-such-turn" })).toEqual({ cancelled: false });
    r.setChat((res) => stream(res, [piece("fine"), doneLine]));
    const again = await sendStarted(r, { threadId: t.id, content: "again", model: MODEL, numCtx: 16384 });
    await r.waitFor("chat.event", (p) => p.turnId === again.turnId && p.event.type === "done");
  });

  it("a start sent again to a client that joins mid-reply says it is a replay; the first one does not", async () => {
    const r = await rig();
    const held = heldReply();
    const { sent } = await startReply(r, held.route);
    await untilWords(r, sent.turnId);
    const replayed: Payload<"chat.event">[] = [];
    r.app.replayTurns((channel, payload) => { if (channel === "chat.event") replayed.push(payload as Payload<"chat.event">); });
    expect(replayed.find((p) => p.turnId === sent.turnId)?.event).toMatchObject({ type: "start", replayed: true });
    expect(events(r, sent.turnId).find((e) => e.type === "start")).not.toHaveProperty("replayed");
    held.go();
    await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "done");
  });

  describe("a reply on its way to disk", () => {
    it("is written marked interrupted from its first words, and threads.get does not show it while it runs", async () => {
      const r = await rig();
      const held = heldReply();
      const { threadId, sent } = await startReply(r, held.route);
      await untilWords(r, sent.turnId);
      expect(onDisk(r, threadId)).toMatchObject([{ content: "one ", interrupted: true }]);
      expect((await r.client.call("threads.get", { threadId })).messages.map((m) => m.role)).toEqual(["user"]);
      held.go();
      await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "done");
      const finished = onDisk(r, threadId);
      expect(finished).toHaveLength(1);
      expect(finished[0]).toMatchObject({ content: "one two three four " });
      expect(finished[0]?.interrupted).toBeUndefined();
    });

    it("is updated in place while it streams", async () => {
      const r = await rig({ draftEveryMs: 20 });
      const { threadId, sent } = await startReply(r, heldReply(3).route);
      await untilWords(r, sent.turnId, 3);
      await vi.waitFor(() => expect(onDisk(r, threadId)[0]?.content.startsWith("one two")).toBe(true), { interval: 5 });
      const rows = onDisk(r, threadId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.content.startsWith("one two")).toBe(true);
      expect(rows[0]?.interrupted).toBe(true);
    });

    it("waits between writes rather than writing every word", async () => {
      const r = await rig({ draftEveryMs: 60_000 });
      const { threadId, sent } = await startReply(r, heldReply(3).route);
      await untilWords(r, sent.turnId, 3);
      expect(onDisk(r, threadId)).toMatchObject([{ content: "one ", interrupted: true }]);
    });

    it("a Stop or a failure leaves one row, not the in-progress one beside it", async () => {
      const r = await rig();
      const { threadId, sent } = await startReply(r, heldReply().route);
      await untilWords(r, sent.turnId);
      await r.client.call("chat.cancel", { turnId: sent.turnId });
      const end = await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "error");
      expect(onDisk(r, threadId).map((m) => m.id)).toEqual([end.event.type === "error" ? end.event.partial?.id : undefined]);
    });

    it("deleting a message mid-reply leaves no in-progress row behind", async () => {
      const r = await rig();
      const { threadId, sent } = await startReply(r, heldReply().route);
      await untilWords(r, sent.turnId);
      await r.client.call("messages.delete", { threadId, messageId: sent.userMessage.id });
      expect(r.store.getThread(threadId).messages).toEqual([]);
    });

    it("deleting an older message stops the reply but keeps what it wrote", async () => {
      const r = await rig();
      r.setChat(quickReply);
      const t = await r.client.call("threads.create", {});
      const older = await sendStarted(r, { threadId: t.id, content: "earlier", model: MODEL, numCtx: 16384 });
      await r.waitFor("chat.event", (p) => p.turnId === older.turnId && p.event.type === "done");
      await vi.waitFor(() => expect(r.app.activeTurns()).toBe(0));
      r.setChat(heldReply().route);
      const sent = await sendStarted(r, { threadId: t.id, content: "count", model: MODEL, numCtx: 16384 });
      await untilWords(r, sent.turnId);
      await r.client.call("messages.delete", { threadId: t.id, messageId: older.userMessage.id });
      const rows = r.store.getThread(t.id).messages;
      expect(rows.map((m) => m.id)).not.toContain(older.userMessage.id);
      expect(rows.at(-1)).toMatchObject({ role: "assistant", content: "one ", interrupted: true });
      expect(events(r, sent.turnId).at(-1)).toMatchObject({ type: "error", partial: { content: "one ", interrupted: true } });
    });

    it("deleting the whole thread mid-reply saves nothing", async () => {
      const r = await rig();
      const { threadId, sent } = await startReply(r, heldReply().route);
      await untilWords(r, sent.turnId);
      await r.client.call("threads.delete", { threadId });
      expect(r.store.listThreads().map((t) => t.id)).not.toContain(threadId);
      expect(events(r, sent.turnId).at(-1)).not.toHaveProperty("partial");
    });

    it("a finished reply the store refuses still saves every word, marked unfinished", async () => {
      const r = await rig({ draftEveryMs: 60_000 });
      const refused = line({ model: MODEL, message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: -1, eval_count: 3 });
      const { threadId, sent } = await startReply(r, (res) => stream(res, [piece("one "), piece("two "), piece("three "), refused]));
      const terminal = await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "error");
      expect(terminal.event).toMatchObject({ type: "error", partial: { content: "one two three ", interrupted: true } });
      expect(onDisk(r, threadId)).toMatchObject([{ content: "one two three ", interrupted: true }]);
    });

    it("a second send while it runs is refused and the model never reads the in-progress row", async () => {
      const r = await rig();
      const { threadId, sent } = await startReply(r, heldReply().route);
      await untilWords(r, sent.turnId);
      expect(onDisk(r, threadId)).toHaveLength(1);
      const asked = r.ollama.requests.filter((q) => q.path === "/api/chat").length;
      expect((await rejection(sendStarted(r, { threadId, content: "and?", model: MODEL, numCtx: 16384 }))).code).toBe("turn-active");
      expect(r.ollama.requests.filter((q) => q.path === "/api/chat")).toHaveLength(asked);
    });
  });

  describe("Retry of a reply that never finished", () => {
    it("replaces the question and the unfinished words instead of asking twice", async () => {
      const r = await rig();
      const { threadId, sent } = await stoppedReply(r);
      const again = await sendStarted(r, { threadId, content: "the question", model: MODEL, numCtx: 16384, retryOf: sent.userMessage.id });
      await r.waitFor("chat.event", (p) => p.turnId === again.turnId && p.event.type === "done");
      const { messages } = await r.client.call("threads.get", { threadId });
      expect(messages.map((m) => [m.role, m.content])).toEqual([["user", "the question"], ["assistant", "hi"]]);
      expect(messages[1]?.interrupted).toBeUndefined();
      expect(r.ollama.requests.filter((q) => q.path === "/api/chat").at(-1)?.body).toMatchObject({ messages: [{ role: "user", content: "the question" }] });
      const body = r.ollama.requests.filter((q) => q.path === "/api/chat").at(-1)?.body as { messages: unknown[] };
      expect(body.messages).toHaveLength(1);
    });

    it("keeps both copies when a finished reply followed the question", async () => {
      const r = await rig();
      r.setChat(quickReply);
      const t = await r.client.call("threads.create", {});
      const first = await sendStarted(r, { threadId: t.id, content: "the question", model: MODEL, numCtx: 16384 });
      await r.waitFor("chat.event", (p) => p.turnId === first.turnId && p.event.type === "done");
      const again = await sendStarted(r, { threadId: t.id, content: "the question", model: MODEL, numCtx: 16384, retryOf: first.userMessage.id });
      await r.waitFor("chat.event", (p) => p.turnId === again.turnId && p.event.type === "done");
      expect((await r.client.call("threads.get", { threadId: t.id })).messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    });

    it("a send that is not a Retry keeps the unfinished words and leaves them out of the prompt", async () => {
      const r = await rig();
      const { threadId } = await stoppedReply(r);
      const next = await sendStarted(r, { threadId, content: "something else", model: MODEL, numCtx: 16384 });
      await r.waitFor("chat.event", (p) => p.turnId === next.turnId && p.event.type === "done");
      expect((await r.client.call("threads.get", { threadId })).messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
      const body = r.ollama.requests.filter((q) => q.path === "/api/chat").at(-1)?.body as { messages: Array<{ role: string }> };
      expect(body.messages.map((m) => m.role)).toEqual(["user", "user"]);
    });
  });

  it("a server killed mid-reply keeps the streamed words, marked interrupted, and Retry does not ask twice", async () => {
    const dir = cacheTmp();
    const marker = `WORD${randomUUID().replaceAll("-", "")}`;
    const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("./crash-server.ts", import.meta.url)), dir, marker], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    });
    const ready = await new Promise<{ threadId: string; questionId: string; written: string }>((resolve, reject) => {
      let stderr = "";
      child.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
      createInterface({ input: child.stdout }).once("line", (l) => resolve(JSON.parse(l) as { threadId: string; questionId: string; written: string }));
      child.once("exit", (code, signal) => reject(new Error(`child exited early (${code ?? signal}): ${stderr}`)));
    });
    expect(child.exitCode).toBeNull();
    child.kill("SIGKILL");
    await exited;
    expect(child.signalCode).toBe("SIGKILL");

    // The killed writer never checkpointed: reopening below is WAL recovery.
    const dbPath = path.join(dir, "threads.sqlite");
    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);

    const r = await rig({ dbPath });
    r.setChat(quickReply);
    const { threadId, questionId, written } = ready;
    const after = await r.client.call("threads.get", { threadId });
    expect(after.messages.map((m) => [m.role, m.interrupted])).toEqual([["user", undefined], ["assistant", undefined], ["user", undefined], ["assistant", true]]);
    expect(after.messages[1]?.content).toBe("first answer");
    expect(after.messages[3]?.content.startsWith(written)).toBe(true);

    const raw = new DatabaseSync(dbPath, { readOnly: true });
    expect(raw.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    raw.close();

    const again = await sendStarted(r, { threadId, content: "second question", model: MODEL, numCtx: 16384, retryOf: questionId });
    await r.waitFor("chat.event", (p) => p.turnId === again.turnId && p.event.type === "done");
    const retried = await r.client.call("threads.get", { threadId });
    expect(retried.messages.map((m) => [m.role, m.content])).toEqual([["user", "first question"], ["assistant", "first answer"], ["user", "second question"], ["assistant", "hi"]]);
    const prompt = JSON.stringify(r.ollama.requests.filter((q) => q.path === "/api/chat").at(-1)?.body);
    expect(prompt).not.toContain(marker);
    expect(prompt.split("second question")).toHaveLength(2);
  }, 20_000);

  it("Stop before any words saves nothing", async () => {
    const r = await rig();
    const reached = gate();
    const held = gate();
    cleanups.push(() => held.open());
    r.setChat(async (res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.flushHeaders();
      reached.open();
      await held.shut;
      res.end();
    });
    const t = await r.client.call("threads.create", {});
    const sent = await sendStarted(r, { threadId: t.id, content: "count", model: MODEL, numCtx: 16384 });
    await reached.shut;
    await r.client.call("chat.cancel", { turnId: sent.turnId });
    const end = await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "error");
    expect(end.event).toMatchObject({ type: "error", code: "cancelled" });
    expect(end.event).not.toHaveProperty("partial");
    expect(r.store.getThread(t.id).messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("Stop that lands with the last token keeps the finished reply, not marked interrupted", async () => {
    let r: Rig;
    const r2 = await rig({ onDelta: (turnId) => { void r.app.handlers["chat.cancel"]({ turnId }, { clientId: 1 }); } });
    r = r2;
    // One chunk: the last word and the done line are parsed with no await on the socket between them.
    r.setChat((res) => stream(res, [piece("all of it") + doneLine]));
    const t = await r.client.call("threads.create", {});
    const sent = await sendStarted(r, { threadId: t.id, content: "count", model: MODEL, numCtx: 16384 });
    const end = await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && (p.event.type === "done" || p.event.type === "error"));
    expect(end.event).toMatchObject({ type: "done", message: { role: "assistant", content: "all of it" } });
    const saved = r.store.getThread(t.id).messages.at(-1);
    expect(saved).toMatchObject({ role: "assistant", content: "all of it" });
    expect(saved).not.toHaveProperty("interrupted");
  });

  it("deleting the question as its last token lands leaves neither the question nor an answer", async () => {
    let r: Rig;
    let threadId = "";
    const r2 = await rig({ onDelta: () => {
      const question = r.store.getThread(threadId).messages.find((m) => m.role === "user");
      const remove = r.app.handlers["messages.delete"];
      if (question !== undefined && remove !== undefined) void remove({ threadId, messageId: question.id }, { clientId: 1 });
    } });
    r = r2;
    // One chunk: the delete lands with the done line already parsed.
    r.setChat((res) => stream(res, [piece("all of it") + doneLine]));
    threadId = (await r.client.call("threads.create", {})).id;
    const sent = await sendStarted(r, { threadId, content: "count", model: MODEL, numCtx: 16384 });
    const end = await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && (p.event.type === "done" || p.event.type === "error"));
    expect(end.event).toMatchObject({ type: "error", code: "cancelled" });
    expect(end.event).not.toHaveProperty("partial");
    await vi.waitFor(() => expect(r.store.getThread(threadId).messages).toEqual([]));
  });

  it("delete during a turn cancels it first, then deletes the thread", async () => {
    const r = await rig();
    r.setChat(slowReply);
    const t = await r.client.call("threads.create", {});
    const sent = await sendStarted(r, { threadId: t.id, content: "count", model: MODEL, numCtx: 16384 });
    await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "delta");
    expect(await r.client.call("threads.delete", { threadId: t.id })).toEqual({ threadId: t.id });
    // The cancelled event was pushed before delete answered.
    expect(events(r, sent.turnId).at(-1)).toMatchObject({ type: "error", code: "cancelled" });
    expect(r.app.activeTurns()).toBe(0);
    expect((await rejection(r.client.call("threads.get", { threadId: t.id }))).code).toBe("thread-not-found");
    await sleep(800);
    expect(events(r, sent.turnId).some((e) => e.type === "done")).toBe(false);
  });

  it("shutdown cancels every active turn and refuses new ones", async () => {
    const r = await rig();
    r.setChat(slowReply);
    const t = await r.client.call("threads.create", {});
    const sent = await sendStarted(r, { threadId: t.id, content: "count", model: MODEL, numCtx: 16384 });
    await r.app.shutdown();
    expect(r.app.activeTurns()).toBe(0);
    const end = await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "error");
    expect(end.event).toMatchObject({ type: "error", code: "cancelled" });
    const err = await rejection(sendStarted(r, { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 }));
    expect(err.code).toBe("shutting-down");
  });

  it("shutdown for an update saves the reply already shown before reopening", async () => {
    const r = await rig();
    r.setChat(slowReply);
    const t = await r.client.call("threads.create", {});
    const sent = await sendStarted(r, { threadId: t.id, content: "count", model: MODEL, numCtx: 16384 });
    await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "delta");
    await r.app.shutdown();
    const shown = events(r, sent.turnId).filter((e) => e.type === "delta").map((e) => e.text).join("");
    expect(shown.length).toBeGreaterThan(0);
    expect(r.store.getThread(t.id).messages.at(-1)).toMatchObject({ role: "assistant", content: shown });
    expect(r.store.getThread(t.id).messages.at(-1)).toMatchObject({ interrupted: true });
  });

  it("AU-03 excludes durable interrupted assistant text from the next model prompt", async () => {
    const r = await rig();
    const t = r.store.createThread();
    r.store.appendMessage({ threadId: t.id, role: "user", content: "An earlier question" });
    const partial = { threadId: t.id, role: "assistant" as const, content: "UNFINISHED_SENTINEL", interrupted: true as const };
    r.store.appendMessage(partial);
    let requested: unknown;
    r.setChat((res, body) => { requested = body; quickReply(res, body); });
    const sent = await sendStarted(r, { threadId: t.id, content: "Continue with a fresh question", model: MODEL, numCtx: 16384 });
    await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "done");
    expect(JSON.stringify(requested)).toContain("An earlier question");
    expect(JSON.stringify(requested)).not.toContain("UNFINISHED_SENTINEL");
  });
});

describe("runtime.retry (W-06)", () => {
  it("looks for Ollama again instead of answering the cached status", async () => {
    const store = openThreadStore(path.join(cacheTmp(), "threads.sqlite"));
    cleanups.push(() => store.close());
    let ensured = 0;
    const app = createApp({
      store,
      // a stub: the real runtime's ensure() may start Ollama, which these tests never do
      runtime: {
        status: () => ({ state: "wrong-service", owner: "none", baseUrl: "http://127.0.0.1:1", detail: "nginx" }),
        baseUrl: () => undefined,
        onChange: () => () => undefined,
        ensure: async () => (ensured++, { state: "ready", owner: "external", baseUrl: "http://127.0.0.1:1" }),
        lookIfDown: async () => ({ state: "wrong-service", owner: "none", baseUrl: "http://127.0.0.1:1", detail: "nginx" }),
      },
      catalog: { current: () => [], refresh: async () => ({ models: [], changed: false }), onChange: () => () => undefined, stop: () => undefined },
      push: () => undefined,
    });
    cleanups.push(() => app.shutdown());
    expect((await app.handlers["runtime.status"]({}, { clientId: 1 })).state).toBe("wrong-service");
    expect(await app.handlers["runtime.retry"]?.({}, { clientId: 1 })).toMatchObject({ state: "ready" });
    expect(ensured).toBe(1);
  });
});

/** The real runtime and model list, nothing answering yet, with a recording `ollama` on PATH that must never run. */
async function stoppedOllama() {
  const dir = cacheTmp();
  const ran = path.join(dir, "ran");
  writeFakeBinary(path.join(dir, "bin", "ollama"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(ran)}, "ran");\n`);
  const port = await freePort();
  const ollama = createOllamaRuntime({ appDataDir: path.join(dir, "data"), home: path.join(dir, "home"), appPort: await freePort(), externalBaseUrl: `http://127.0.0.1:${port}`, env: { PATH: path.join(dir, "bin"), HOME: path.join(dir, "home") }, systemModelsDirs: [], probeTimeoutMs: 500 });
  cleanups.push(() => ollama.stop());
  const runtime = createRuntimeSwitch({ initialMode: "system", make: () => ollama });
  const store = openThreadStore(path.join(dir, "threads.sqlite"));
  cleanups.push(() => store.close());
  const catalog = createModelCatalog(() => runtime.baseUrl());
  cleanups.push(() => catalog.stop());
  const pushed: unknown[] = [];
  const app = createApp({ store, runtime, catalog, push: (channel, payload) => { if (channel === "runtime.changed") pushed.push(payload); } });
  cleanups.push(() => app.shutdown());
  expect(await runtime.discover()).toMatchObject({ state: "stopped" });
  const answering = async () => {
    const fake = await startFakeOllama({ port, tags: [{ name: MODEL, digest: "q", size: 1, modified_at: "2026-01-01T00:00:00Z" }] });
    cleanups.push(() => fake.close());
    return fake;
  };
  return { app, runtime, ran, pushed, answering };
}
const look = (app: App) => app.handlers["runtime.discover"]?.({}, { clientId: 1 });

describe("runtime.discover, the phone's Retry (BD-02)", () => {
  it("Ollama stopped, then answering: Retry shows it running, the list loads, and nothing is started", async () => {
    const { app, runtime, ran, pushed, answering } = await stoppedOllama();
    const fake = await answering();
    const seen = await look(app);
    expect(seen).toMatchObject({ state: "ready", owner: "external" });
    expect(runtime.status()).toEqual(seen);
    expect(pushed.at(-1), "the computer's window hears the same status").toEqual(seen);
    expect((await app.handlers["models.refresh"]({}, { clientId: 1 })).map((m) => m.name)).toEqual([MODEL]);
    expect(existsSync(ran)).toBe(false);
    expect(fake.requests.filter((r) => !r.startsWith("GET ") && !r.startsWith("POST /api/show"))).toEqual([]);
  });

  it("a ready status is left alone, so a busy Ollama that misses a probe cannot look stopped", async () => {
    const { app, runtime, answering } = await stoppedOllama();
    const fake = await answering();
    await look(app);
    await fake.close();
    expect(await look(app)).toMatchObject({ state: "ready" });
    expect(runtime.status().state).toBe("ready");
  });

  it("no Ollama and a pinned release: Retry reports it missing and downloads nothing", async () => {
    const dir = cacheTmp();
    const release = await startReleaseServer(Buffer.from("never fetched"));
    cleanups.push(() => release.close());
    const ollama = createOllamaRuntime({ appDataDir: path.join(dir, "data"), home: path.join(dir, "home"), appPort: await freePort(), externalBaseUrl: `http://127.0.0.1:${await freePort()}`, env: { PATH: path.join(dir, "empty"), HOME: path.join(dir, "home") }, systemModelsDirs: [], probeTimeoutMs: 500, allowInstall: true, manifest: { version: "9.9.9", url: release.url, sha256: "0".repeat(64), sizeBytes: 13, format: FAKE_RELEASE_FORMAT, verified: true, source: "test" } });
    cleanups.push(() => ollama.stop());
    const runtime = createRuntimeSwitch({ initialMode: "system", make: () => ollama });
    const store = openThreadStore(path.join(dir, "threads.sqlite"));
    cleanups.push(() => store.close());
    const catalog = createModelCatalog(() => runtime.baseUrl());
    cleanups.push(() => catalog.stop());
    const app = createApp({ store, runtime, catalog, push: () => undefined });
    cleanups.push(() => app.shutdown());
    expect(await look(app)).toMatchObject({ state: "missing" });
    expect(release.hits).toBe(0);
    expect(existsSync(installedBinary(path.join(dir, "data"), "9.9.9"))).toBe(false);
  });
});

describe("turn failures", () => {
  it("an Ollama error mid-stream reaches the person once and keeps the words shown so far", async () => {
    const r = await rig();
    r.setChat((res) => stream(res, [piece("half "), line({ error: "model runner crashed" })]));
    const t = await r.client.call("threads.create", {});
    const sent = await sendStarted(r, { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 });
    const end = await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "error");
    expect(end.event).toMatchObject({ type: "error", code: "stream-error", message: "model runner crashed", partial: { content: "half ", interrupted: true } });
    expect(events(r, sent.turnId).filter((e) => e.type === "error")).toHaveLength(1);
    expect(r.store.getThread(t.id).messages.at(-1)).toMatchObject({ role: "assistant", content: "half ", interrupted: true });
    expect(r.app.activeTurns()).toBe(0);
  });

  it("an error before any words saves no reply", async () => {
    const r = await rig();
    r.setChat((res) => stream(res, [line({ error: "model runner crashed" })]));
    const t = await r.client.call("threads.create", {});
    const sent = await sendStarted(r, { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 });
    const end = await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "error");
    expect(end.event).toEqual({ type: "error", code: "stream-error", message: "model runner crashed", ended: { reason: "failed", at: expect.any(Number) }, question: expect.objectContaining({ role: "user" }) });
    expect(r.store.getThread(t.id).messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("chat row 32: the saved reply keeps its times, and a question whose turn saved nothing keeps how it ended", async () => {
    const r = await rig();
    const think = (text: string) => line({ model: MODEL, message: { role: "assistant", content: "", thinking: text }, done: false });
    r.setChat((res) => stream(res, [think("let me see"), piece("hi"), doneLine], 150));
    const t = await r.client.call("threads.create", {});
    const before = Date.now();
    const sent = await sendStarted(r, { threadId: t.id, content: "q", model: MODEL, numCtx: 16384 });
    const fin = await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "done");
    const times = fin.event.type === "done" ? fin.event.message.times : undefined;
    expect(times).toMatchObject({ ended: { reason: "done" }, spans: [{ from: 0 }], callsAt: {} });
    expect(times!.startedAt).toBeGreaterThanOrEqual(before);
    expect(times!.firstTokenAt! - times!.startedAt).toBeGreaterThanOrEqual(140);
    expect(times!.thoughtMs).toBeGreaterThanOrEqual(140);
    expect(times!.spans[0]!.ms).toBeGreaterThanOrEqual(140);
    // what every window reads after a reload
    expect(r.store.getThread(t.id).messages.at(-1)?.times).toEqual(times);
    r.setChat((res) => stream(res, [line({ error: "model runner crashed" })]));
    const failed = await sendStarted(r, { threadId: t.id, content: "again", model: MODEL, numCtx: 16384 });
    const end = await r.waitFor("chat.event", (p) => p.turnId === failed.turnId && p.event.type === "error");
    const stamped = { role: "user", content: "again", times: { ended: { reason: "failed" }, spans: [], why: { code: "stream-error", message: "model runner crashed" } } };
    expect(r.store.getThread(t.id).messages.at(-1)).toMatchObject(stamped);
    // the open windows get the stamped question with the end, so none reloads the chat to say why
    expect(end.event).toMatchObject({ question: stamped });
  });

  it("chat row 32: the terminal event says how the turn ended, and a Stop's time is when the cancel came", async () => {
    const r = await rig();
    const t = await r.client.call("threads.create", {});
    const done = await sendStarted(r, { threadId: t.id, content: "hi", model: MODEL, numCtx: 16384 });
    const fin = await r.waitFor("chat.event", (p) => p.turnId === done.turnId && p.event.type === "done");
    expect(fin.event).toMatchObject({ type: "done", ended: { reason: "done", at: expect.any(Number) } });
    r.setChat(slowReply);
    const sent = await sendStarted(r, { threadId: t.id, content: "count", model: MODEL, numCtx: 16384 });
    await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "delta");
    const before = Date.now();
    await r.client.call("chat.cancel", { turnId: sent.turnId });
    const after = Date.now();
    const end = await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "error");
    expect(end.event).toMatchObject({ type: "error", code: "cancelled", ended: { reason: "stopped" } });
    const at = end.event.type === "error" ? end.event.ended?.at ?? 0 : 0;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
  });

  it("an unknown thread is thread-not-found and reserves nothing", async () => {
    const r = await rig();
    const err = await rejection(sendStarted(r, { threadId: "nope", content: "x", model: MODEL, numCtx: 16384 }));
    expect(err.code).toBe("thread-not-found");
    expect(r.app.activeTurns()).toBe(0);
  });
});

describe("models.speed", () => {
  // 60 tokens decoded in 0.5 s of a 4 s call: 120 tokens per second, never 15.
  const measured = line({ model: MODEL, message: { role: "assistant", content: "" }, done: true, done_reason: "stop", total_duration: 4e9, eval_duration: 5e8, eval_count: 60, prompt_eval_count: 11 });

  it("reads once per finished reply, pushes the new list to every client, and never reads on a word", async () => {
    const r = await rig();
    expect(await r.client.call("models.speed", {})).toEqual([]);
    const reads = vi.spyOn(r.store, "modelSpeeds");
    r.setChat((res) => stream(res, [piece("one "), piece("two "), piece("three "), measured], 20));
    const t = await r.client.call("threads.create", {});
    const sent = await sendStarted(r, { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 });
    const pushed = await r.waitFor("models.speed", (p) => p.length > 0);
    expect(pushed).toEqual([{ model: MODEL, tokensPerSecond: 120, replies: 1 }]);
    expect(events(r, sent.turnId).filter((e) => e.type === "delta")).toHaveLength(3);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(await r.client.call("models.speed", {})).toEqual(pushed);
  });

  it("a reply that stops before its decode time pushes no new list", async () => {
    const r = await rig();
    r.setChat((res) => stream(res, [piece("half "), line({ error: "model runner crashed" })]));
    const reads = vi.spyOn(r.store, "modelSpeeds");
    const t = await r.client.call("threads.create", {});
    const sent = await sendStarted(r, { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 });
    await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "error");
    expect(reads).not.toHaveBeenCalled();
    expect(r.pushes.filter((p) => p.channel === "models.speed")).toEqual([]);
  });

  it("deleting the thread takes its replies out of the number", async () => {
    const r = await rig();
    r.setChat((res) => stream(res, [piece("hi"), measured]));
    const t = await r.client.call("threads.create", {});
    const sent = await sendStarted(r, { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 });
    await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "done");
    await r.waitFor("models.speed", (p) => p.length === 1);
    await r.client.call("threads.delete", { threadId: t.id });
    await r.waitFor("models.speed", (p) => p.length === 0);
    expect(await r.client.call("models.speed", {})).toEqual([]);
  });
});

const body64 = (text: string) => Buffer.from(text).toString("base64");
describe("attached files (chat row 3: the model reads a copy by its label, never the whole file in the prompt)", () => {
  type Sent = { messages: Array<{ role: string; content: string }> };
  /** A tool model that reads /library/<id> once, then answers; the prompts and the tool results it saw. */
  function reader(r: Rig, id: string) {
    const prompts: string[] = [], results: string[] = [];
    r.setChat(async (res, body) => {
      const last = (body as Sent).messages.at(-1)!;
      if (last.role === "tool") { results.push(last.content); return stream(res, [piece("Read it."), doneLine]); }
      prompts.push(last.content);
      return stream(res, [line({ model: MODEL, message: { role: "assistant", content: "", tool_calls: [{ function: { name: "read", arguments: { path: `/library/${id}` } } }] }, done: true, done_reason: "stop" })]);
    });
    return { prompts, results };
  }

  it("the copy has a generated name, the prompt names it in one line, the read tool opens it by label, a reload keeps it, the thread's delete removes it", async () => {
    const r = await rig({ show: caps(["completion", "tools"]) });
    const dataDir = path.dirname(r.store.dbPath);
    const file = await r.client.call("files.attach", { name: "Notes 2026.txt", type: "text/plain", data: body64("SECRET-WORDS in the file") });
    expect(file).toMatchObject({ name: "Notes 2026.txt", size: 24, type: "text/plain" });
    expect(file.path).toMatch(/^files\/att-[a-f0-9-]{36}$/);
    const copy = path.join(dataDir, file.path);
    expect(readFileSync(copy, "utf8")).toBe("SECRET-WORDS in the file");

    const seen = reader(r, "notes-2026-txt");
    const t = await r.client.call("threads.create", {});
    const sent = await r.client.call("chat.send", { threadId: t.id, content: "what does it say?", model: MODEL, numCtx: 16384, tools: true, files: [file] });
    await r.waitFor("chat.event", p => p.turnId === sent.turnId && p.event.type === "done");
    expect(seen.prompts[0]).toContain('[Attached file "Notes 2026.txt" (24 B, text/plain): read it with the read tool at /library/notes-2026-txt.]');
    expect(seen.prompts[0]).not.toContain("SECRET-WORDS");
    expect(seen.results[0]).toContain("SECRET-WORDS in the file");
    // Saved as the person wrote it; the line is the model's only.
    const saved = (await r.client.call("threads.get", { threadId: t.id })).messages[0]!;
    expect(saved).toMatchObject({ content: "what does it say?", files: [file] });

    // Another thread, with tools on through a file of its own, cannot read it.
    const other = await r.client.call("threads.create", {});
    const own = await r.client.call("files.attach", { name: "other.txt", type: "text/plain", data: body64("other") });
    const elsewhere = reader(r, "notes-2026-txt");
    const nope = await r.client.call("chat.send", { threadId: other.id, content: "and here?", model: MODEL, numCtx: 16384, tools: true, files: [own] });
    await r.waitFor("chat.event", p => p.turnId === nope.turnId && p.event.type === "done");
    expect(elsewhere.results).toEqual([expect.stringContaining("Path is outside your Library")]);

    await r.client.call("threads.delete", { threadId: t.id });
    expect(existsSync(copy)).toBe(false);
  });

  it("with tools off the line says the model cannot open it, and the send still goes", async () => {
    const r = await rig({ show: caps(["completion", "tools"]) });
    const file = await r.client.call("files.attach", { name: "data.csv", type: "text/csv", data: body64("a,b\n1,2\n") });
    const prompts: string[] = [];
    r.setChat(async (res, body) => { prompts.push((body as Sent).messages.at(-1)!.content); return stream(res, [piece("ok"), doneLine]); });
    const t = await r.client.call("threads.create", {});
    const sent = await r.client.call("chat.send", { threadId: t.id, content: "", model: MODEL, numCtx: 16384, tools: false, files: [file] });
    await r.waitFor("chat.event", p => p.turnId === sent.turnId && p.event.type === "done");
    expect(prompts[0]).toBe('[Attached file "data.csv" (8 B, text/csv): you cannot open it in this reply, because tools are off.]');
  });

  it("a file one chat holds is refused in another chat, and the first chat can send it again", async () => {
    const r = await rig({ show: caps(["completion", "tools"]) });
    const file = await r.client.call("files.attach", { name: "plan.txt", type: "text/plain", data: body64("the plan") });
    r.setChat(async res => stream(res, [piece("ok"), doneLine]));
    const first = await r.client.call("threads.create", {});
    const sent = await r.client.call("chat.send", { threadId: first.id, content: "read this", model: MODEL, numCtx: 16384, files: [file] });
    await r.waitFor("chat.event", p => p.turnId === sent.turnId && p.event.type === "done");

    const second = await r.client.call("threads.create", {});
    // chat.send answers first (chat row 32): the refusal is the turn's error event, like every other refusal
    const other = await r.client.call("chat.send", { threadId: second.id, content: "and here", model: MODEL, numCtx: 16384, files: [file] });
    const refused = (await r.waitFor("chat.event", p => p.turnId === other.turnId && p.event.type === "error")).event;
    expect(refused).toMatchObject({ code: "image-input", message: "plan.txt is attached in another chat. Attach it here again; your words are kept.", ended: { reason: "failed" } });
    expect((await r.client.call("threads.get", { threadId: second.id })).messages).toEqual([]);

    const again = await r.client.call("chat.send", { threadId: first.id, content: "once more", model: MODEL, numCtx: 16384, files: [file] });
    await r.waitFor("chat.event", p => p.turnId === again.turnId && p.event.type === "done");
    expect((await r.client.call("threads.get", { threadId: first.id })).messages.filter(m => m.files?.length)).toHaveLength(2);
  });

  // Chat row 35 (2): a chip removed from a draft gives its copy up; a send already carrying it keeps it.
  it("files.release removes an unsent copy at once; a release that lands while a send carries the copy leaves it to the message", async () => {
    const r = await rig({ show: caps(["completion", "tools"]) });
    const dataDir = path.dirname(r.store.dbPath);
    const removed = await r.client.call("files.attach", { name: "removed.txt", type: "text/plain", data: body64("removed") });
    await r.client.call("files.release", { paths: [removed.path] });
    expect(existsSync(path.join(dataDir, removed.path))).toBe(false);

    const sent = await r.client.call("files.attach", { name: "sent.txt", type: "text/plain", data: body64("sent") });
    r.setChat(async res => stream(res, [piece("ok"), doneLine]));
    const t = await r.client.call("threads.create", {});
    const [turn] = await Promise.all([
      r.client.call("chat.send", { threadId: t.id, content: "read this", model: MODEL, numCtx: 16384, files: [sent] }),
      r.client.call("files.release", { paths: [sent.path] }),
    ]);
    await r.waitFor("chat.event", p => p.turnId === turn.turnId && p.event.type === "done");
    expect((await r.client.call("threads.get", { threadId: t.id })).messages[0]?.files).toEqual([sent]);
    expect(existsSync(path.join(dataDir, sent.path))).toBe(true);
    expect(await r.client.call("files.keep", { paths: [sent.path, removed.path] })).toEqual({ missing: [removed.path] });
  });

  // Chat row 35 (2): a row a Retry replaces gives up its files.
  it("a Retry without the file removes the copy the replaced question held; a Retry with it keeps it", async () => {
    const r = await rig({ show: caps(["completion", "tools"]) });
    const dataDir = path.dirname(r.store.dbPath);
    const kept = await r.client.call("files.attach", { name: "kept.txt", type: "text/plain", data: body64("kept") });
    const dropped = await r.client.call("files.attach", { name: "dropped.txt", type: "text/plain", data: body64("dropped") });
    r.setChat(async res => { res.writeHead(500).end("{\"error\":\"model failed\"}"); });
    const t = await r.client.call("threads.create", {});
    const sent = await sendStarted(r, { threadId: t.id, content: "read these", model: MODEL, numCtx: 16384, files: [kept, dropped] });
    await r.waitFor("chat.event", p => p.turnId === sent.turnId && p.event.type === "error");
    r.setChat(async res => stream(res, [piece("ok"), doneLine]));
    const again = await sendStarted(r, { threadId: t.id, content: "read this", model: MODEL, numCtx: 16384, files: [kept], retryOf: sent.userMessage.id });
    await r.waitFor("chat.event", p => p.turnId === again.turnId && p.event.type === "done");
    expect((await r.client.call("threads.get", { threadId: t.id })).messages.map(m => m.files?.map(f => f.name))).toEqual([["kept.txt"], undefined]);
    await vi.waitFor(() => expect(existsSync(path.join(dataDir, dropped.path))).toBe(false));
    expect(existsSync(path.join(dataDir, kept.path))).toBe(true);
  });

  it("a link in the files folder is refused at send, and deleting never touches a file outside the folder", async () => {
    const r = await rig({ show: caps(["completion", "tools"]) });
    const dataDir = path.dirname(r.store.dbPath);
    const outside = path.join(dataDir, "outside.txt");
    writeFileSync(outside, "keep me");
    const linked = `files/att-${randomUUID()}`;
    mkdirSync(path.join(dataDir, "files"), { recursive: true });
    symlinkSync(outside, path.join(dataDir, linked));
    const t = await r.client.call("threads.create", {});
    // chat.send answers first (chat row 32): the refusal is the turn's error event
    const sent = await r.client.call("chat.send", { threadId: t.id, content: "read", model: MODEL, numCtx: 16384, files: [{ path: linked, name: "outside.txt", size: 7, type: "" }] });
    const refused = (await r.waitFor("chat.event", p => p.turnId === sent.turnId && p.event.type === "error")).event;
    expect(refused).toMatchObject({ code: "image-input", message: "outside.txt is no longer attached. Attach it again; your words are kept.", ended: { reason: "failed" } });
    expect((await r.client.call("threads.get", { threadId: t.id })).messages, "the question was not saved").toEqual([]);
    // A row that names the link anyway: its delete removes the link in the folder, never what it points at.
    r.store.appendMessage({ threadId: t.id, role: "user", content: "linked", files: [{ path: linked, name: "outside.txt", size: 7, type: "" }] });
    await r.client.call("threads.delete", { threadId: t.id });
    expect(readFileSync(outside, "utf8")).toBe("keep me");
    expect(existsSync(path.join(dataDir, linked))).toBe(false);
  });
});
