import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { json, startFakeServer, type FakeServer } from "../fit/fake-http.ts";
import { chatRequestBody, streamTurn, type StreamTurnInput } from "./stream.ts";
import type { ChatEvent } from "./types.ts";

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
const content = (text: string) => line({ model: "m", message: { role: "assistant", content: text }, done: false });
const think = (text: string) => line({ model: "m", message: { role: "assistant", content: "", thinking: text }, done: false });
const doneLine = (reason = "stop") =>
  line({
    model: "m",
    message: { role: "assistant", content: "" },
    done: true,
    done_reason: reason,
    // Load and prompt time dwarf decode here, the way a cold first turn does.
    total_duration: 1_234_000_000,
    prompt_eval_duration: 84_000_000,
    eval_duration: 150_000_000,
    prompt_eval_count: 21,
    eval_count: 9,
  });

/** Writes each piece as its own chunk, optionally splitting lines across chunks. */
async function streamPieces(res: ServerResponse, pieces: string[], delayMs = 0): Promise<void> {
  res.writeHead(200, { "content-type": "application/x-ndjson" });
  for (const piece of pieces) {
    res.write(piece);
    if (delayMs) await sleep(delayMs);
  }
  res.end();
}

async function fakeChat(handler: (res: ServerResponse) => Promise<void> | void): Promise<FakeServer> {
  server = await startFakeServer({ "POST /api/chat": (_b, res) => handler(res) });
  return server;
}

async function collect(input: Partial<StreamTurnInput> & { baseUrl: string }): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of streamTurn({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    numCtx: 16384,
    threadId: "t1",
    newId: () => "msg-1",
    now: () => 42,
    ...input,
  })) {
    events.push(event);
  }
  return events;
}

describe("request body", () => {
  it("always carries options.num_ctx and stream true; think only when set", () => {
    const body = chatRequestBody({ model: "m", messages: [{ role: "user", content: "x" }], numCtx: 32768 });
    expect(body).toEqual({ model: "m", messages: [{ role: "user", content: "x" }], stream: true, options: { num_ctx: 32768 } });
    expect(chatRequestBody({ model: "m", messages: [], numCtx: 16384, think: false })).toMatchObject({ think: false });
  });
});

