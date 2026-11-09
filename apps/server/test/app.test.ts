// app.ts end to end: the real ws server, the contracts client, the real
// thread store, runtime and catalog against a fake Ollama on port 0. The fit
// check reads fake nvidia-smi and meminfo text; nothing touches the GPU or a
// real Ollama, and the runtime only ever runs discover() (never ensure()).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { type Channel, type Client, type ImageEvent, type Payload, type SocketLike, WireError, createClient } from "@gates-local/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { type App, createApp } from "../src/app.ts";
import { createGpuLease, type GpuLease } from "../src/gpu/lease.ts";
import { createImageModule, type ImageModule } from "../src/image/module.ts";
import { json, startFakeServer, type FakeServer } from "../src/fit/fake-http.ts";
import { createModelCatalog } from "../src/runtime/models.ts";
import { createOllamaRuntime, type OllamaRuntime } from "../src/runtime/runtime.ts";
import { freePort } from "../src/runtime/test-fakes.ts";
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
  waitFor<C extends Channel>(channel: C, match: (p: Payload<C>) => boolean, timeoutMs?: number): Promise<Payload<C>>;
}

/** `image` builds an image module over the rig's GPU lease; only then does the app get a lease. */
async function rig(opts: { ollamaUp?: boolean; image?: (lease: GpuLease, store: ThreadStore, dir: string) => ImageModule; show?: unknown; admit?: () => void; onTerminal?: () => void } = {}): Promise<Rig> {
  const ollamaUp = opts.ollamaUp ?? true;
  let chat: ChatRoute = quickReply;
  let show: ChatRoute = (res) => json(res, 200, opts.show ?? SHOW);
  const ollama = await startFakeServer({
    "GET /": (_b, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("Ollama is running");
    },
    "GET /api/version": (_b, res) => json(res, 200, { version: "0.0.9-fake" }),
    "GET /api/tags": (_b, res) => json(res, 200, TAGS),
    "GET /api/ps": (_b, res) => json(res, 200, { models: [] }),
    "POST /api/show": (body, res) => show(res, body),
    "POST /api/chat": (body, res) => chat(res, body),
  });
  cleanups.push(() => ollama.close());

  const dir = cacheTmp();
  const store = openThreadStore(path.join(dir, "threads.sqlite"));
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
  const gpu: Gpu = { freeMib: 15000, memAvailableKb: 30_000_000 };
  const storedAtDonePush: number[] = [];
  const replayedAtDone: Payload<"chat.event">[] = [];

  let server: WsServer | undefined;
  const lease = opts.image ? createGpuLease() : undefined;
  const app: App = createApp({
    dataDir: dir,
    store,
    runtime,
    catalog,
    ...(opts.admit ? { admit: opts.admit } : {}),
    ...(lease && opts.image ? { lease, image: opts.image(lease, store, dir) } : {}),
    push: (c, p) => {
      if (c === "chat.event") {
        const { threadId, event } = p as Payload<"chat.event">;
        if (event.type === "done") {
          storedAtDonePush.push(store.getThread(threadId).messages.length);
          app.replayTurns((channel, payload) => { if (channel === "chat.event") replayedAtDone.push(payload as Payload<"chat.event">); });
        }
        if (event.type === "done" || event.type === "error") opts.onTerminal?.();
      }
      server?.push(c, p);
    },
    fit: {
      runNvidiaSmi: async (args) => (args[0]?.startsWith("--query-gpu") ? `16303, ${16303 - gpu.freeMib}, ${gpu.freeMib}\n` : (gpu.apps ?? "")),
      readMeminfo: async () => `MemTotal: 32541464 kB\nMemAvailable: ${gpu.memAvailableKb} kB\n`,
    },
    log: () => undefined,
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
  for (const channel of ["chat.event", "runtime.changed", "models.changed", "threads.changed"] as const) {
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
  return { app, server, client, store, runtime, ollama, gpu, lease, setChat: (r) => (chat = r), setShow: (r) => (show = r), pushes, storedAtDonePush, replayedAtDone, waitFor };
}

const events = (r: Rig, turnId: string) =>
  r.pushes.filter((p) => p.channel === "chat.event" && (p.payload as Payload<"chat.event">).turnId === turnId).map((p) => (p.payload as Payload<"chat.event">).event);

it("vision paste reaches the model, saves paths, and survives Retry and thread reload", async () => {
  const r = await rig({ show: { ...(SHOW as Record<string, unknown>), capabilities: ["completion", "vision"] } });
  const thread = await r.client.call("threads.create", { title: "Pasted images" });
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOor6//DwAFewJ94ITM6gAAAABJRU5ErkJggg==";
  const first = await r.client.call("chat.send", { threadId: thread.id, content: "look", model: MODEL, numCtx: 16384, images: [`data:image/png;base64,${png}`] });
  await r.waitFor("chat.event", p => p.turnId === first.turnId && p.event.type === "done");
  expect(first.userMessage.images?.[0]).toMatch(/^images\/paste-.*\.png$/);
  const loaded = await r.client.call("threads.get", { threadId: thread.id });
  expect(loaded.messages[0]?.images).toEqual(first.userMessage.images);
  const again = await r.client.call("chat.send", { threadId: thread.id, content: "look again", model: MODEL, numCtx: 16384, images: first.userMessage.images });
  await r.waitFor("chat.event", p => p.turnId === again.turnId && p.event.type === "done");
  const body = r.ollama.requests.filter(q => q.path === "/api/chat").at(-1)?.body;
  expect(body).toMatchObject({ messages: [{ role: "user", content: "look", images: [png] }, { role: "assistant" }, { role: "user", content: "look again", images: [png] }], options: { num_ctx: 16384 } });
  expect((body as { options: unknown }).options).not.toHaveProperty("num_gpu");
});

it("the server refuses pasted images on non-vision models before a load or saved message", async () => {
  const r = await rig({ show: { ...(SHOW as Record<string, unknown>), capabilities: ["completion"] } });
  const thread = await r.client.call("threads.create", { title: "Pasted images" });
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOor6//DwAFewJ94ITM6gAAAABJRU5ErkJggg==";
  await expect(r.client.call("chat.send", { threadId: thread.id, content: "look", model: MODEL, numCtx: 16384, images: [`data:image/png;base64,${png}`] })).rejects.toMatchObject({ code: "image-input", message: expect.stringContaining("cannot see images") });
  expect(r.store.getThread(thread.id).messages).toEqual([]);
  expect(r.ollama.requests.filter(q => q.path === "/api/chat")).toEqual([]);
});

it("an image-only turn uses T3's model prompt while the saved message stays image-only", async () => {
  const r = await rig({ show: { ...(SHOW as Record<string, unknown>), capabilities: ["completion", "vision"] } });
  const thread = r.store.createThread();
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOor6//DwAFewJ94ITM6gAAAABJRU5ErkJggg==";
  const sent = await r.client.call("chat.send", { threadId: thread.id, content: "", model: MODEL, numCtx: 16384, images: [`data:image/png;base64,${png}`] });
  await r.waitFor("chat.event", p => p.turnId === sent.turnId && p.event.type === "done");
  expect(sent.userMessage.content).toBe("");
  expect(r.ollama.requests.find(q => q.path === "/api/chat")?.body).toMatchObject({ messages: [{ content: "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]", images: [png] }] });
});

it.each([false, true])("PC-03: retrying after a lost acknowledgement returns the saved message without a second turn (finished: %s)", async finished => {
  const r = await rig();
  const thread = r.store.createThread();
  const input = { threadId: thread.id, messageId: "public-lost-ack", content: "saved before disconnect", model: MODEL, numCtx: 16384 };
  const first = await r.client.call("chat.send", input);
  if (finished) await r.waitFor("chat.event", p => p.turnId === first.turnId && p.event.type === "done");
  const retry = await r.client.call("chat.send", input);
  await r.waitFor("chat.event", p => p.turnId === first.turnId && p.event.type === "done");
  expect(r.store.getThread(thread.id).messages.filter(m => m.role === "user")).toHaveLength(1);
  expect(retry.userMessage.id).toBe(first.userMessage.id);
  expect(r.ollama.requests.filter(q => q.path === "/api/chat")).toHaveLength(1);
  await expect(r.client.call("chat.send", { ...input, content: "different words" })).rejects.toMatchObject({ code: "image-input" });
});

it("tells the model and person when a text-only follow-up omits earlier images", async () => {
  const r = await rig({ show: { ...(SHOW as Record<string, unknown>), capabilities: ["completion", "vision"] } });
  const thread = r.store.createThread();
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOor6//DwAFewJ94ITM6gAAAABJRU5ErkJggg==";
  const first = await r.client.call("chat.send", { threadId: thread.id, content: "chart", model: MODEL, numCtx: 16384, images: [`data:image/png;base64,${png}`] });
  await r.waitFor("chat.event", p => p.turnId === first.turnId && p.event.type === "done");
  r.setShow(res => json(res, 200, { ...(SHOW as Record<string, unknown>), capabilities: ["completion"] }));
  r.setChat(slowReply);
  const next = await r.client.call("chat.send", { threadId: thread.id, content: "read chart", model: MODEL, numCtx: 16384 });
  await r.waitFor("chat.event", p => p.turnId === next.turnId && p.event.type === "delta" && p.event.contextNotice !== undefined);
  const replayed: Payload<"chat.event">[] = [];
  r.app.replayTurns((channel, payload) => { if (channel === "chat.event") replayed.push(payload as Payload<"chat.event">); });
  expect(replayed).toContainEqual(expect.objectContaining({ turnId: next.turnId, event: expect.objectContaining({ type: "delta", contextNotice: expect.stringContaining("image") }) }));
  await r.waitFor("chat.event", p => p.turnId === next.turnId && p.event.type === "done");
  expect(JSON.stringify(r.ollama.requests.filter(q => q.path === "/api/chat").at(-1)?.body)).toContain("image was here and is unavailable");
  expect(events(r, next.turnId)).toContainEqual(expect.objectContaining({ type: "done", message: expect.objectContaining({ contextNotice: expect.stringContaining("image") }) }));
  expect(r.store.getThread(thread.id).messages[0]?.content).toBe("chart");
});

it("thread deletion removes its unshared pasted image file", async () => {
  const r = await rig({ show: { ...(SHOW as Record<string, unknown>), capabilities: ["completion", "vision"] } });
  const thread = r.store.createThread();
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOor6//DwAFewJ94ITM6gAAAABJRU5ErkJggg==";
  const sent = await r.client.call("chat.send", { threadId: thread.id, content: "chart", model: MODEL, numCtx: 16384, images: [`data:image/png;base64,${png}`] });
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
  const sent = await r.client.call("chat.send", { threadId: first.id, content: "chart", model: MODEL, numCtx: 16384, images: [`data:image/png;base64,${png}`] });
  await r.waitFor("chat.event", p => p.turnId === sent.turnId && p.event.type === "done");
  const images = [...sent.userMessage.images!], filename = path.join(path.dirname(r.store.dbPath), images[0]!);
  const copy = r.store.appendMessage({ threadId: second.id, role: "user", content: "shared", images });
  await r.client.call("threads.delete", { threadId: first.id });
  expect(existsSync(filename)).toBe(true);
  await r.client.call("messages.delete", { threadId: second.id, messageId: copy.id });
  expect(existsSync(filename)).toBe(false);
});

it("failed admission leaves no new image file", async () => {
  const r = await rig({ show: { ...(SHOW as Record<string, unknown>), capabilities: ["completion", "vision"] } });
  const thread = r.store.createThread();
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOor6//DwAFewJ94ITM6gAAAABJRU5ErkJggg==";
  const append = vi.spyOn(r.store, "appendMessage").mockImplementationOnce(() => { throw new Error("synthetic database write failure"); });
  await expect(r.client.call("chat.send", { threadId: thread.id, content: "chart", model: MODEL, numCtx: 16384, images: [`data:image/png;base64,${png}`] })).rejects.toThrow("synthetic database write failure");
  append.mockRestore();
  expect(readdirSync(path.join(path.dirname(r.store.dbPath), "images"))).toEqual([]);
});

it("a draft referencing an image that is gone is refused in plain words before saving", async () => {
  const r = await rig({ show: { ...(SHOW as Record<string, unknown>), capabilities: ["completion", "vision"] } });
  const thread = r.store.createThread();
  await expect(r.client.call("chat.send", { threadId: thread.id, content: "keep my words", model: MODEL, numCtx: 16384, images: ["images/paste-00000000-0000-4000-8000-000000000000.png"] })).rejects.toMatchObject({ code: "image-input", message: expect.stringContaining("Paste it again; your words are kept") });
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
    const sent = await r.client.call("chat.send", { threadId: thread.id, content: "hello", model: MODEL, numCtx: 16384 });
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
    await r.client.call("chat.send", { threadId: thread.id, content: "hello", model: MODEL, numCtx: 16384 });
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
    const sent = await r.client.call("chat.send", { threadId: t.id, content: "2+2?", model: MODEL, numCtx: 16384 });
    expect(sent.userMessage).toMatchObject({ threadId: t.id, role: "user", content: "2+2?" });
    // returned before any reply byte; the start push came first, for every client (PH-02)
    expect(events(r, sent.turnId)).toEqual([{ type: "start", model: MODEL, userMessage: sent.userMessage }]);
    expect(r.app.activeTurns()).toBe(1);
    expect(await r.client.call("turns.active", {})).toEqual([{ threadId: t.id, turnId: sent.turnId }]);

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
    const a = await r.client.call("chat.send", { threadId: t.id, content: "one", model: MODEL, numCtx: 16384 });
    await r.waitFor("chat.event", (p) => p.turnId === a.turnId && p.event.type === "done");
    const b = await r.client.call("chat.send", { threadId: t.id, content: "two", model: MODEL, numCtx: 16384 });
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
    const first = await r.client.call("chat.send", { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 });
    const err = await rejection(r.client.call("chat.send", { threadId: t.id, content: "y", model: MODEL, numCtx: 16384 }));
    expect(err.code).toBe("turn-active");
    expect(err.message).toContain(first.turnId);
    const parallel = await r.client.call("chat.send", { threadId: other.id, content: "z", model: MODEL, numCtx: 16384 });
    await r.waitFor("chat.event", (p) => p.turnId === first.turnId && p.event.type === "done");
    await r.waitFor("chat.event", (p) => p.turnId === parallel.turnId && p.event.type === "done");
    // The refused send stored nothing.
    expect(r.store.getThread(t.id).messages.map((m) => m.content)).toEqual(["x", "abc"]);
  });

  it("two sends racing through the fit check still get one turn", async () => {
    const r = await rig();
    const t = await r.client.call("threads.create", {});
    const results = await Promise.allSettled([
      r.client.call("chat.send", { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 }),
      r.client.call("chat.send", { threadId: t.id, content: "y", model: MODEL, numCtx: 16384 }),
    ]);
    expect(results.map((x) => x.status).toSorted()).toEqual(["fulfilled", "rejected"]);
    const refused = results.find((x) => x.status === "rejected");
    expect((refused as PromiseRejectedResult).reason).toMatchObject({ code: "turn-active" });
  });

  it("throws runtime-not-ready when no Ollama answers, and stores nothing", async () => {
    const r = await rig({ ollamaUp: false });
    expect(r.runtime.status().state).toBe("missing");
    const t = await r.client.call("threads.create", {});
    const err = await rejection(r.client.call("chat.send", { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 }));
    expect(err.code).toBe("runtime-not-ready");
    expect(err.message).toContain("missing");
    expect((await rejection(r.client.call("fit.check", { model: MODEL, numCtx: 16384 }))).code).toBe("runtime-not-ready");
    expect(r.store.getThread(t.id).messages).toEqual([]);
    expect(r.app.activeTurns()).toBe(0);
    expect(r.ollama.requests.filter((q) => q.path === "/api/chat")).toEqual([]);
  });

  it("throws wont-fit with the fit report's message on refuse; spills is allowed", async () => {
    const r = await rig();
    const t = await r.client.call("threads.create", {});
    r.gpu.freeMib = 3000;
    r.gpu.memAvailableKb = 1_000_000;
    const report = await r.client.call("fit.check", { model: MODEL, numCtx: 16384 });
    expect(report.verdict).toBe("refuse");
    const err = await rejection(r.client.call("chat.send", { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 }));
    expect(err.code).toBe("wont-fit");
    expect(err.message).toBe(report.message);
    expect(err.message).toMatch(/refused, short by/);
    expect(r.store.getThread(t.id).messages).toEqual([]);
    expect(r.ollama.requests.filter((q) => q.path === "/api/chat")).toEqual([]);

    r.gpu.freeMib = 6000;
    r.gpu.memAvailableKb = 40_000_000;
    expect((await r.client.call("fit.check", { model: MODEL, numCtx: 16384 })).verdict).toBe("spills");
    const sent = await r.client.call("chat.send", { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 });
    await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "done");
  });
});

