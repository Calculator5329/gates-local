// Sample values for every method and push channel. The mapped types make
// a new method or channel without a sample a type error, so round-trip
// tests that walk these tables cover every channel by construction.
import type { Channel, MethodName, Params, Payload, ResultOf } from "./protocol.ts";
import type { Message, ModelInfo, RuntimeStatus, Thread } from "./shapes.ts";

const thread: Thread = { id: "t1", title: "First", createdAt: 1_762_500_000_000, updatedAt: 1_762_500_001_000 };

const userMessage: Message = {
  id: "m1",
  threadId: "t1",
  role: "user",
  content: "hello",
  createdAt: 1_762_500_002_000,
};

const assistantMessage: Message = {
  id: "m2",
  threadId: "t1",
  role: "assistant",
  content: "hi there",
  thinking: "greet back",
  model: "qwen3:14b",
  createdAt: 1_762_500_003_000,
  stats: { promptTokens: 12, completionTokens: 4, durationMs: 812.5, numCtx: 16384 },
};

const models: ModelInfo[] = [
  {
    name: "qwen3:14b",
    digest: "sha256:abc",
    sizeBytes: 9_300_000_000,
    family: "qwen3",
    parameterSize: "14.8B",
    quantization: "Q4_K_M",
    modifiedAt: "2026-11-01T10:00:00Z",
  },
  { name: "gemma3:4b", digest: "sha256:def", sizeBytes: 3_300_000_000, modifiedAt: "2026-10-01T10:00:00Z" },
];

const runtime: RuntimeStatus = { state: "ready", owner: "external", baseUrl: "http://127.0.0.1:11434", version: "0.40.4" };

export const methodSamples: { readonly [M in MethodName]: { readonly params: Params<M>; readonly result: ResultOf<M> } } = {
  "threads.list": { params: {}, result: [thread] },
  "threads.create": { params: { title: "First" }, result: thread },
  "threads.get": { params: { threadId: "t1" }, result: { thread, messages: [userMessage, assistantMessage] } },
  "threads.rename": { params: { threadId: "t1", title: "Renamed" }, result: { ...thread, title: "Renamed" } },
  "threads.delete": { params: { threadId: "t1" }, result: { threadId: "t1" } },
  "models.list": { params: {}, result: models },
  "models.refresh": { params: {}, result: models },
  "runtime.status": { params: {}, result: runtime },
  "fit.check": {
    params: { model: "qwen3:14b", numCtx: 32768 },
    result: {
      model: "qwen3:14b",
      numCtx: 32768,
      freeVramBytes: 11_000_000_000,
      needVramBytes: 12_500_000_000,
      spillRamBytes: 1_500_000_000,
      verdict: "spills",
      shortfallBytes: 1_500_000_000,
      source: "measured",
      measuredAt: 1_762_500_004_000,
    },
  },
  "chat.send": {
    params: { threadId: "t1", content: "hello", model: "qwen3:14b", numCtx: 16384 },
    result: { turnId: "turn-1", userMessage },
  },
  "chat.cancel": { params: { turnId: "turn-1" }, result: { cancelled: true } },
};

/** One sample per channel; chat.event gets one per ChatEvent variant. */
export const pushSamples: { readonly [C in Channel]: readonly Payload<C>[] } = {
  "chat.event": [
    { turnId: "turn-1", threadId: "t1", event: { type: "thinking", text: "greet" } },
    { turnId: "turn-1", threadId: "t1", event: { type: "delta", text: "hi " } },
    { turnId: "turn-1", threadId: "t1", event: { type: "done", message: assistantMessage } },
    { turnId: "turn-1", threadId: "t1", event: { type: "error", code: "runtime-gone", message: "Ollama stopped" } },
  ],
  "runtime.changed": [runtime, { state: "missing", owner: "none", baseUrl: "http://127.0.0.1:11434", detail: "no answer" }],
  "models.changed": [models, []],
  "threads.changed": [{ threadId: "t1" }],
};
