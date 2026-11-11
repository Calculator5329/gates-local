// Sample values for every method and push channel. The mapped types make
// a new method or channel without a sample a type error, so round-trip
// tests that walk these tables cover every channel by construction.
import type { Channel, MethodName, Params, Payload, ResultOf } from "./protocol.ts";
import type {
  FitTable,
  GpuStatus,
  ImageStatus,
  Message,
  ModelInfo,
  PullProgress,
  RuntimeStatus,
  Settings,
  SetupPlan,
  SetupProbe,
  Source,
  Thread,
  ToolStep,
} from "./shapes.ts";

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
  stats: { promptTokens: 12, completionTokens: 4, durationMs: 812.5, numCtx: 16384, evalDurationMs: 240.2, promptEvalDurationMs: 61.4 },
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
    capabilities: ["completion", "tools", "thinking"],
  },
  {
    name: "gemma3:4b",
    digest: "sha256:def",
    sizeBytes: 3_300_000_000,
    modifiedAt: "2026-10-01T10:00:00Z",
    capabilities: ["completion", "vision"],
    pick: { numCtx: 16384, verdict: "fits" },
  },
  {
    name: "nomic-embed-text:latest",
    digest: "sha256:0a1",
    sizeBytes: 274_302_450,
    family: "nomic-bert",
    modifiedAt: "2026-10-02T10:00:00Z",
    capabilities: ["embedding"],
  },
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

const fitTable: FitTable = {
  reading: { boot: "sample-process", seq: 3, measuredAt: 1_762_500_005_000 },
  memory: { kind: "gpu", freeBytes: 12_884_901_888, usableBytes: 12_348_030_976 },
  rows: [
    { model: "qwen3:14b", numCtx: 16384, freeVramBytes: 12_884_901_888, needVramBytes: 11_200_000_000, spillRamBytes: 0, verdict: "fits", source: "estimate", stops: [], message: "qwen3:14b at num_ctx 16384 needs 11.2 GB (estimate): fits." },
    { model: "qwen3:14b", numCtx: 32768, freeVramBytes: 11_000_000_000, needVramBytes: 12_500_000_000, spillRamBytes: 1_500_000_000, verdict: "spills", source: "estimate", stops: [] },
    { model: "qwen3.5:9b", numCtx: 65536, freeVramBytes: 4_000_000_000, needVramBytes: 9_000_000_000, spillRamBytes: 0, verdict: "refuse", shortfallBytes: 500_000_000, source: "measured", stops: ["gemma3:4b"] },
  ],
};

const probe: SetupProbe = {
  os: { platform: "linux", release: "7.2.9", arch: "x64" },
  cpu: { model: "AMD Ryzen 7 7800X3D", threads: 16 },
  memory: { totalBytes: 33_000_000_000, availableBytes: 17_000_000_000 },
  gpu,
  diskFreeBytes: 400_000_000_000,
  ollama: { baseUrl: "http://127.0.0.1:11434", version: "0.13.0", owner: "external", models: ["qwen3.5:9b"] },
  comfy: {
    baseUrl: "http://127.0.0.1:8188",
    owner: "external",
    modelsDir: "/home/me/ComfyUI/models",
    devices: [{ name: "cuda:0 RTX 5070 Ti", type: "cuda", vramTotalBytes: 17_094_934_528, vramFreeBytes: 10_000_000_000 }],
  },
  probedAt: 1_762_500_006_000,
};

