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
  /** Wall time for the whole call, load and prompt included. */
  durationMs: S.optional(S.Finite),
  numCtx: S.optional(PositiveInt),
  /** Ollama's eval_duration: decode time only. Speed is completionTokens over this. */
  evalDurationMs: S.optional(S.Finite),
  /** Ollama's prompt_eval_duration: time spent reading the prompt. */
  promptEvalDurationMs: S.optional(S.Finite),
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
  /** URLs from actual tool output, excluding the model's call arguments. */
  links: S.optional(S.Array(S.String)),
});
export type ToolStep = typeof ToolStep.Type;

/** Image jobs are durable messages; events carry the same state as the saved card. */
export const ImageEvent = S.Struct({
  jobId: S.String,
  threadId: S.optional(S.String),
  state: S.Literals(["queued", "running", "done", "error", "cancelled"]),
  progress: S.optional(S.Finite),
  imagePath: S.optional(S.String),
  message: S.optional(S.String),
  errorKind: S.optional(S.String),
  /** One accepted retry per failed attempt; duplicates return this same job. */
  retryJobId: S.optional(S.String),
});
export type ImageEvent = typeof ImageEvent.Type;

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
  imageJob: S.optional(ImageEvent),
});
export type Message = typeof Message.Type;

export const FitVerdict = S.Literals(["fits", "spills", "refuse"]);
export type FitVerdict = typeof FitVerdict.Type;

/** Ollama's capability words from /api/show: completion, embedding, tools, thinking, vision, insert. */
export const ModelCapability = S.String;

/**
 * The model chat starts on, chosen by the server's pick rule
 * (apps/server/src/runtime/pick.ts). It rides on models.list and
 * models.changed so the first render already knows it.
 */
export const ModelPick = S.Struct({
  /** The context size the pick was fitted at: the settings default. */
  numCtx: PositiveInt,
  /** "refuse" means no chat model fits at numCtx; this is the best-ranked one anyway. Absent when the fit check could not run. */
  verdict: S.optional(FitVerdict),
});
export type ModelPick = typeof ModelPick.Type;

export const ModelInfo = S.Struct({
  name: S.String,
  digest: S.String,
  sizeBytes: Count,
  family: S.optional(S.String),
  parameterSize: S.optional(S.String),
  quantization: S.optional(S.String),
  modifiedAt: S.String,
  /** From /api/show, cached by digest. A model without "completion" cannot chat. */
  capabilities: S.Array(ModelCapability),
  /** The most context this model takes, from /api/show; the safe fallback when it does not say. */
  maxContext: S.optional(PositiveInt),
  /** Set on exactly one model, the one chat starts on, when any installed model can chat. */
  pick: S.optional(ModelPick),
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
  /** True where the app has no build of Ollama to install and no copy to run (Windows ARM today), so no client offers one. */
  noAppCopy: S.optional(S.Boolean),
});
export type RuntimeStatus = typeof RuntimeStatus.Type;

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
  /** Set when the refusal is the model's own context ceiling, not memory: the most it supports. */
});
export type FitReport = typeof FitReport.Type;

export const ChatEvent = S.Union([
  // The turn began: its model and saved user message, so a client that did not send it
  // (the same thread open elsewhere) can stream the reply too. Added 2026-11-07 (PH-02).
  S.Struct({ type: S.Literal("start"), model: S.String, userMessage: Message }),
  S.Struct({ type: S.Literal("delta"), text: S.String }),
  S.Struct({ type: S.Literal("thinking"), text: S.String }),
  // stopReason is Ollama's done_reason: "stop", or "length" when num_ctx or num_predict cut the reply.
  S.Struct({ type: S.Literal("done"), message: Message, stopReason: S.String }),
  S.Struct({
    type: S.Literal("error"),
    code: S.String,
    message: S.String,
    /**
     * code "runtime-changed" or "preempted": the reply streamed so far (exactly the delta and
     * thinking text sent), saved to the thread as a stopped reply. Absent when nothing was sent.
     */
    partial: S.optional(Message),
    /** code "preempted": the model whose load needed the GPU this turn's model held. */
    neededBy: S.optional(S.String),
  }),
  // A tool call started, finished or failed; the same callId updates one step row.
  S.Struct({ type: S.Literal("tool"), step: ToolStep }),
]);
export type ChatEvent = typeof ChatEvent.Type;

