// Domain shapes that cross the wire. Every module keeps plain TypeScript
// inside; these Schemas are the boundary check at both ends of the socket.
import { Schema as S } from "effect";

const Millis = S.Finite;
const Count = S.Int.check(S.isGreaterThanOrEqualTo(0));
const PositiveInt = S.Int.check(S.isGreaterThan(0));

export const Thread = S.Struct({
  id: S.String,
  title: S.String,
  createdAt: Millis,
  updatedAt: Millis,
});
export type Thread = typeof Thread.Type;

export const Role = S.Literals(["user", "assistant", "system"]);
export type Role = typeof Role.Type;

export const MessageStats = S.Struct({
  promptTokens: S.optional(Count),
  completionTokens: S.optional(Count),
  durationMs: S.optional(S.Finite),
  numCtx: S.optional(PositiveInt),
});
export type MessageStats = typeof MessageStats.Type;

/** One tool call in a turn, shown as a step row. */
export const ToolStep = S.Struct({
  callId: S.String,
  /** The tool: "read", "sql", "shell", "note" or "image". */
  name: S.String,
  state: S.Literals(["running", "done", "error"]),
  /** Plain words: "Searched your library". */
  summary: S.String,
  /** The call and its trimmed output, for the expanded row. */
  detail: S.optional(S.String),
  durationMs: S.optional(S.Finite),
});
export type ToolStep = typeof ToolStep.Type;

export const Message = S.Struct({
  id: S.String,
  threadId: S.String,
  role: Role,
  content: S.String,
  thinking: S.optional(S.String),
  model: S.optional(S.String),
  createdAt: Millis,
  stats: S.optional(MessageStats),
  /** Tool calls the assistant made in this turn, in order. */
  tools: S.optional(S.Array(ToolStep)),
  /** Images made in this turn, as paths relative to the server's data dir ("images/<jobId>.png"); the server serves them over HTTP. */
  images: S.optional(S.Array(S.String)),
});
export type Message = typeof Message.Type;

export const ModelInfo = S.Struct({
  name: S.String,
  digest: S.String,
  sizeBytes: Count,
  family: S.optional(S.String),
  parameterSize: S.optional(S.String),
  quantization: S.optional(S.String),
  modifiedAt: S.String,
});
export type ModelInfo = typeof ModelInfo.Type;

export const RuntimeState = S.Literals([
  "ready",
  "starting",
  "installing",
  "missing",
  "stopped",
  "wrong-service",
  "error",
]);
export type RuntimeState = typeof RuntimeState.Type;

export const RuntimeOwner = S.Literals(["external", "app", "none"]);
export type RuntimeOwner = typeof RuntimeOwner.Type;

export const RuntimeStatus = S.Struct({
  state: RuntimeState,
  owner: RuntimeOwner,
  baseUrl: S.String,
  version: S.optional(S.String),
  /** Words for people. It can quote another service's reply, so no client parses it. */
  detail: S.optional(S.String),
  /** Ports that something other than Ollama holds, which the detail talks about, in order, once each. */
  busyPorts: S.optional(S.Array(S.String)),
});
export type RuntimeStatus = typeof RuntimeStatus.Type;

export const FitVerdict = S.Literals(["fits", "spills", "refuse"]);
export type FitVerdict = typeof FitVerdict.Type;

export const FitReport = S.Struct({
  model: S.String,
  numCtx: PositiveInt,
  freeVramBytes: Count,
  needVramBytes: Count,
  spillRamBytes: Count,
  verdict: FitVerdict,
  shortfallBytes: S.optional(Count),
  source: S.Literals(["measured", "estimate"]),
  measuredAt: Millis,
  /** One sentence that names the numbers behind the verdict. */
  message: S.optional(S.String),
});
export type FitReport = typeof FitReport.Type;

export const ChatEvent = S.Union([
  S.Struct({ type: S.Literal("delta"), text: S.String }),
  S.Struct({ type: S.Literal("thinking"), text: S.String }),
  // stopReason is Ollama's done_reason: "stop", or "length" when num_ctx or num_predict cut the reply.
  S.Struct({ type: S.Literal("done"), message: Message, stopReason: S.String }),
  S.Struct({ type: S.Literal("error"), code: S.String, message: S.String }),
  // A tool call started, finished or failed; the same callId updates one step row.
  S.Struct({ type: S.Literal("tool"), step: ToolStep }),
]);
export type ChatEvent = typeof ChatEvent.Type;