/** One turn against a fake whose /api/show is `show`; returns the chat request body. */
const sendWith = async (show: unknown, think: boolean) => {
  const r = await rig({ show });
  const bodies: Array<Record<string, unknown>> = [];
  r.setChat((res, body) => {
    bodies.push(body as Record<string, unknown>);
    return quickReply(res, body);
  });
  const t = await r.client.call("threads.create", {});
  const sent = await r.client.call("chat.send", { threadId: t.id, content: "x", model: MODEL, numCtx: 16384, think });
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

describe("a model with a 2,048 context window", () => {
  it("is allowed, runs at 2,048 when 16k is asked for, and says so in its stats", async () => {
    const r = await rig({ show: TINY_SHOW });
    const bodies: unknown[] = [];
    r.setChat((res, body) => {
      bodies.push(body);
      return quickReply(res, body);
    });
    const report = await r.client.call("fit.check", { model: MODEL, numCtx: 16384 });
    expect(report).toMatchObject({ verdict: "fits", numCtx: 2048 });
    expect(await r.client.call("models.list", {})).toEqual([expect.objectContaining({ name: MODEL, maxContext: 2048 })]);

    const t = await r.client.call("threads.create", {});
    const sent = await r.client.call("chat.send", { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 });
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
async function stalledThinkTurn() {
  const r = await rig({ image: idleComfy("external", () => undefined).build });
  // The catalog reads each model's capabilities with /api/show too (runtime/models.ts), on the
  // runtime's ready event. Wait until it lists the model: its capabilities are then cached by
  // digest, so the stall below meets only the turn's own calls (fit check, then think probe).
  for (let i = 0; !(await r.client.call("models.list", {})).some((m) => m.name === MODEL); i += 1) {
    if (i > 100) throw new Error("the catalog never listed the model");
    await sleep(20);
  }
  let shows = 0;
  r.setShow((res) => {
    shows += 1;
    if (shows === 1) json(res, 200, SHOW);
  });
  const t = await r.client.call("threads.create", {});
  const sent = await r.client.call("chat.send", { threadId: t.id, content: "x", model: MODEL, numCtx: 16384, think: true });
  await until(() => shows === 2);
  expect(r.app.activeTurns()).toBe(1);
  expect(r.lease?.status().holders).toBe(1);
  return { r, t, sent };
}

/**
 * A fake image module: an idle ComfyUI with this owner (MainPID 4242 when the app's); stopIdle
 * claims the GPU alone, as image/module.ts does.
 */
function idleComfy(owner: "app" | "external" | "none", onStop: () => void) {
  let stops = 0;
  let current = owner;
  const build = (lease: GpuLease) => ({
    current: () => ({ state: "ready", owner: current }),
    reclaimable: () => (current === "app" && stops === 0 ? 4242 : undefined),
    stopIdle: () => lease.run("image", undefined, async () => { stops += 1; onStop(); }),
  }) as unknown as ImageModule;
  return { build, stops: () => stops, setOwner: (next: typeof owner) => (current = next) };
}

describe("chat.send frees an idle ComfyUI the app started", () => {
  it("stops it and measures again when the turn would not fit beside it", async () => {
    let gpu: Gpu | undefined;
    const comfy = idleComfy("app", () => { if (gpu) { gpu.freeMib = 15000; delete gpu.apps; } });
    const r = await rig({ image: comfy.build });
    gpu = r.gpu;
    const t = await r.client.call("threads.create", {});
    r.gpu.freeMib = 3000;
    r.gpu.memAvailableKb = 1_000_000;
    // The app's ComfyUI is listed holding what the turn needs beside the 3000 MiB free.
    r.gpu.apps = "4242, /usr/bin/python3 main.py --port 8188, 12000\n";
    const sent = await r.client.call("chat.send", { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 });
    await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "done");
    expect(comfy.stops()).toBe(1);
  });

  it("decides after the turn's claim: a ComfyUI an image job started while the turn waited is stopped, and the turn admitted", async () => {
    let gpu: Gpu | undefined;
    const comfy = idleComfy("none", () => { if (gpu) gpu.freeMib = 15000; });
    const r = await rig({ image: comfy.build });
    gpu = r.gpu;
    const t = await r.client.call("threads.create", {});
    // An image job holds the GPU alone; no ComfyUI the app started is up yet.
    const releaseImage = await r.lease!.acquire("image");
    const sending = r.client.call("chat.send", { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 });
    await until(() => r.lease!.status().waiting.includes("chat"));
    // The job started ComfyUI and finished; it keeps its weights, so the turn would not fit beside it.
    comfy.setOwner("app");
    r.gpu.freeMib = 3000;
    r.gpu.memAvailableKb = 1_000_000;
    releaseImage();
    const sent = await sending;
    await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "done");
    expect(comfy.stops()).toBe(1);
    expect(r.lease!.status()).toEqual({ holder: null, holders: 0, waiting: [] });
  });

  it("leaves it running when the turn fits beside it", async () => {
    const comfy = idleComfy("app", () => undefined);
    const r = await rig({ image: comfy.build });
    const t = await r.client.call("threads.create", {});
    const sent = await r.client.call("chat.send", { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 });
    await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "done");
    expect(comfy.stops()).toBe(0);
  });

  it("never stops a ComfyUI the app did not start, and still refuses", async () => {
    const comfy = idleComfy("external", () => undefined);
    const r = await rig({ image: comfy.build });
    const t = await r.client.call("threads.create", {});
    r.gpu.freeMib = 3000;
    r.gpu.memAvailableKb = 1_000_000;
    const err = await rejection(r.client.call("chat.send", { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 }));
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
      appLoadedModels: () => [], ollamaUrl: () => undefined,
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
        if (pathname === "/object_info") return Response.json({
          CheckpointLoaderSimple: { input: { required: { ckpt_name: [["sdxl_lightning_4step.safetensors"]] } } },
          LoraLoader: { input: { required: { lora_name: [["RW_pixelart_XL_v1.safetensors"]] } } },
        });
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
function managedComfy(hooks: { onStart?: () => void; onStop?: () => void } = {}) {
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
  const build = (lease: GpuLease, store: ThreadStore, dir: string) => {
    dataDir = path.join(dir, "image-data");
    let socket: EventTarget | undefined;
    module = createImageModule({
      dataDir, lease, store, requiredBytes: 1, idleMs: 60_000,
      settings: () => ({ imageGen: true }),
      localAddresses: () => [], lookupHost: async () => { throw new Error("no DNS in tests"); },
      appLoadedModels: () => [], ollamaUrl: () => undefined,
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
        if (pathname === "/object_info") return Response.json({
          CheckpointLoaderSimple: { input: { required: { ckpt_name: [["sdxl_lightning_4step.safetensors"]] } } },
          LoraLoader: { input: { required: { lora_name: [["RW_pixelart_XL_v1.safetensors"]] } } },
        });
        if (pathname === "/queue") return Response.json({ queue_running: [], queue_pending: ctl.busy ? [[0, "someone-else"]] : [] });
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

describe("chat.send reclaims an app-started ComfyUI until it fits or gives up", () => {
  it("a second queued image runs in the turn's first reclaim; the turn tries again, stops ComfyUI once and is admitted", async () => {
    let gpu: Gpu | undefined;
    const comfy = managedComfy({
      // Its weights stay resident after a job; stopping it frees them.
      onStart: () => { if (gpu) { gpu.freeMib = 3000; gpu.memAvailableKb = 1_000_000; } },
      onStop: () => { if (gpu) gpu.freeMib = 15000; },
    });
    const r = await rig({ image: comfy.build });
    gpu = r.gpu;
    cleanups.push(() => comfy.module().close());
    const image = comfy.module();
    // A first job starts ComfyUI: the app owns it now.
    await image.wait((await image.generate({ prompt: "warm up" })).jobId);
    expect(image.current().owner).toBe("app");

    // Image A holds the GPU; the turn waits for its claim; image B queues behind the turn.
    const holdA = gate();
    comfy.ctl.holdNext = holdA.shut;
    const a = await image.generate({ prompt: "a" });
    await until(() => comfy.states(a.jobId).includes("running"));
    const t = await r.client.call("threads.create", {});
    const sending = r.client.call("chat.send", { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 });
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
    expect(comfy.unit).toEqual(["start", "stop"]);
    expect(image.current().owner).toBe("none");
    expect(r.app.activeTurns()).toBe(0);
    expect(r.lease!.status()).toEqual({ holder: null, holders: 0, waiting: [] });
  });

  it("a ComfyUI another client keeps busy: three declined stops, then wont-fit, no claim held", async () => {
    let gpu: Gpu | undefined;
    const comfy = managedComfy({ onStart: () => { if (gpu) { gpu.freeMib = 3000; gpu.memAvailableKb = 1_000_000; } } });
    const r = await rig({ image: comfy.build });
    gpu = r.gpu;
    cleanups.push(() => comfy.module().close());
    const image = comfy.module();
    await image.wait((await image.generate({ prompt: "warm up" })).jobId);
    expect(image.current().owner).toBe("app");

    comfy.ctl.busy = true;
    const mark = comfy.calls.length;
    const t = await r.client.call("threads.create", {});
    const err = await rejection(within(3000, r.client.call("chat.send", { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 }), "chat.send"));
    expect(err.code).toBe("wont-fit");
    // Each stopIdle asks ComfyUI's queue once and declines.
    expect(comfy.calls.slice(mark).filter((c) => c === "/queue")).toHaveLength(3);
    expect(comfy.unit).toEqual(["start"]);
    expect(image.current().owner).toBe("app");
    expect(r.app.activeTurns()).toBe(0);
    expect(r.lease!.status()).toEqual({ holder: null, holders: 0, waiting: [] });
    expect(r.store.getThread(t.id).messages).toEqual([]);
  });

  it("shutdown during the fit check after ComfyUI stops ends the turn as cancelled and lets the claim go (A2-01)", async () => {
    let gpu: Gpu | undefined;
    const comfy = managedComfy({
      onStart: () => { if (gpu) { gpu.freeMib = 3000; gpu.memAvailableKb = 1_000_000; } },
      onStop: () => { if (gpu) gpu.freeMib = 15000; },
    });
    const r = await rig({ image: comfy.build });
    gpu = r.gpu;
    cleanups.push(() => comfy.module().close());
    const image = comfy.module();
    await image.wait((await image.generate({ prompt: "warm up" })).jobId);
    expect(image.current().owner).toBe("app");

    // The first fit check (beside ComfyUI) answers; the one after the stop never does until released.
    const stalled = gate();
    let shows = 0;
    r.setShow(async (res) => {
      shows += 1;
      if (shows >= 2) {
        await stalled.shut;
        return json(res, 503, { error: "late" });
      }
      json(res, 200, SHOW);
    });
    const t = await r.client.call("threads.create", {});
    const sending = rejection(r.client.call("chat.send", { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 }));
    await until(() => shows === 2);
    expect(comfy.unit).toEqual(["start", "stop"]);
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
    const first = await r.client.call("chat.send", { threadId: t.id, content: "draw", model: MODEL, numCtx: 16384, image: true });
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

    const send = await rejection(within(3000, r.client.call("chat.send", { threadId: t.id, content: "draw", model: MODEL, numCtx: 16384, image: true }), "chat.send"));
    expect(send.code).toBe("thread-not-found");
    const generate = await rejection(within(3000, r.client.call("image.generate", { prompt: "another", threadId: t.id }), "image.generate"));
    expect(generate.code).toBe("thread-not-found");
    expect(r.app.activeTurns()).toBe(0);

    health.open();
    expect(await within(3000, deleting, "threads.delete")).toEqual({ threadId: t.id });
    await sleep(300); // room for anything that slipped past the delete to run
    expect(new Set(comfy.events.map((e) => e.jobId))).toEqual(new Set([jobId]));
    expect(comfy.states(jobId)).toEqual(["queued", "running", "cancelled"]);
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
    const talk = await r.client.call("chat.send", { threadId: talking.id, content: "talk", model: MODEL, numCtx: 16384 });
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
    const talk = await r.client.call("chat.send", { threadId: talking.id, content: "talk", model: MODEL, numCtx: 16384 });
    const draw = await r.client.call("chat.send", { threadId: drawing.id, content: "draw", model: MODEL, numCtx: 16384, image: true });
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

describe("chat.cancel and threads.delete during a turn", () => {
  it("AU-01 every client's chat.send passes the server admission boundary", async () => {
    const r = await rig({ admit: () => { throw Object.assign(new Error("Gates Local is closing to update. Try again after it reopens."), { code: "update-installing" }); } });
    const thread = await r.client.call("threads.create", {});
    const error = await rejection(r.client.call("chat.send", { threadId: thread.id, content: "Do not start", model: MODEL, numCtx: 16384 }));
    expect(error).toMatchObject({ code: "update-installing", message: expect.stringContaining("closing to update") });
    expect(r.app.activeTurns()).toBe(0);
    expect(r.store.getThread(thread.id).messages).toHaveLength(0);
  });
  it("cancel mid-stream ends the turn with a cancelled error and persists nothing of the reply", async () => {
    const r = await rig();
    r.setChat(slowReply);
    const t = await r.client.call("threads.create", {});
    const sent = await r.client.call("chat.send", { threadId: t.id, content: "count", model: MODEL, numCtx: 16384 });
    await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "delta");
    expect(await r.client.call("chat.cancel", { turnId: sent.turnId })).toEqual({ cancelled: true });
    const end = await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "error");
    expect(end.event).toMatchObject({ type: "error", code: "cancelled" });
    await sleep(800); // past where the fake would have sent done
    expect(events(r, sent.turnId).some((e) => e.type === "done")).toBe(false);
    expect(r.store.getThread(t.id).messages.map((m) => m.role)).toEqual(["user"]);
    expect(r.app.activeTurns()).toBe(0);
    // A finished or unknown turn is not cancellable; the thread takes a new turn.
    expect(await r.client.call("chat.cancel", { turnId: sent.turnId })).toEqual({ cancelled: false });
    expect(await r.client.call("chat.cancel", { turnId: "no-such-turn" })).toEqual({ cancelled: false });
    r.setChat((res) => stream(res, [piece("fine"), doneLine]));
    const again = await r.client.call("chat.send", { threadId: t.id, content: "again", model: MODEL, numCtx: 16384 });
    await r.waitFor("chat.event", (p) => p.turnId === again.turnId && p.event.type === "done");
  });

  it("delete during a turn cancels it first, then deletes the thread", async () => {
    const r = await rig();
    r.setChat(slowReply);
    const t = await r.client.call("threads.create", {});
    const sent = await r.client.call("chat.send", { threadId: t.id, content: "count", model: MODEL, numCtx: 16384 });
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
    const sent = await r.client.call("chat.send", { threadId: t.id, content: "count", model: MODEL, numCtx: 16384 });
    await r.app.shutdown();
    expect(r.app.activeTurns()).toBe(0);
    const end = await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "error");
    expect(end.event).toMatchObject({ type: "error", code: "cancelled" });
    const err = await rejection(r.client.call("chat.send", { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 }));
    expect(err.code).toBe("shutting-down");
  });

  it("shutdown for an update saves the reply already shown before reopening", async () => {
    const r = await rig();
    r.setChat(slowReply);
    const t = await r.client.call("threads.create", {});
    const sent = await r.client.call("chat.send", { threadId: t.id, content: "count", model: MODEL, numCtx: 16384 });
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
    const sent = await r.client.call("chat.send", { threadId: t.id, content: "Continue with a fresh question", model: MODEL, numCtx: 16384 });
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

describe("turn failures", () => {
  it("an Ollama error mid-stream is forwarded and nothing partial persists", async () => {
    const r = await rig();
    r.setChat((res) => stream(res, [piece("half "), line({ error: "model runner crashed" })]));
    const t = await r.client.call("threads.create", {});
    const sent = await r.client.call("chat.send", { threadId: t.id, content: "x", model: MODEL, numCtx: 16384 });
    const end = await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "error");
    expect(end.event).toEqual({ type: "error", code: "stream-error", message: "model runner crashed" });
    expect(r.store.getThread(t.id).messages.map((m) => m.role)).toEqual(["user"]);
    expect(r.app.activeTurns()).toBe(0);
  });

  it("an unknown thread is thread-not-found and reserves nothing", async () => {
    const r = await rig();
    const err = await rejection(r.client.call("chat.send", { threadId: "nope", content: "x", model: MODEL, numCtx: 16384 }));
    expect(err.code).toBe("thread-not-found");
    expect(r.app.activeTurns()).toBe(0);
  });
});