/** A running turn a load would have to stop (turns.blocking). */
export const BlockingTurn = S.Struct({
  threadId: S.String,
  title: S.String,
  model: S.String,
  /** Which turn this is, for chat.send's stopTurns: a thread can be running a different turn by the time the person answers. */
  turnId: S.optional(S.String),
});
export type BlockingTurn = typeof BlockingTurn.Type;

export const NumCtx = PositiveInt;

// ---------------------------------------------------------------- v2 surface
// Added 2026-11-07 by the coordinator so the client, runtime, harness and
// image lanes build against one table. A method with no handler answers
// "not-implemented"; the client hides or explains what is not built yet.

/** The context sizes the product offers; a model runs at the most it takes when that is less. */
export const ContextSize = S.Literals([8192, 16384, 32768, 65536]);
export type ContextSize = typeof ContextSize.Type;

export const Theme = S.Literals(["dark", "light", "system"]);
export type Theme = typeof Theme.Type;

/** Who runs Ollama: the one already on the system, or the app's own copy. */
export const RuntimeMode = S.Literals(["system", "app"]);
export type RuntimeMode = typeof RuntimeMode.Type;

/** How large messages and the message box are drawn. */
export const TextSize = S.Literals(["small", "default", "large"]);
export type TextSize = typeof TextSize.Type;

/** Product limits, shared by update validation, numeric inputs and legacy-value normalization. */
export const MODEL_CONTROL_BOUNDS = {
  temperature: { min: 0, max: 5, integer: false },
  top_p: { min: 0, max: 1, integer: false },
  top_k: { min: 0, max: 262144, integer: true },
  repeat_penalty: { min: 0, max: 10, integer: false },
  seed: { min: -1, max: 2147483647, integer: true },
  num_predict: { min: 1, max: 65536, integer: true },
  keep_alive: { min: 0, max: 604800, integer: false },
} as const;
export type ModelControl = keyof typeof MODEL_CONTROL_BOUNDS;
const decimalControl = (key: ModelControl) => S.Finite.check(S.isBetween({ minimum: MODEL_CONTROL_BOUNDS[key].min, maximum: MODEL_CONTROL_BOUNDS[key].max }));
const integerControl = (key: ModelControl) => S.Int.check(S.isBetween({ minimum: MODEL_CONTROL_BOUNDS[key].min, maximum: MODEL_CONTROL_BOUNDS[key].max }));
const ReplyLimit = S.Union([S.Literals([-2, -1]), integerControl("num_predict")]);
const KeepAlive = S.Union([S.Literals([-1]), decimalControl("keep_alive")]);

/** Only supported generation overrides. Omitted fields inherit the installed model/Ollama default. */
export const ModelSettings = S.Struct({
  /** Unset inherits the global prompt; an empty string explicitly uses no user/model prompt. */
  systemPrompt: S.optional(S.String),
  temperature: S.optional(decimalControl("temperature")),
  top_p: S.optional(decimalControl("top_p")),
  top_k: S.optional(integerControl("top_k")),
  repeat_penalty: S.optional(decimalControl("repeat_penalty")),
  seed: S.optional(integerControl("seed")),
  /** -1: no reply limit; -2: fill context; positive: maximum reply tokens. */
  num_predict: S.optional(ReplyLimit),
  /** Seconds after a reply; 0 unloads, -1 keeps loaded. Unset inherits Ollama's default. */
  keep_alive: S.optional(KeepAlive),
});
export type ModelSettings = typeof ModelSettings.Type;

/** null resets one field. A null patch resets this model's entire entry. */
export const ModelSettingsPatch = S.Struct({
  systemPrompt: S.optional(S.NullOr(S.String)),
  temperature: S.optional(S.NullOr(decimalControl("temperature"))),
  top_p: S.optional(S.NullOr(decimalControl("top_p"))),
  top_k: S.optional(S.NullOr(integerControl("top_k"))),
  repeat_penalty: S.optional(S.NullOr(decimalControl("repeat_penalty"))),
  seed: S.optional(S.NullOr(integerControl("seed"))),
  num_predict: S.optional(S.NullOr(ReplyLimit)),
  keep_alive: S.optional(S.NullOr(KeepAlive)),
});
export type ModelSettingsPatch = typeof ModelSettingsPatch.Type;

/** Raw, read-only /api/show fields. Unreported values stay empty, never invented defaults. */
export const ModelDefaults = S.Struct({ system: S.String, parameters: S.String });
export type ModelDefaults = typeof ModelDefaults.Type;