export const NumCtx = PositiveInt;

// ---------------------------------------------------------------- v2 surface
// Added 2026-11-07 by the coordinator so the client, runtime, harness and
// image lanes build against one table. A method with no handler answers
// "not-implemented"; the client hides or explains what is not built yet.

/** The three context sizes the product offers (16k floor, 32k and 64k where fit allows). */
export const ContextSize = S.Literals([16384, 32768, 65536]);
export type ContextSize = typeof ContextSize.Type;

export const Theme = S.Literals(["dark", "light", "system"]);
export type Theme = typeof Theme.Type;

/** Who runs Ollama: the one already on the system, or the app's own copy. */
export const RuntimeMode = S.Literals(["system", "app"]);
export type RuntimeMode = typeof RuntimeMode.Type;

export const Settings = S.Struct({
  /** Unset means the server picks the fastest installed model that runs on the GPU. */
  defaultModel: S.optional(S.String),
  defaultNumCtx: ContextSize,
  thinking: S.Boolean,
  theme: Theme,
  runtimeMode: RuntimeMode,
  /** Model tool calls (read, sql, shell, note) on or off for new turns. */
  tools: S.Boolean,
  /** Image generation through ComfyUI; off until the user sets it up. */
  imageGen: S.Boolean,
  /** A ComfyUI the user points at; unset means discover the local install. */
  comfyUrl: S.optional(S.String),
});
export type Settings = typeof Settings.Type;

export const SettingsPatch = S.Struct({
  defaultModel: S.optional(S.NullOr(S.String)),
  defaultNumCtx: S.optional(ContextSize),
  thinking: S.optional(S.Boolean),
  theme: S.optional(Theme),
  runtimeMode: S.optional(RuntimeMode),
  tools: S.optional(S.Boolean),
  imageGen: S.optional(S.Boolean),
  comfyUrl: S.optional(S.NullOr(S.String)),
});
export type SettingsPatch = typeof SettingsPatch.Type;

/** What holds GPU memory now. `protected` holders are never stopped by the app (whisper, other apps). */
export const GpuOccupant = S.Struct({
  label: S.String,
  bytes: Count,
  kind: S.Literals(["chat-model", "image", "whisper", "other-app", "unknown"]),
  protected: S.Boolean,
});
export type GpuOccupant = typeof GpuOccupant.Type;

export const GpuStatus = S.Struct({
  /** "none" is a machine with no NVIDIA GPU (models run on the CPU); "unreadable" is nvidia-smi failing. */
  vendor: S.Literals(["nvidia", "none", "unreadable"]),
  name: S.optional(S.String),
  totalBytes: S.optional(Count),
  freeBytes: S.optional(Count),
  occupants: S.Array(GpuOccupant),
  systemMemoryAvailableBytes: Count,
  measuredAt: Millis,
  detail: S.optional(S.String),
});
export type GpuStatus = typeof GpuStatus.Type;

export const PullProgress = S.Struct({
  name: S.String,
  state: S.Literals(["queued", "downloading", "verifying", "done", "error", "cancelled"]),
  completedBytes: Count,
  totalBytes: S.optional(Count),
  bytesPerSecond: S.optional(S.Finite),
  message: S.optional(S.String),
});
export type PullProgress = typeof PullProgress.Type;

/**
 * A model moving into or out of memory. The server pushes "loading" when a
 * turn or a preload starts a model that is not resident, "ready" once it
 * answers, so the client can say "Loading into GPU memory" instead of
 * waiting in silence.
 */
export const ModelLoad = S.Struct({
  model: S.String,
  numCtx: NumCtx,
  state: S.Literals(["loading", "ready", "error", "unloaded"]),
  message: S.optional(S.String),
});
export type ModelLoad = typeof ModelLoad.Type;