const plan: SetupPlan = {
  text: { tier: "nvidia-16gb", model: "qwen3.5:9b", numCtx: 32768, think: true, reason: "Fits 9.7 GB free with room for 32k" },
  image: { tier: "nvidia-16gb", model: "sdxl-lightning-4step", enabled: true, secondsPerImage: 4, reason: "Fits beside the text model when it unloads" },
  downloads: [
    { what: "qwen3.5:9b", bytes: 6_600_000_000, source: "ollama", installed: true },
    { what: "sdxl_lightning_4step.safetensors", bytes: 6_940_000_000, source: "https://huggingface.co/ByteDance/SDXL-Lightning", installed: false },
  ],
  totalBytes: 6_940_000_000,
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
  "sync.negotiate": { params: { ordered: [] }, result: { epoch: "sample-process", ordered: [] } },
  "voice.check": { params: { url: "http://127.0.0.1:18078" }, result: { ready: true } },
  "voice.transcribe": { params: { id: "v1", audio: "UklGRg==" }, result: { text: "spoken words" } },
  "voice.cancel": { params: { id: "v1" }, result: {} },
  "threads.list": { params: {}, result: [thread] },
  "threads.create": { params: { title: "First" }, result: thread },
  "threads.get": { params: { threadId: "t1" }, result: { thread, messages: [userMessage, assistantMessage] } },
  "threads.rename": { params: { threadId: "t1", title: "Renamed" }, result: { ...thread, title: "Renamed" } },
  "threads.delete": { params: { threadId: "t1" }, result: { threadId: "t1" } },
  "models.list": { params: {}, result: models },
  "models.refresh": { params: {}, result: models },
  "runtime.status": { params: {}, result: runtime },
  "runtime.retry": { params: {}, result: runtime },
  "runtime.discover": { params: {}, result: runtime },
  "fit.table": { params: {}, result: fitTable },
  "chat.send": {
    params: { threadId: "t1", content: "hello", model: "qwen3:14b", numCtx: 16384 },
    result: { turnId: "turn-1", userMessage },
  },
  "chat.cancel": { params: { turnId: "turn-1" }, result: { cancelled: true } },
  "turns.active": { params: {}, result: [] },

  "messages.delete": { params: { threadId: "t1", messageId: "m1" }, result: { messageId: "m1" } },
  "turns.blocking": { params: { model: "qwen3:14b", numCtx: 16384 }, result: [{ threadId: "t1", title: "First", model: "qwen3.5:9b" }] },
  "settings.get": { params: {}, result: settings },
  "settings.update": { params: { thinking: false, defaultModel: null }, result: { ...settings, thinking: false } },
  "settings.model.update": { params: { model: "qwen3.5:9b", patch: { temperature: 0.6 } }, result: { ...settings, modelSettings: { "qwen3.5:9b": { temperature: 0.6 } } } },
  "settings.modelDefaults": { params: { model: "qwen3.5:9b" }, result: { system: "", parameters: "temperature 0.8" } },
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
  "models.pulls": { params: {}, result: [] },
  "models.remove": { params: { name: "gemma3:4b" }, result: { name: "gemma3:4b" } },
  "models.load": { params: { model: "qwen3.5:9b", numCtx: 16384 }, result: { model: "qwen3.5:9b", numCtx: 16384, state: "ready" } },
  // None measured by default, so a client test that does not ask about speed sees none.
  "models.speed": { params: {}, result: [] },
  "sources.list": { params: {}, result: [source] },
  "sources.add": { params: { kind: "sqlite", path: "/home/me/library.db" }, result: source },
  "sources.remove": { params: { id: "s1" }, result: { id: "s1" } },
  "sources.refresh": { params: { id: "s1" }, result: source },
  "sources.imports": { params: {}, result: { samples: [], jobs: [] } },
  "sources.downloadSample": { params: { id: "chinook" }, result: { id: "i1", key: "chinook", label: "Chinook", kind: "sample", state: "downloading", bytes: 0 } },
  "sources.clone": { params: { url: "https://github.com/example/docs" }, result: { id: "i2", key: "https://github.com/example/docs", label: "example/docs", kind: "repository", state: "cloning", bytes: 0 } },
  "sources.cancelImport": { params: { id: "i1" }, result: { cancelled: true } },
  "image.status": { params: {}, result: imageReady },
  "image.presets": {
    params: {},
    result: {
      presets: [{ id: "sdxl-lightning-pixel", name: "SDXL Lightning pixel art", family: "sdxl", measured: false, sizes: [{ width: 768, height: 512, bytes: 9_663_676_416 }] }],
      readAt: 1_762_500_006_000,
      current: { preset: { id: "sdxl-lightning-pixel", name: "SDXL Lightning pixel art", family: "sdxl", measured: false, sizes: [{ width: 768, height: 512, bytes: 9_663_676_416 }] }, width: 768, height: 512 },
    },
  },
  "image.generate": { params: { prompt: "a gate at dusk", threadId: "t1" }, result: { jobId: "j1" } },
  "image.cancel": { params: { jobId: "j1" }, result: { cancelled: true } },
  "setup.probe": { params: {}, result: probe },
  "setup.plan": {
    params: { images: false },
    result: {
      ...plan,
      image: { tier: null, model: null, enabled: false, reason: "Images are off until you ask" },
      downloads: plan.downloads.slice(0, 1),
      totalBytes: 0,
    },
  },
  "update.status": {
    params: {},
    result: {
      version: { kind: "release", tag: "v0.1.0", commit: "85507ce", date: 1_762_500_000_000 },
      result: { at: 1_762_500_005_000, outcome: "updated", line: "Updated to v0.1.0, 12 changes." },
      lastCheck: null,
    },
  },
  "update.prepare": { params: { approval: "approval-1" }, result: { state: "ready", reservation: "reservation-1", targetCommit: "b".repeat(40) } },
  "update.commit": { params: { reservation: "reservation-1", targetCommit: "b".repeat(40), release: "main-release-1" }, result: { accepted: true, release: "main-release-1" } },
  "update.cancel": { params: { reservation: "reservation-1" }, result: { cancelled: true } },
  "update.check": {
    params: {},
    result: {
      state: "available",
      checkedAt: 1_762_500_006_000,
      channel: "release",
      current: "v0.1.0",
      target: "v0.2.0",
      total: 23,
      changes: ["Settings: an Updates group", "Fix the model picker on phones"],
    },
  },
  "update.dismissResult": { params: {}, result: { dismissed: true } },
  "update.download": {
    params: {},
    result: {
      state: "newer",
      checkedAt: 1_762_500_006_000,
      current: "1.2.3",
      target: "1.3.0",
      forThisCopy: true,
      lines: ["Downloading version 1.3.0 (0 of 98 MB). You can keep chatting."],
      page: "https://example.invalid/releases/latest",
      download: "downloading",
    },
  },
  "usage.read": {
    params: { since: 0 },
    result: { rows: [{ hour: 1_762_506_000_000, model: "qwen3:14b", promptTokens: 1200, completionTokens: 340, replies: 2, decodeMs: 6800, decodeTokens: 340, readMs: 410, readTokens: 1200, wallMs: 7600 }], models: ["qwen3:14b"] },
  },
};