export const Settings = S.Struct({
  /** Unset means the server picks: the best installed chat model that fits at defaultNumCtx (apps/server/src/runtime/pick.ts). */
  defaultModel: S.optional(S.String),
  defaultNumCtx: ContextSize,
  thinking: S.Boolean,
  theme: Theme,
  runtimeMode: RuntimeMode,
  /** Model tool calls (read, sql, shell) on or off for new turns. The image tool has its own switch, imageGen. */
  tools: S.Boolean,
  /** Image generation through ComfyUI; off until the user sets it up. */
  imageGen: S.Boolean,
  /** A ComfyUI the user points at; unset means discover the local install. */
  comfyUrl: S.optional(S.String),
  /** Updates take every change on the main branch, not only releases. Unset means off. */
  updateEveryChange: S.optional(S.Boolean),
  /** Unset means "default". */
  textSize: S.optional(TextSize),
  /** Unset uses the installed model's system prompt. */
  systemPrompt: S.optional(S.String),
  modelSettings: S.optional(S.Record(S.String, ModelSettings)),
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
  updateEveryChange: S.optional(S.Boolean),
  textSize: S.optional(TextSize),
  systemPrompt: S.optional(S.NullOr(S.String)),
  /** Reset all model overrides in one atomic settings update. Individual edits use settings.model.update. */
  modelSettings: S.optional(S.Null),
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

// ---------------------------------------------------------------- updates (2026-11-07)

/** The version this copy runs, read from the clone's .git folder (no git process, no network). */
export const UpdateVersion = S.Union([
  // date: the commit's date, when the .git folder could be read for it.
  S.Struct({ kind: S.Literal("release"), tag: S.String, commit: S.String, date: S.optional(Millis) }),
  S.Struct({ kind: S.Literal("commit"), commit: S.String, date: S.optional(Millis) }),
  S.Struct({ kind: S.Literal("not-a-clone") }),
  S.Struct({ kind: S.Literal("unreadable"), detail: S.String }),
]);
export type UpdateVersion = typeof UpdateVersion.Type;

/** main: every change on the branch. release: the newest v1.2.3 tag. */
export const UpdateChannel = S.Literals(["main", "release"]);
export type UpdateChannel = typeof UpdateChannel.Type;

/** Why a check could not say whether there is an update. */
export const UpdateBlocked = S.Literals(["no-git", "not-a-clone", "no-upstream", "local-changes", "remote", "local-commits", "no-releases", "diverged", "unfinished", "error"]);
export type UpdateBlocked = typeof UpdateBlocked.Type;

/** One click of "Check for updates": fetches from the clone's remote, changes nothing. */
export const UpdateCheck = S.Union([
  S.Struct({ state: S.Literal("up-to-date"), checkedAt: Millis, channel: UpdateChannel, current: S.String }),
  S.Struct({
    state: S.Literal("available"),
    checkedAt: Millis,
    channel: UpdateChannel,
    current: S.String,
    target: S.String,
    /** Every commit between current and target. */
    total: Count,
    /** Commit subjects, newest first, at most 20. */
    changes: S.Array(S.String),
    /** A release's tag message, shown instead of the subjects when there is one. */
    notes: S.optional(S.String),
  }),
  /** lines: what happened, then what to do, in plain words. */
  S.Struct({ state: S.Literal("cannot-check"), checkedAt: Millis, reason: UpdateBlocked, lines: S.Array(S.String) }),
]);
export type UpdateCheck = typeof UpdateCheck.Type;

/** The last update run, shown once on the next start. */
export const UpdateResult = S.Struct({
  at: Millis,
  outcome: S.Literals(["updated", "stopped", "rollback-failed", "refused"]),
  /** "Updated to v0.2.0, 12 changes." or the stopped-at line. */
  line: S.String,
  logPath: S.optional(S.String),
  /** rollback-failed: the commands that finish going back, run in the clone. */
  commands: S.optional(S.Array(S.String)),
});
export type UpdateResult = typeof UpdateResult.Type;

export const UpdateStatus = S.Struct({
  version: UpdateVersion,
  /** Present until update.dismissResult. */
  result: S.NullOr(UpdateResult),
  /** The last check since the server started; null until someone clicks Check. */
  lastCheck: S.NullOr(UpdateCheck),
});
export type UpdateStatus = typeof UpdateStatus.Type;