/** A model the app recommends or the user can download, with the reason to pick it. */
export const CatalogEntry = S.Struct({
  /** The Ollama tag, e.g. "qwen3.5:9b". */
  name: S.String,
  /** The friendly name, e.g. "Qwen 3.5 9B". */
  label: S.String,
  /** Four words or fewer: why you would pick it ("Fast everyday answers"). */
  purpose: S.String,
  downloadBytes: Count,
  installed: S.Boolean,
  recommended: S.Boolean,
  fit: S.optional(FitReport),
});
export type CatalogEntry = typeof CatalogEntry.Type;

export const SourceKind = S.Literals(["folder", "file", "sqlite"]);
export type SourceKind = typeof SourceKind.Type;

/** A read-only source in the Library. The model reads a snapshot, never the live file. */
export const Source = S.Struct({
  id: S.String,
  kind: SourceKind,
  label: S.String,
  path: S.String,
  addedAt: Millis,
  snapshotAt: S.optional(Millis),
  sizeBytes: S.optional(Count),
  state: S.Literals(["ready", "refreshing", "error"]),
  detail: S.optional(S.String),
});
export type Source = typeof Source.Type;


export const ImageStatus = S.Struct({
  state: S.Literals(["off", "missing", "stopped", "starting", "ready", "busy", "error"]),
  owner: RuntimeOwner,
  baseUrl: S.optional(S.String),
  detail: S.optional(S.String),
});
export type ImageStatus = typeof ImageStatus.Type;

export const ImageEvent = S.Struct({
  jobId: S.String,
  threadId: S.optional(S.String),
  state: S.Literals(["queued", "running", "done", "error", "cancelled"]),
  /** 0 to 1. */
  progress: S.optional(S.Finite),
  /** The finished PNG, relative to the server's data dir ("images/<jobId>.png"). */
  imagePath: S.optional(S.String),
  message: S.optional(S.String),
});
export type ImageEvent = typeof ImageEvent.Type;

// ---------------------------------------------------------------- setup

/** What `setup.probe` reads about this machine before it plans models. */
export const SetupProbe = S.Struct({
  os: S.Struct({ platform: S.String, release: S.String, arch: S.String }),
  cpu: S.Struct({ model: S.String, threads: PositiveInt }),
  memory: S.Struct({ totalBytes: Count, availableBytes: Count }),
  /** The same reading Settings' GPU panel shows; vendor "none" on a machine with no NVIDIA GPU. */
  gpu: GpuStatus,
  /** Free bytes on the disk that holds the app data folder. */
  diskFreeBytes: Count,
  ollama: S.NullOr(
    S.Struct({ baseUrl: S.String, version: S.String, owner: RuntimeOwner, models: S.Array(S.String) }),
  ),
  comfy: S.NullOr(
    S.Struct({
      baseUrl: S.String,
      owner: RuntimeOwner,
      /** Where image weights go; unset when the probe could not find the install folder. */
      modelsDir: S.optional(S.String),
      devices: S.Array(
        S.Struct({
          name: S.String,
          type: S.String,
          vramTotalBytes: S.optional(Count),
          vramFreeBytes: S.optional(Count),
        }),
      ),
    }),
  ),
  probedAt: Millis,
});
export type SetupProbe = typeof SetupProbe.Type;

/** One file the plan needs; `installed` means it is already on this machine. */
export const SetupDownload = S.Struct({ what: S.String, bytes: Count, source: S.String, installed: S.Boolean });
export type SetupDownload = typeof SetupDownload.Type;

/** The models `setup.plan` picks for this machine, and what they cost to get. */
export const SetupPlan = S.Struct({
  text: S.Struct({
    tier: S.String,
    model: S.String,
    numCtx: ContextSize,
    /** Settings.thinking; true only for a model whose /api/show lists "thinking". */
    think: S.Boolean,
    reason: S.String,
  }),
  image: S.Struct({
    tier: S.NullOr(S.String),
    model: S.NullOr(S.String),
    enabled: S.Boolean,
    secondsPerImage: S.optional(S.Finite),
    reason: S.String,
  }),
  downloads: S.Array(SetupDownload),
  totalBytes: Count,
});
export type SetupPlan = typeof SetupPlan.Type;