describe("streamTurn against a fake Ollama", () => {
  it("streams a normal reply and ends with one done carrying the stats", async () => {
    const s = await fakeChat((res) => streamPieces(res, [content("Two "), content("plus two "), content("is four."), doneLine()]));
    const events = await collect({ baseUrl: s.baseUrl });
    expect(events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text)).toEqual(["Two ", "plus two ", "is four."]);
    expect(events.at(-1)).toEqual({
      type: "done",
      stopReason: "stop",
      message: {
        id: "msg-1",
        threadId: "t1",
        role: "assistant",
        content: "Two plus two is four.",
        model: "m",
        createdAt: 42,
        stats: { promptTokens: 21, completionTokens: 9, durationMs: 1234, evalDurationMs: 150, promptEvalDurationMs: 84, numCtx: 16384 },
      },
    });
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  });

  it("sends num_ctx in every request body", async () => {
    const s = await fakeChat((res) => streamPieces(res, [content("ok"), doneLine()]));
    await collect({ baseUrl: s.baseUrl, numCtx: 16384 });
    await collect({ baseUrl: s.baseUrl, numCtx: 65536, think: true });
    const bodies = s.requests.filter((r) => r.path === "/api/chat").map((r) => r.body as { options?: { num_ctx?: number }; think?: boolean; stream?: boolean });
    expect(bodies.map((b) => b.options?.num_ctx)).toEqual([16384, 65536]);
    expect(bodies.every((b) => b.stream === true)).toBe(true);
    expect(bodies[1]?.think).toBe(true);
  });

  it("keeps thinking separate from the answer, across split chunks", async () => {
    const whole = think("Let me ") + think("add.") + content("4") + doneLine();
    // Cut the NDJSON at arbitrary byte offsets, mid-line.
    const pieces = [whole.slice(0, 17), whole.slice(17, 60), whole.slice(60, 61), whole.slice(61)];
    const s = await fakeChat((res) => streamPieces(res, pieces, 5));
    const events = await collect({ baseUrl: s.baseUrl, think: true });
    expect(events.filter((e) => e.type === "thinking").map((e) => (e as { text: string }).text).join("")).toBe("Let me add.");
    expect(events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text)).toEqual(["4"]);
    const done = events.at(-1);
    expect(done).toMatchObject({ type: "done", message: { content: "4", thinking: "Let me add." } });
  });

  it("reports a length stop instead of hiding it", async () => {
    const s = await fakeChat((res) => streamPieces(res, [content("A very long"), doneLine("length")]));
    const events = await collect({ baseUrl: s.baseUrl });
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "length", message: { content: "A very long" } });
  });

  it("turns an error line mid-stream into an error event with no done", async () => {
    const s = await fakeChat((res) => streamPieces(res, [content("par"), line({ error: "CUDA error: out of memory" })]));
    const events = await collect({ baseUrl: s.baseUrl });
    expect(events.map((e) => e.type)).toEqual(["delta", "error"]);
    expect(events.at(-1)).toEqual({ type: "error", code: "stream-error", message: "CUDA error: out of memory" });
  });

  it("a connection cut mid-stream without done is stream-ended-early", async () => {
    const s = await fakeChat((res) => streamPieces(res, [content("par")]));
    const events = await collect({ baseUrl: s.baseUrl });
    expect(events.at(-1)).toMatchObject({ type: "error", code: "stream-ended-early" });
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  it("a garbage line is malformed-stream", async () => {
    const s = await fakeChat((res) => streamPieces(res, [content("a"), "{not json\n", doneLine()]));
    const events = await collect({ baseUrl: s.baseUrl });
    expect(events.at(-1)).toMatchObject({ type: "error", code: "malformed-stream" });
  });

  it("maps HTTP errors to codes and keeps Ollama's message", async () => {
    let status = 404;
    const s = await fakeChat((res) => json(res, status, { error: status === 404 ? "model 'm' not found" : "server busy" }));
    expect((await collect({ baseUrl: s.baseUrl })).at(-1)).toEqual({ type: "error", code: "model-not-found", message: "HTTP 404: model 'm' not found" });
    status = 500;
    expect((await collect({ baseUrl: s.baseUrl })).at(-1)).toEqual({ type: "error", code: "http-error", message: "HTTP 500: server busy" });
  });

  it("an unreachable runtime is connection-failed", async () => {
    const events = await collect({ baseUrl: "http://127.0.0.1:1" });
    expect(events).toEqual([expect.objectContaining({ type: "error", code: "connection-failed" })]);
  });

  it("cancel mid-stream ends with a cancelled error, no done, and closes the socket", async () => {
    let serverSawClose = false;
    const s = await fakeChat(async (res) => {
      res.on("close", () => {
        serverSawClose = true;
      });
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      for (let i = 0; i < 200 && !res.destroyed; i++) {
        res.write(content(`tok${i} `));
        await sleep(20);
      }
      if (!res.destroyed) res.end(doneLine());
    });
    const controller = new AbortController();
    const events: ChatEvent[] = [];
    for await (const event of streamTurn({ baseUrl: s.baseUrl, model: "m", messages: [{ role: "user", content: "hi" }], numCtx: 16384, signal: controller.signal })) {
      events.push(event);
      if (events.length === 2) controller.abort();
    }
    expect(events.at(-1)).toMatchObject({ type: "error", code: "cancelled" });
    expect(events.some((e) => e.type === "done")).toBe(false);
    expect(events.filter((e) => e.type === "delta").length).toBeLessThan(10);
    await sleep(50);
    expect(serverSawClose).toBe(true);
  });

  it("an already-aborted signal sends nothing", async () => {
    const s = await fakeChat((res) => streamPieces(res, [doneLine()]));
    const controller = new AbortController();
    controller.abort();
    const events = await collect({ baseUrl: s.baseUrl, signal: controller.signal });
    expect(events).toEqual([expect.objectContaining({ type: "error", code: "cancelled" })]);
    expect(s.requests).toEqual([]);
  });

  it("an 8k turn sends num_ctx 8192", async () => {
    const s = await fakeChat((res) => streamPieces(res, [content("ok"), doneLine()]));
    const events = await collect({ baseUrl: s.baseUrl, numCtx: 8192 });
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    const bodies = s.requests.filter((r) => r.path === "/api/chat").map((r) => r.body as { options?: { num_ctx?: number } });
    expect(bodies.map((b) => b.options?.num_ctx)).toEqual([8192]);
  });

  it("refuses num_ctx below 8192 before any request is sent", async () => {
    const s = await fakeChat((res) => streamPieces(res, [doneLine()]));
    for (const numCtx of [4096, 8191, 2048, 8192.5]) {
      const events = await collect({ baseUrl: s.baseUrl, numCtx });
      expect(events).toEqual([expect.objectContaining({ type: "error", code: "num-ctx-below-floor" })]);
    }
    expect(s.requests).toEqual([]);
  });
});
