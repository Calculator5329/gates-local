// app.ts end to end: the real ws server, the contracts client, the real
// thread store, runtime and catalog against a fake Ollama on port 0. The fit
// check reads fake nvidia-smi and meminfo text; nothing touches the GPU or a
// real Ollama, and the runtime only ever runs discover() (never ensure()).
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { type Channel, type Client, type Payload, type SocketLike, WireError, createClient } from "@gates-local/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { type App, createApp } from "../src/app.ts";
import { createGpuLease, type GpuLease } from "../src/gpu/lease.ts";
import type { ImageModule } from "../src/image/module.ts";
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
  setChat(route: ChatRoute): void;
  pushes: Array<{ channel: Channel; payload: unknown }>;
  /** Stored message count of the thread at the moment each done event left app.ts (in process, before the socket). */
  storedAtDonePush: number[];
  waitFor<C extends Channel>(channel: C, match: (p: Payload<C>) => boolean, timeoutMs?: number): Promise<Payload<C>>;
}

/** `image` builds an image module over the rig's GPU lease; only then does the app get a lease. */
async function rig(opts: { ollamaUp?: boolean; image?: (lease: GpuLease) => ImageModule; show?: unknown } = {}): Promise<Rig> {
  const ollamaUp = opts.ollamaUp ?? true;
  let chat: ChatRoute = quickReply;
  const ollama = await startFakeServer({
    "GET /": (_b, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("Ollama is running");
    },
    "GET /api/version": (_b, res) => json(res, 200, { version: "0.0.9-fake" }),
    "GET /api/tags": (_b, res) => json(res, 200, TAGS),
    "GET /api/ps": (_b, res) => json(res, 200, { models: [] }),
    "POST /api/show": (_b, res) => json(res, 200, opts.show ?? SHOW),
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
    systemModelsDirs: [],
    probeTimeoutMs: 500,
  });
  const catalog = createModelCatalog(() => runtime.baseUrl());
  const gpu: Gpu = { freeMib: 15000, memAvailableKb: 30_000_000 };
  const storedAtDonePush: number[] = [];

  let server: WsServer | undefined;
  const lease = opts.image ? createGpuLease() : undefined;
  const app = createApp({
    store,
    runtime,
    catalog,
    ...(lease && opts.image ? { lease, image: opts.image(lease) } : {}),
    push: (c, p) => {
      if (c === "chat.event") {
        const { threadId, event } = p as Payload<"chat.event">;
        if (event.type === "done") storedAtDonePush.push(store.getThread(threadId).messages.length);
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
  server = await startWsServer({ port: 0, token: TOKEN, allowedOrigins: [], handlers: app.handlers, log: () => undefined });
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
  return { app, server, client, store, runtime, ollama, gpu, setChat: (r) => (chat = r), pushes, storedAtDonePush, waitFor };
}

const events = (r: Rig, turnId: string) =>
  r.pushes.filter((p) => p.channel === "chat.event" && (p.payload as Payload<"chat.event">).turnId === turnId).map((p) => (p.payload as Payload<"chat.event">).event);

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
  it("streams every event, persists the done message before pushing done, and returns at once", async () => {
    const r = await rig();
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
    expect(events(r, sent.turnId)).toEqual([]); // returned before any reply byte
    expect(r.app.activeTurns()).toBe(1);

    // The store already has the user message; the turn is streaming.
    expect((await r.client.call("threads.get", { threadId: t.id })).messages.map((m) => m.role)).toEqual(["user"]);
    release();
    const done = await r.waitFor("chat.event", (p) => p.turnId === sent.turnId && p.event.type === "done");
    // The assistant message was in the store when the done event was pushed.
    expect(r.storedAtDonePush).toEqual([2]);

    expect(events(r, sent.turnId).map((e) => e.type)).toEqual(["delta", "delta", "done"]);
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

    // Below the num_ctx floor the fit check refuses before reading anything.
    const floor = await rejection(r.client.call("chat.send", { threadId: t.id, content: "x", model: MODEL, numCtx: 4096 }));
    expect(floor.code).toBe("wont-fit");
    expect(floor.message).toContain("16384");

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
});

/**
 * A fake image module: an idle ComfyUI with this owner (MainPID 4242 when the app's); stopIdle
 * claims the GPU alone, as image/module.ts does.
 */
function idleComfy(owner: "app" | "external", onStop: () => void) {
  let stops = 0;
  const build = (lease: GpuLease) => ({
    current: () => ({ state: "ready", owner }),
    reclaimable: () => (owner === "app" && stops === 0 ? 4242 : undefined),
    stopIdle: () => lease.run("image", undefined, async () => { stops += 1; onStop(); }),
  }) as unknown as ImageModule;
  return { build, stops: () => stops };
}

describe("chat.send frees an idle ComfyUI the app started", () => {
  it("stops it before the turn claims the GPU and measures again when the turn would not fit beside it", async () => {
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

describe("chat.cancel and threads.delete during a turn", () => {
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
