// Sample values for every method and push channel. The mapped types make
// a new method or channel without a sample a type error, so round-trip
// tests that walk these tables cover every channel by construction.
import type { Channel, MethodName, Params, Payload, ResultOf } from "./protocol.ts";
import type { GpuStatus, ImageStatus, Message, ModelInfo, PullProgress, RuntimeStatus, Settings, Source, Thread, ToolStep } from "./shapes.ts";

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

const toolStep: ToolStep = {
  callId: "c1",
  name: "sql",
  state: "done",
  summary: "Searched your library",
  detail: "SELECT title FROM books WHERE topic = 'effect'",
  durationMs: 42,
};

const settings: Settings = {
  defaultNumCtx: 16384,
  thinking: true,
  theme: "dark",
  runtimeMode: "system",
  tools: true,
  imageGen: false,
};

const gpu: GpuStatus = {
  vendor: "nvidia",
  name: "RTX 5070 Ti",
  totalBytes: 17_094_934_528,
  freeBytes: 12_884_901_888,
  occupants: [
    { label: "Whisper", bytes: 2_254_857_830, kind: "whisper", protected: true },
    { label: "Media Vault vision", bytes: 1_932_735_283, kind: "other-app", protected: true },
  ],
  systemMemoryAvailableBytes: 17_000_000_000,
  measuredAt: 1_762_500_005_000,
};

const pull: PullProgress = {
  name: "qwen3.5:14b",
  state: "downloading",
  completedBytes: 3_100_000_000,
  totalBytes: 9_000_000_000,
  bytesPerSecond: 48_000_000,
};

const source: Source = {
  id: "s1",
  kind: "sqlite",
  label: "library.db",
  path: "/home/me/library.db",
  addedAt: 1_762_500_006_000,
  snapshotAt: 1_762_500_007_000,
  sizeBytes: 52_428_800,
  state: "ready",
};

const imageReady: ImageStatus = { state: "ready", owner: "external", baseUrl: "http://127.0.0.1:8188" };

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
      message: "qwen3:14b at num_ctx 32768 spills 1.50 GB to system RAM.",
    },
  },
  "chat.send": {
    params: { threadId: "t1", content: "hello", model: "qwen3:14b", numCtx: 16384 },
    result: { turnId: "turn-1", userMessage },
  },
  "chat.cancel": { params: { turnId: "turn-1" }, result: { cancelled: true } },
  "settings.get": { params: {}, result: settings },
  "settings.update": { params: { thinking: false, defaultModel: null }, result: { ...settings, thinking: false } },
  "gpu.status": { params: {}, result: gpu },
  "models.catalog": {
    params: {},
    result: [
      {
        name: "qwen3.5:9b",
        label: "Qwen 3.5 9B",
        purpose: "Fast everyday answers",
        downloadBytes: 6_600_000_000,
        installed: true,
        recommended: true,
      },
    ],
  },
  "models.pull": { params: { name: "qwen3.5:14b" }, result: { ...pull, state: "queued", completedBytes: 0 } },
  "models.cancelPull": { params: { name: "qwen3.5:14b" }, result: { cancelled: true } },
  "models.remove": { params: { name: "gemma3:4b" }, result: { name: "gemma3:4b" } },
  "sources.list": { params: {}, result: [source] },
  "sources.add": { params: { kind: "sqlite", path: "/home/me/library.db" }, result: source },
  "sources.remove": { params: { id: "s1" }, result: { id: "s1" } },
  "sources.refresh": { params: { id: "s1" }, result: source },
  "image.status": { params: {}, result: imageReady },
  "image.generate": { params: { prompt: "a gate at dusk", threadId: "t1" }, result: { jobId: "j1" } },
  "image.cancel": { params: { jobId: "j1" }, result: { cancelled: true } },
};

/** One sample per channel; chat.event gets one per ChatEvent variant. */
export const pushSamples: { readonly [C in Channel]: readonly Payload<C>[] } = {
  "chat.event": [
    { turnId: "turn-1", threadId: "t1", event: { type: "thinking", text: "greet" } },
    { turnId: "turn-1", threadId: "t1", event: { type: "delta", text: "hi " } },
    { turnId: "turn-1", threadId: "t1", event: { type: "done", message: assistantMessage, stopReason: "stop" } },
    { turnId: "turn-1", threadId: "t1", event: { type: "error", code: "runtime-gone", message: "Ollama stopped" } },
    { turnId: "turn-1", threadId: "t1", event: { type: "tool", step: { ...toolStep, state: "running" } } },
    {
      turnId: "turn-1",
      threadId: "t1",
      event: { type: "done", message: { ...assistantMessage, tools: [toolStep], images: ["/tmp/x.png"] }, stopReason: "stop" },
    },
  ],
  "runtime.changed": [runtime, { state: "missing", owner: "none", baseUrl: "http://127.0.0.1:11434", detail: "no answer" }],
  "models.changed": [models, []],
  "threads.changed": [{ threadId: "t1" }],
  "settings.changed": [settings],
  "gpu.changed": [gpu, { vendor: "none", occupants: [], systemMemoryAvailableBytes: 9_000_000_000, measuredAt: 1 }],
  "models.pull": [pull, { name: "qwen3.5:14b", state: "error", completedBytes: 0, message: "no space left" }],
  "sources.changed": [[source], []],
  "image.status": [imageReady, { state: "off", owner: "none" }],
  "image.event": [
    { jobId: "j1", threadId: "t1", state: "running", progress: 0.4 },
    { jobId: "j1", state: "done", imagePath: "/tmp/x.png" },
  ],
};