/** One sample per channel; chat.event gets one per ChatEvent variant. */
export const pushSamples: { readonly [C in Channel]: readonly Payload<C>[] } = {
  "chat.event": [
    { turnId: "turn-1", threadId: "t1", event: { type: "start", model: "qwen3:14b", userMessage } },
    { turnId: "turn-1", threadId: "t1", event: { type: "thinking", text: "greet" } },
    { turnId: "turn-1", threadId: "t1", event: { type: "delta", text: "hi " } },
    { turnId: "turn-1", threadId: "t1", event: { type: "done", message: assistantMessage, stopReason: "stop" } },
    { turnId: "turn-1", threadId: "t1", event: { type: "error", code: "runtime-gone", message: "Ollama stopped" } },
    {
      turnId: "turn-1",
      threadId: "t1",
      event: { type: "error", code: "preempted", message: "qwen3:14b needed the GPU this reply was using, so it stopped.", partial: assistantMessage, neededBy: "qwen3:14b" },
    },
    { turnId: "turn-1", threadId: "t1", event: { type: "tool", step: { ...toolStep, state: "running" } } },
    {
      turnId: "turn-1",
      threadId: "t1",
      event: { type: "done", message: { ...assistantMessage, tools: [toolStep], images: ["images/j1.png"] }, stopReason: "stop" },
    },
  ],
  "runtime.changed": [runtime, { state: "missing", owner: "none", baseUrl: "http://127.0.0.1:11434", detail: "no answer" }],
  "models.changed": [models, []],
  "threads.changed": [{ threadId: "t1" }],
  "settings.changed": [settings],
  "gpu.changed": [gpu, { vendor: "none", occupants: [], systemMemoryAvailableBytes: 9_000_000_000, measuredAt: 1 }],
  "fit.changed": [fitTable, { reading: { boot: "sample-process", seq: 4, measuredAt: 1 }, memory: { kind: "cpu" }, rows: [] }],
  "models.pull": [pull, { name: "qwen3.5:14b", state: "error", completedBytes: 0, message: "no space left" }],
  "update.changed": [methodSamples["update.status"].result],
  "models.load": [
    { model: "qwen3.5:9b", numCtx: 16384, state: "loading" },
    { model: "qwen3.5:9b", numCtx: 32768, state: "error", message: "Not enough memory at 32k" },
  ],
  "models.speed": [[{ model: "qwen3.5:9b", tokensPerSecond: 101.6, replies: 8 }, { model: "gemma3:4b", tokensPerSecond: 8.4, replies: 1 }], []],
  "sources.changed": [[source], []],
  "sources.imports": [{ samples: [], jobs: [] }],
  "image.status": [imageReady, { state: "off", owner: "none" }],
  "image.event": [
    { jobId: "j1", threadId: "t1", state: "running", progress: 0.4 },
    { jobId: "j1", state: "done", imagePath: "images/j1.png" },
  ],
  "usage.changed": [{}],
};
