// Domain shapes that cross the wire. Every module keeps plain TypeScript
// inside; these Schemas are the boundary check at both ends of the socket.
import * as S from "effect/Schema";

const Millis = S.Finite;
const Count = S.Int.check(S.isGreaterThanOrEqualTo(0));
const PositiveInt = S.Int.check(S.isGreaterThan(0));

/** An image preset (the server's table, image.presets) and one of its sizes: what an image job runs. */
export const ImageChoice = S.Struct({
  preset: S.String.check(S.isMaxLength(100)),
  width: S.Int.check(S.isGreaterThan(0)),
  height: S.Int.check(S.isGreaterThan(0)),
});
export type ImageChoice = typeof ImageChoice.Type;

/** How many pictures one Image-mode send makes, one after another. */
export const IMAGE_COUNT_MAX = 4;
export const ImageCount = S.Int.check(S.isBetween({ minimum: 1, maximum: IMAGE_COUNT_MAX }));
export type ImageCount = typeof ImageCount.Type;

/** One picture of a send that makes several: they share `id`, and this is number `index` (from 0) of `of`. */
export const ImageGroup = S.Struct({
  id: S.String.check(S.isMaxLength(200)),
  index: S.Int.check(S.isBetween({ minimum: 0, maximum: IMAGE_COUNT_MAX - 1 })),
  of: ImageCount,
});
export type ImageGroup = typeof ImageGroup.Type;

export const Thread = S.Struct({
  id: S.String,
  title: S.String,
  createdAt: Millis,
  updatedAt: Millis,
  /** The image model and size this thread sends with (threads.setImageChoice, or its last image send); absent follows Settings' imageChoice. */
  imageChoice: S.optional(ImageChoice),
  /** How many pictures an Image-mode send in this thread makes (threads.setImageCount, or its last image send); absent is 1. */
  imageCount: S.optional(ImageCount),
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
  /**
   * With state "error": the person's Stop (or a halt) cut the call short, it did not fail. A field, not a
   * fourth state, so a build that knows three states still reads the step (as failed). Never false.
   */
  stopped: S.optional(S.Literal(true)),
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
  /** Running, and still freeing GPU memory (unloading this app's chat models and waiting for the memory). Absent once that step ends. */
  phase: S.optional(S.Literals(["freeing"])),
  /**
   * Running: what ComfyUI said it is doing, only as it reported it. "queued": taken, not begun;
   * "loading": a loader node ran (a model read from disk, so a cold first run); "encoding": the
   * prompt's text encoder; "sampling" with `steps`; "decoding": the VAE. Absent: nothing reported yet.
   */
  stage: S.optional(S.Literals(["queued", "loading", "encoding", "sampling", "decoding"])),
  /** Sampling: the step ComfyUI reported and of how many. */
  steps: S.optional(S.Struct({ done: S.Int, total: S.Int })),
  progress: S.optional(S.Finite),
  imagePath: S.optional(S.String),
  message: S.optional(S.String),
  errorKind: S.optional(S.String),
  /** One accepted retry per failed attempt; duplicates return this same job. */
  retryJobId: S.optional(S.String),
  /** The preset and size the job runs; a retry runs the same. Absent on cards saved before presets. */
  choice: S.optional(ImageChoice),
  /** The choice the card was first drawn with, when the job settled to another (an unset default passed over for the files ComfyUI has). The card's box keeps this shape. */
  sent: S.optional(ImageChoice),
  /** One of several pictures from one Image-mode send; they show as tiles of one card. Absent: a picture of its own. */
  group: S.optional(ImageGroup),
  /** Done: ComfyUI's time making the picture. Absent on cards saved before it was kept. */
  runMs: S.optional(Count),
});
export type ImageEvent = typeof ImageEvent.Type;

/**
 * How a turn ended, as the server decided it (chat row 32): done; stopped by a person's Stop
 * (chat.cancel), or by deleting its question; preempted, the server stopping it to make way for
 * something (another model's load, a runtime change, the app closing); or failed. `at` is when it
 * ended: for a Stop, when the cancel came. Rides on the one terminal event, done or error.
 */
export const TurnEnded = S.Struct({
  reason: S.Literals(["done", "stopped", "preempted", "failed"]),
  at: Millis,
});
export type TurnEnded = typeof TurnEnded.Type;

/**
 * A reply's times, stamped by the server from the events it sent (chat row 32), so every window
 * and every reload shows the same seconds. Absent on rows saved before 2026-11-14 and on pictures.
 */
export const ReplyTimes = S.Struct({
  /** When chat.send took the turn. */
  startedAt: Millis,
  /** The first word of the answer. */
  firstTokenAt: S.optional(Millis),
  /**
   * "Thought for": from the model being ready (the start, or the first token of a cold load) to
   * the first word of the answer, or to the end of a reply that never answered. Only with thinking.
   */
  thoughtMs: S.optional(Count),
  /** Each closed span of thinking: where its words start in the thinking, and how long it ran. */
  spans: S.Array(S.Struct({ from: Count, ms: Count })),
  /** The thinking's length when each call first arrived: where the call came in the thinking. */
  callsAt: S.Record(S.String, Count),
  /**
   * The reply's work: its thinking plus its tool calls, never its load or its writing (the one
   * clock every window shows). Absent on rows saved before 2026-11-14.
   */
  workMs: S.optional(Count),
  ended: TurnEnded,
  /** Preempted or failed: the error the turn ended with, for the note under it. */
  why: S.optional(S.Struct({ code: S.String, message: S.String, neededBy: S.optional(S.String) })),
});
export type ReplyTimes = typeof ReplyTimes.Type;

/**
 * What a running reply is doing: waiting for the GPU or the load gate, loading its model,
 * thinking (from the model being ready, also while it reads a call's result), running a call,
 * writing its answer, or ended.
 */
export const ReplyStage = S.Literals(["waiting", "loading", "thinking", "tool", "writing", "ended"]);
export type ReplyStage = typeof ReplyStage.Type;

/**
 * A running reply as the server keeps it (decision 33): one record per turn, pushed to every
 * window at each change, and the only thing a window draws the live line from. Its times are
 * the server's; `workMs` is as of the push, and grows on the window's own clock only while the
 * stage is thinking or tool. The saved row's ReplyTimes are this record at the end.
 */
export const ReplyRecord = S.Struct({
  stage: ReplyStage,
  startedAt: Millis,
  /** The model is ready for this reply: at the start of a warm turn, at the first token or call of a cold one. */
  readyAt: S.optional(Millis),
  firstTokenAt: S.optional(Millis),
  /** Thinking plus tool time so far, as of the push. */
  workMs: Count,
  /** Tool time so far, as of the push. */
  toolMs: Count,
  /** 1, then 2 while the server runs a failed reply again (it does so once). */
  attempt: PositiveInt,
  /** The closed thinking spans and where each call came, for the fold's rounds; as on ReplyTimes. */
  spans: S.Array(S.Struct({ from: Count, ms: Count })),
  callsAt: S.Record(S.String, Count),
  ended: S.optional(TurnEnded),
});
export type ReplyRecord = typeof ReplyRecord.Type;

/**
 * A non-image file attached to a message: the server's own copy in its data folder. The model
 * never gets its contents in the prompt, only a line naming it; with tools on it reads the copy
 * through the read tool, by its label, in this thread's turns only.
 */
export const AttachedFile = S.Struct({
  /** Relative to the server data dir, `files/att-<uuid>`: a generated name, never the person's file name. */
  path: S.String.check(S.isPattern(/^files\/att-[a-f0-9-]{36}$/)),
  /** The original file name: the chip shows it and the model reads the file by it. */
  name: S.String.check(S.isMinLength(1), S.isMaxLength(255)),
  size: Count,
  /** The browser's type for it, or "" when it gave none. */
  type: S.String.check(S.isMaxLength(200)),
});
export type AttachedFile = typeof AttachedFile.Type;

export const Message = S.Struct({
  /** Rows saved before 2026-11-13 may say that earlier images were left out; nothing shows it or writes it now. */
  contextNotice: S.optional(S.String),
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
  /** Attached user images or generated assistant images, relative to the server data dir; served over authenticated HTTP. */
  images: S.optional(S.Array(S.String)),
  /** Files the person attached to this message (AttachedFile). Absent when none. */
  files: S.optional(S.Array(AttachedFile)),
  /** Saved unfinished assistant text, not a completed answer. Absent on older messages. */
  interrupted: S.optional(S.Literal(true)),
  imageJob: S.optional(ImageEvent),
  /**
   * An assistant reply: its times. A question whose turn ended with no reply saved (stopped or
   * failed before any words): how that turn ended, with no spans.
   */
  times: S.optional(ReplyTimes),
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

/**
 * A model's measured speed on this computer: completion tokens over decode time,
 * summed over its finished replies of the last 14 days. Never an estimate; a model
 * without enough measured replies has no entry.
 */
export const ModelSpeed = S.Struct({
  /** The model name without ":latest", so either spelling matches. */
  model: S.String,
  tokensPerSecond: S.Finite.check(S.isGreaterThan(0)),
  /** How many replies the number covers. */
  replies: PositiveInt,
});
export type ModelSpeed = typeof ModelSpeed.Type;

/** The parts a Measure score is made of (version 2); each has its own count and weight. */
export const MeasurePart = S.Literals(["tools", "files", "database", "instructions", "pages"]);
export type MeasurePart = typeof MeasurePart.Type;

/** One thing the window does to a page a model wrote (Measure's Pages part), by CSS selector. */
export const PageAction = S.Union([
  S.Struct({ do: S.Literal("click"), target: S.String }),
  /** Sets an input's value and sends input, keyup and change events. */
  S.Struct({ do: S.Literal("fill"), target: S.String, text: S.String }),
  /** Notes the element's value or text. */
  S.Struct({ do: S.Literal("read"), target: S.String }),
  /** Notes the text of every matching element that is shown, joined by "|". */
  S.Struct({ do: S.Literal("visible"), target: S.String }),
]);
export type PageAction = typeof PageAction.Type;

/**
 * One check of a Measure run. A measure saved before version 2 has only id, kind ("tools" or
 * "sql"), ok, and maybe reply and result.
 */
export const MeasureCheck = S.Struct({
  id: S.String,
  /** The part it counts toward; "sql" is a database question of a measure saved before version 2. */
  kind: S.Literals(["tools", "sql", "files", "database", "instructions", "pages"]),
  ok: S.Boolean,
  /** What the model's answer said: its head and its tail when it is long. */
  reply: S.optional(S.String),
  /** Before version 2: a database question's first row, or why its query did not run. Pages: what the window saw. */
  result: S.optional(S.String),
  /** pending: a page waiting for the app's window to run it. skipped: it could not run on this computer. Neither counts. */
  state: S.optional(S.Literals(["pending", "skipped"])),
  /** What a pass needs, in a few words. */
  needs: S.optional(S.String),
  /** Why it failed or was skipped. */
  why: S.optional(S.String),
  /** Each tool call and what came back, cut short. */
  calls: S.optional(S.Array(S.String)),
  /** Tokens the model wrote for it, thinking included, over all its requests. */
  tokens: S.optional(S.Int),
  /** Its tokens reached the check's budget, and the reply was cut there. */
  cut: S.optional(S.Boolean),
  ms: S.optional(S.Finite),
  /** Pages: the page the model wrote, and what the window does to it. */
  page: S.optional(S.String),
  script: S.optional(S.Array(PageAction)),
});
export type MeasureCheck = typeof MeasureCheck.Type;

/** A part's count: checks passed of the ones that ran, and its weight in the score. */
export const MeasurePartCount = S.Struct({ part: MeasurePart, passed: S.Int, total: S.Int, weight: S.Int });
export type MeasurePartCount = typeof MeasurePartCount.Type;

/**
 * A model measured on this computer when the person asked (Settings › Models, Measure): its
 * reply speed and the share of checks it passed. Kept per model and digest, so a re-pulled
 * model with new weights is measured again. Without `version` it is an older measure of eight
 * single-shot checks, kept readable until the model is measured again.
 */
export const ModelMeasure = S.Struct({
  model: S.String,
  digest: S.String,
  /** When it was measured, ms since 1970. */
  at: S.Finite,
  /** 2: the checks ran through the chat's own loop and tools, in parts. */
  version: S.optional(S.Literal(2)),
  /** The window the checks ran at: version 2 uses the one a chat with this model uses. */
  numCtx: S.Int,
  /** Version 2: whether the model thought, as a chat with it does. */
  think: S.optional(S.Boolean),
  /** Decode speed: version 2 sums every request of the run. */
  tokensPerSecond: S.Finite.check(S.isGreaterThanOrEqualTo(0)),
  /** Version 2: the median wait from a request to its first token. */
  firstTokenMs: S.optional(S.Finite),
  /** Version 2: too slow to use here, and which number says so. Never part of the score. */
  slow: S.optional(S.Literals(["decode", "first-token"])),
  /** Version 2: 0 to 100, each part's share of passes times its weight. Before: passed of 8. */
  score: S.Int.check(S.isBetween({ minimum: 0, maximum: 100 })),
  parts: S.optional(S.Array(MeasurePartCount)),
  checks: S.Array(MeasureCheck),
});
export type ModelMeasure = typeof ModelMeasure.Type;

/** What the window saw on one page: each read or visible action's text, in order, or why it could not run. */
export const PageSeen = S.Struct({ id: S.String, seen: S.Array(S.String), error: S.optional(S.String) });
export type PageSeen = typeof PageSeen.Type;

/** A Measure run while it goes: waiting for the GPU, then each step; ends done or error. */
export const MeasureRun = S.Struct({
  model: S.String,
  state: S.Literals(["waiting", "running", "done", "error"]),
  /** Steps finished, of `total` (one speed request and every check). */
  done: S.Int,
  total: S.Int,
  message: S.optional(S.String),
});
export type MeasureRun = typeof MeasureRun.Type;

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
  /** The folder the app's own running Ollama was started with. Absent whenever that isn't known for certain, as for an Ollama the app did not start. */
  modelsDir: S.optional(S.String),
  /** "installing": how far the download of the app's own Ollama is, as a model download says it. Received equals total while it is checked and unpacked. */
  install: S.optional(S.Struct({
    receivedBytes: Count,
    totalBytes: Count,
    bytesPerSecond: S.optional(S.Finite),
    /** The disk the installed copy takes, from the pinned release (larger than the download, which is compressed); absent where not measured. */
    diskBytes: S.optional(Count),
  })),
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
  /**
   * The system memory free in the reading the verdict was decided from (freeVramBytes is that
   * reading's GPU side). A send's reading is taken after everything else was asked to leave.
   */
  memAvailableBytes: S.optional(Count),
  /** Set when the refusal is the model's own context ceiling, not memory: the most it supports. */
});
export type FitReport = typeof FitReport.Type;

const { measuredAt: _rowsShareTheTableReading, ...fitRowFields } = FitReport.fields;
/**
 * One model at one context in the fit table. needVramBytes is always the total the model needs
 * there (GPU plus system memory). A row has no reading of its own: the table's is the only one.
 * stops: the models whose chats a send stops first, set only when stopping them is what makes it fit.
 * card: an installed model's verdict against the GPU's own memory, whatever other programs hold
 * right now (the owner's ruling, 2026-11-13); the row itself is planned right now, as a send loads
 * it. Every list and Settings show the card; only the composer and a send read right now. A row
 * offered for download is judged against the card already and has none.
 */
export const FitRow = S.Struct({
  ...fitRowFields,
  stops: S.Array(S.String),
  card: S.optional(
    S.Struct({
      verdict: fitRowFields.verdict,
      freeVramBytes: fitRowFields.freeVramBytes,
      spillRamBytes: fitRowFields.spillRamBytes,
      shortfallBytes: fitRowFields.shortfallBytes,
    }),
  ),
});
export type FitRow = typeof FitRow.Type;

/**
 * The memory line the picker's footer shows, from the table's reading. others: the programs holding
 * GPU memory above the card's steady baseline right now and how much they hold (programs empty when
 * no listed process explains it), shown as information beside verdicts that judge the card.
 * totalBytes: the whole of what a model is judged against, the card's memory or, with no GPU, the
 * computer's; each model's memory mark is drawn against it (absent from an older server).
 */
export const FitMemory = S.Union([
  S.Struct({
    kind: S.Literal("gpu"),
    freeBytes: Count,
    usableBytes: Count,
    totalBytes: S.optional(Count),
    others: S.optional(S.Struct({ programs: S.Array(S.String), bytes: Count })),
  }),
  S.Struct({ kind: S.Literal("cpu"), totalBytes: S.optional(Count) }),
  S.Struct({ kind: S.Literal("unreadable"), detail: S.String }),
]);
export type FitMemory = typeof FitMemory.Type;

/**
 * Every installed chat model and every model offered for download, at each context the app offers
 * (one row per size a model runs at), from one GPU reading. boot names the server process and seq
 * rises with each table it builds: a client keeps a table unless the next has another boot or a
 * greater seq, so a late table never replaces a newer one.
 */
export const FitTable = S.Struct({
  reading: S.Struct({ boot: S.String, seq: Count, measuredAt: Millis }),
  memory: FitMemory,
  rows: S.Array(FitRow),
});
export type FitTable = typeof FitTable.Type;

/** A way a refused model runs: "spills" runs with part of it in system memory, slower. */
const OfferVerdict = S.Literals(["fits", "spills"]);

/**
 * What a memory refusal ("wont-fit") offers, worked out from the reading that refused it
 * (apps/server/src/fit/alternatives.ts). context: the largest smaller context of the refused model
 * that runs. model: only when no context of it runs, the largest installed chat model that does, at
 * the default context. short: what the refused load lacks, the usable GPU memory and the usable
 * system memory apart (margins already taken off), for the one line said when nothing else runs.
 */
export const FitOffer = S.Struct({
  context: S.optional(S.Struct({ numCtx: PositiveInt, verdict: OfferVerdict })),
  model: S.optional(S.Struct({ model: S.String, numCtx: PositiveInt, verdict: OfferVerdict })),
  short: S.Struct({ needBytes: Count, gpuBytes: Count, ramBytes: Count, shortBytes: Count }),
});
export type FitOffer = typeof FitOffer.Type;

/** A running turn a load would have to stop (turns.blocking). */
export const BlockingTurn = S.Struct({
  threadId: S.String,
  title: S.String,
  model: S.String,
  /** Which turn this is, for chat.send's stopTurns: a thread can be running a different turn by the time the person answers. */
  turnId: S.optional(S.String),
});
export type BlockingTurn = typeof BlockingTurn.Type;

export const ChatEvent = S.Union([
  // The turn began: its model and saved user message, so a client that did not send it
  // (the same thread open elsewhere) can stream the reply too. Added 2026-11-07 (PH-02).
  // `image`: a direct Image turn; `model` is then the image preset id and no chat model runs.
  // `replayed`: sent again to a client that connected mid-reply, which did not see the turn begin.
  S.Struct({ type: S.Literal("start"), model: S.String, userMessage: Message, image: S.optional(S.Literal(true)), replayed: S.optional(S.Literal(true)) }),
  S.Struct({ type: S.Literal("delta"), text: S.String }),
  S.Struct({ type: S.Literal("thinking"), text: S.String }),
  // stopReason is Ollama's done_reason: "stop", or "length" when num_ctx or num_predict cut the reply.
  // `ended`: absent only from a server before 2026-11-13.
  S.Struct({ type: S.Literal("done"), message: Message, stopReason: S.String, ended: S.optional(TurnEnded) }),
  S.Struct({
    type: S.Literal("error"),
    code: S.String,
    message: S.String,
    ended: S.optional(TurnEnded),
    /**
     * code "runtime-changed" or "preempted": the reply streamed so far (exactly the delta and
     * thinking text sent), saved to the thread as a stopped reply. Absent when nothing was sent.
     */
    partial: S.optional(Message),
    /** No reply was saved: the question, which now keeps how its turn ended (Message.times). */
    question: S.optional(Message),
    /** code "preempted": the model whose load needed the GPU this turn's model held. */
    neededBy: S.optional(S.String),
    /** Refused before its start, code "would-stop" (chat.send askFirst or stopTurns): the running turns in the way. */
    blocking: S.optional(S.Array(BlockingTurn)),
    /** code "wont-fit": the fit that refused, with the GPU and system memory of the reading it was decided from. */
    fit: S.optional(FitReport),
    /** code "wont-fit": what does run, from the same reading. Absent when that could not be worked out. */
    offer: S.optional(FitOffer),
  }),
  // A tool call started, finished or failed; the same callId updates one step row.
  S.Struct({ type: S.Literal("tool"), step: ToolStep }),
  // The turn's reply record changed (decision 33): its stage, its times, or a second attempt. Added 2026-11-14.
  S.Struct({ type: S.Literal("reply"), reply: ReplyRecord }),
]);
export type ChatEvent = typeof ChatEvent.Type;

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

/** The one colour the person picks (styles.css --accent). Neutral is the theme foreground. */
export const Accent = S.Literals(["neutral", "green", "blue", "violet", "amber", "red"]);
export type Accent = typeof Accent.Type;

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
  /** The image preset and size for every image job (the composer's Image mode and the tool). Unset means the server's first listed preset. */
  imageChoice: S.optional(ImageChoice),
  /** Tools › Make images: a chat model may call the image tool. Unset means on once a setup can run; false stays off. */
  imageTool: S.optional(S.Boolean),
  /** A ComfyUI the user points at; unset means discover the local install. */
  comfyUrl: S.optional(S.String),
  /** The folder image model downloads go in (its kind folders inside: diffusion_models, vae…), picked by the person; unset means the engine's own models folder. Files already downloaded stay where they are. */
  imageFolder: S.optional(S.String),
  /** Local dictation; absent means off. Only a loopback HTTP IP literal is accepted. */
  whisperUrl: S.optional(S.String),
  /** Updates take every change on the main branch, not only releases. Unset means off. */
  updateEveryChange: S.optional(S.Boolean),
  /** Desktop-only automatic git checks. Unset means on. Never installs automatically. */
  updateAutomatic: S.optional(S.Boolean),
  // textSize was removed 2026-11-13: a stored value is dropped on decode, so old files still load.
  /** Unset means "neutral". */
  accent: S.optional(Accent),
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
  imageChoice: S.optional(S.NullOr(ImageChoice)),
  /** null: back to unset (Reset settings). */
  imageTool: S.optional(S.NullOr(S.Boolean)),
  comfyUrl: S.optional(S.NullOr(S.String)),
  imageFolder: S.optional(S.NullOr(S.String)),
  whisperUrl: S.optional(S.NullOr(S.String)),
  updateEveryChange: S.optional(S.Boolean),
  updateAutomatic: S.optional(S.Boolean),
  // An older app still sends textSize; unknown keys are dropped on decode, so that is no error.
  accent: S.optional(Accent),
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
  /** An "error" refused for memory: what does run, from the same reading (as on chat.event's wont-fit). */
  offer: S.optional(FitOffer),
});
export type ModelLoad = typeof ModelLoad.Type;

/**
 * The one thing the app keeps in memory: a chat model at a context, or the image engine's loaded
 * setup (its preset id and size, as ImageChoice names them). `since`: when it became resident.
 */
export const MemoryThing = S.Union([
  S.Struct({ kind: S.Literal("chat"), model: S.String, numCtx: S.optional(NumCtx), since: S.optional(Millis) }),
  S.Struct({ kind: S.Literal("image"), setup: S.String, since: S.optional(Millis) }),
]);
export type MemoryThing = typeof MemoryThing.Type;

/**
 * What is in memory, and the handoff to the next thing while one runs: everything else is asked
 * to leave ("leaving"), the memory is read again ("measuring"), then the thing loads ("loading").
 * `resident` is absent when nothing the app may hand off is in memory.
 */
export const MemoryState = S.Struct({
  resident: S.optional(MemoryThing),
  handoff: S.optional(S.Struct({ to: MemoryThing, stage: S.Literals(["leaving", "measuring", "loading"]) })),
});
export type MemoryState = typeof MemoryState.Type;

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
  /** A recommended model's place in its tier: 0 the first pick, then the alternates (runtime/tiers.ts). */
  rank: S.optional(S.Number),
  fit: S.optional(FitReport),
});
export type CatalogEntry = typeof CatalogEntry.Type;

/**
 * A typed model name before its download: its size from the curated list or the registry, and its
 * fit against the card and the system memory the computer has. `found` is "no" when the registry
 * has no such model and "unknown" when it could not be asked (offline, or turned off).
 */
export const ModelEstimate = S.Struct({
  /** The Ollama tag asked about, with ":latest" when the name had no tag. */
  name: S.String,
  found: S.Literals(["yes", "no", "unknown"]),
  downloadBytes: S.optional(Count),
  fit: S.optional(FitReport),
});
export type ModelEstimate = typeof ModelEstimate.Type;

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
  managed: S.optional(S.Struct({ kind: S.Literals(["sample", "repository"]), key: S.String })),
  /**
   * A database's tables and row counts, read from its snapshot when it is made:
   * its own tables, a virtual one (full-text, R-tree) by name with no count, never
   * the tables SQLite keeps for itself or behind a virtual table. At most 500.
   */
  tables: S.optional(S.Array(S.Struct({ name: S.String, rows: S.optional(Count) }))),
  /** How many tables it has, only when that is more than `tables` lists. */
  tableCount: S.optional(Count),
});
export type Source = typeof Source.Type;

/** `questions`: the four a person can start a chat with, text only. */
export const SampleDatabase = S.Struct({ id: S.String, label: S.String, description: S.String, sizeBytes: Count, url: S.String, license: S.String, licenseUrl: S.String, tables: S.Array(S.Struct({ name: S.String, rows: Count })), questions: S.Array(S.String) });
export type SampleDatabase = typeof SampleDatabase.Type;
export const SourceImport = S.Struct({
  id: S.String, key: S.String, label: S.String, kind: S.Literals(["sample", "repository"]),
  state: S.Literals(["downloading", "cloning", "adding", "ready", "error", "cancelled"]),
  bytes: Count, total: S.optional(Count), detail: S.optional(S.String), sourceId: S.optional(S.String),
});
export type SourceImport = typeof SourceImport.Type;
export const SourceImports = S.Struct({ samples: S.Array(SampleDatabase), jobs: S.Array(SourceImport) });
export type SourceImports = typeof SourceImports.Type;


export const ImageStatus = S.Struct({
  state: S.Literals(["off", "missing", "stopped", "starting", "ready", "busy", "error"]),
  owner: RuntimeOwner,
  baseUrl: S.optional(S.String),
  detail: S.optional(S.String),
  /** The address is the one the person set in Settings (not the app's own engine or the default): nothing answering there means "not running", never "not set up". */
  addressSet: S.optional(S.Boolean),
  /**
   * With image generation off: no image engine anywhere (none of the app's, no address set, no
   * ComfyUI service, nothing answering at the default address). Settings then offers Set up images
   * in place of the switch.
   */
  nowhere: S.optional(S.Boolean),
});
export type ImageStatus = typeof ImageStatus.Type;

/**
 * Run commands on this machine. "ready" only once a real command ran in its sandbox; "off" says why
 * in a few words (`word`, what Settings shows in place of Ready) and a sentence (`reason`).
 */
export const ShellStatus = S.Struct({
  state: S.Literals(["ready", "off"]),
  word: S.optional(S.String),
  reason: S.optional(S.String),
});
export type ShellStatus = typeof ShellStatus.Type;

/** One size of a preset and the GPU memory a job at that size needs. */
export const ImageSize = S.Struct({ width: S.Int, height: S.Int, bytes: Count });
export type ImageSize = typeof ImageSize.Type;

/** A preset ComfyUI has every file for: what the image picker lists. */
export const ImagePreset = S.Struct({
  id: S.String,
  name: S.String,
  /** The composer button's name beside the family mark; no two of the app's own share its first letter. Absent: `name`. */
  short: S.optional(S.String),
  /** The model family the graph is built for (one rail icon per family). */
  family: S.String,
  /** The picker's group: a theme (General, Pixel art…) for the app's own setups, where it came from for ComfyUI's. Absent from older servers. */
  group: S.optional(S.String),
  /** The quality tier this setup is for this GPU's free memory ("Fast", "Balanced", "Best", or two joined); absent for the rest. */
  tier: S.optional(S.String),
  /** Set on a Defaults row: the style it is the default for at this machine's level ("general", "portraits", "pixel-art"…). */
  style: S.optional(S.String),
  /** The model alone ("FLUX.2 Klein 4B"), where `name` adds a style: the picker's sizes head says this. Absent: `name` is the model. */
  model: S.optional(S.String),
  sizes: S.Array(ImageSize),
  /** False: the bytes are an estimate, not a measured peak. */
  measured: S.Boolean,
  /**
   * Not ready: the files ComfyUI does not list (names as the workflow gives them), once known their
   * total size, and `download` when every one has an address image.download fetches from.
   */
  needs: S.optional(S.Struct({
    files: S.Array(S.String), bytes: S.optional(Count), download: S.optional(S.Boolean),
    /** What is left to fetch into the download folder: `bytes` less the parts already there. Absent while a size is unknown. */
    leftBytes: S.optional(Count),
  })),
  /** Not runnable here, in words: a node class ComfyUI lacks, or no single prompt, size, seed or output. */
  why: S.optional(S.String),
});
export type ImagePreset = typeof ImagePreset.Type;

/** One file of a setup's download (image.download): which setup, which file of how many, and its PullProgress. */
export const ImageDownload = S.Struct({
  ...PullProgress.fields,
  preset: S.String,
  /** This file's place in the setup's list, from 1, and the list's length. */
  file: S.Int,
  files: S.Int,
  /** The whole setup's bytes, every file's fetched so far and in all; only when every file's size is known. */
  setupCompletedBytes: S.optional(Count),
  setupTotalBytes: S.optional(Count),
  /** The download's last word: every file is in, or it stopped or failed on this one. */
  ended: S.optional(S.Boolean),
});
export type ImageDownload = typeof ImageDownload.Type;

/**
 * Set up images' run: the engine's download and unpack, its first start, then the model's
 * download (which image.download also pushes). Bytes count the engine and the model together.
 */
export const ImageSetupProgress = S.Struct({
  step: S.Literals(["engine", "starting", "model", "done", "error"]),
  completedBytes: Count,
  totalBytes: Count,
  /** The error's own words. */
  message: S.optional(S.String),
});
export type ImageSetupProgress = typeof ImageSetupProgress.Type;

/**
 * What Set up images would fetch on this computer, or why it cannot run here: the app's own
 * ComfyUI (the engine) and the recommended setup for this card, as one download.
 */
export const ImageSetup = S.Struct({
  /** One sentence, no unit or service names; absent when it can run. */
  why: S.optional(S.String),
  engine: S.optional(S.Struct({ version: S.String, bytes: Count, installed: S.Boolean })),
  model: S.optional(S.Struct({ preset: S.String, name: S.String, bytes: Count })),
  /** Set when pictures here run on the processor: the measured seconds a picture, said before anything downloads. */
  cpu: S.optional(S.Struct({ low: Count, high: Count })),
  /** Free space on the app's drive, and what the setup needs there (the engine unpacked, plus the model). */
  freeBytes: S.optional(Count),
  needBytes: S.optional(Count),
  /** The running setup's step, or the last one's end. */
  progress: S.optional(ImageSetupProgress),
});
export type ImageSetup = typeof ImageSetup.Type;

export const ImagePresets = S.Struct({
  /** Only the presets whose every node class and file ComfyUI listed. */
  presets: S.Array(ImagePreset),
  /** The rest, each with `needs` or `why`; the picker lists them greyed out. */
  others: S.optional(S.Array(ImagePreset)),
  /** When ComfyUI's file list was last read; absent means never (presets is then empty). */
  readAt: S.optional(Millis),
  /**
   * What an Image send runs now: Settings' choice, else the default. Named from every preset the
   * server knows, so the composer can say it before ComfyUI has listed its files.
   */
  current: S.Struct({ preset: ImagePreset, width: S.Int, height: S.Int }),
  /** Set when this machine has too little GPU memory for any default (or none): why, in words. An unset send is then refused. */
  noGpu: S.optional(S.String),
  /** Set when ComfyUI runs on the processor: pictures are made, slowly; how slowly, in words. */
  slow: S.optional(S.String),
  /** The download running now, as its last image.download push said. */
  download: S.optional(ImageDownload),
  /**
   * Where image downloads go and the room there, read before any transfer: `folder` absent means
   * there is no folder to put them in until the person picks one (an engine that never said where
   * its models are). `picked`: Settings' imageFolder. `line`: set when the folder was picked and
   * the ComfyUI on this computer is the person's own, not the app's: the one line to add to its
   * extra_model_paths.yaml so it reads the folder (the app never writes that file).
   */
  disk: S.optional(S.Struct({ folder: S.optional(S.String), freeBytes: S.optional(Count), picked: S.Boolean, line: S.optional(S.String) })),
});
export type ImagePresets = typeof ImagePresets.Type;

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
  /** An installed copy (AppImage or installer): the version it was packaged as. Checks read the signed release list. */
  S.Struct({ kind: S.Literal("installed"), version: S.String }),
]);
export type UpdateVersion = typeof UpdateVersion.Type;

/** main: every change on the branch. release: the newest v1.2.3 tag. */
export const UpdateChannel = S.Literals(["main", "release"]);
export type UpdateChannel = typeof UpdateChannel.Type;

/**
 * Why a check could not say whether there is an update. The last five are an
 * installed copy's: a development build, no trusted release key, the release
 * page unreachable, no list on it, a list that failed its signature check.
 */
export const UpdateBlocked = S.Literals(["no-git", "not-a-clone", "no-upstream", "local-changes", "remote", "local-commits", "no-releases", "diverged", "unfinished", "error", "development", "no-key", "unreachable", "no-list", "bad-signature"]);
export type UpdateBlocked = typeof UpdateBlocked.Type;

/**
 * An installed copy's download of a newer version (absent: not started, and
 * update.download starts it). bad: it did not match the signed list. failed:
 * the network. disk: too little free space. ready: downloaded and checked.
 */
export const UpdateDownload = S.Literals(["downloading", "bad", "failed", "disk", "ready"]);
export type UpdateDownload = typeof UpdateDownload.Type;

/** One click of "Check for updates": fetches from the clone's remote, changes nothing. */
export const UpdateCheck = S.Union([
  S.Struct({ state: S.Literal("up-to-date"), checkedAt: Millis, channel: UpdateChannel, current: S.String }),
  S.Struct({
    state: S.Literal("available"),
    checkedAt: Millis,
    channel: UpdateChannel,
    current: S.String,
    target: S.String,
    /** Exact commit checked by the server; older servers omitted it. */
    targetCommit: S.optional(S.String),
    /** Every commit between current and target. */
    total: Count,
    /** Commit subjects, newest first, at most 20. */
    changes: S.Array(S.String),
    /** A release's tag message, shown instead of the subjects when there is one. */
    notes: S.optional(S.String),
  }),
  /** lines: what happened, then what to do, in plain words. page: the release page the lines send the person to, when they do. */
  S.Struct({ state: S.Literal("cannot-check"), checkedAt: Millis, reason: UpdateBlocked, lines: S.Array(S.String), page: S.optional(S.String) }),
  /**
   * An installed copy found a newer version in a verified release list. It
   * carries no commit, approval or install control. forThisCopy: the list
   * holds an installer for this platform. download: where fetching that
   * installer stands; lines already say it in words, progress included.
   */
  S.Struct({
    state: S.Literal("newer"), checkedAt: Millis, current: S.String, target: S.String, forThisCopy: S.Boolean, lines: S.Array(S.String), page: S.String, download: S.optional(UpdateDownload),
    /** The download is ready and this copy can replace its own file: Restart to update. */
    restart: S.optional(S.Boolean),
  }),
]);
export type UpdateCheck = typeof UpdateCheck.Type;

/** The last update run, shown once on the next start. */
export const UpdateResult = S.Struct({
  at: Millis,
  /** rolled-back: an installed copy's new version did not start and it went back. */
  outcome: S.Literals(["updated", "rolled-back", "stopped", "rollback-failed", "refused"]),
  /** "Updated to v0.2.0, 12 changes." or the stopped-at line. */
  line: S.String,
  /** The line ends by sending the person to the release page (an installed copy's failure notes). */
  page: S.optional(S.String),
  logPath: S.optional(S.String),
  /** rollback-failed: the commands that finish going back, run in the clone. */
  commands: S.optional(S.Array(S.String)),
});
export type UpdateResult = typeof UpdateResult.Type;

export const UpdateStatus = S.Struct({
  version: UpdateVersion,
  /** Present until update.dismissResult. */
  result: S.NullOr(UpdateResult),
  /** The last manual check or successful automatic check since startup. */
  lastCheck: S.NullOr(UpdateCheck),
  /** Work the desktop's restart would interrupt, including other clients. */
  activity: S.optional(S.Array(S.String)),
  /** Server-owned approval for this target and exact activity snapshot. */
  approval: S.optional(S.String),
  installing: S.optional(S.Boolean),
  /** Phone listeners expose update status without update controls. */
  canControl: S.optional(S.Boolean),
});
export type UpdateStatus = typeof UpdateStatus.Type;

/**
 * target: what the reservation is pinned to. A clone's checked commit; an
 * installed copy's pinned artifact, `<version>:<SHA-512 of the signed list>`
 * (docs/design/installed-updates.md, section 1 step 4).
 */
export const UpdateInstallRequest = S.Struct({ reservation: S.String, target: S.String });
export type UpdateInstallRequest = typeof UpdateInstallRequest.Type;
export const UpdateCommitRequest = S.Struct({ reservation: S.String, target: S.String, release: S.String });
export type UpdateCommitRequest = typeof UpdateCommitRequest.Type;

export const UpdateCommitResult = S.Union([
  S.Struct({ accepted: S.Literal(false) }),
  S.Struct({ accepted: S.Literal(true), release: S.String }),
]);
export type UpdateCommitResult = typeof UpdateCommitResult.Type;

export const UpdatePreparation = S.Union([
  S.Struct({ state: S.Literal("ready"), reservation: S.String, target: S.String }),
  S.Struct({ state: S.Literal("changed"), status: UpdateStatus }),
  S.Struct({ state: S.Literal("blocked"), message: S.String }),
]);
export type UpdatePreparation = typeof UpdatePreparation.Type;

// ---- Pictures: an index of the finished image cards. The card is the picture; this only finds it.

/** One finished picture. Its job id is its card's message id. */
export const Picture = S.Struct({
  jobId: S.String,
  threadId: S.String,
  /** The thread's title now. */
  threadTitle: S.String,
  /** The person's words, as on the card. */
  prompt: S.String,
  /** The setup it ran (ImageChoice.preset). Absent on cards saved before setups. */
  preset: S.optional(S.String),
  /** The file's own size in pixels. */
  width: PositiveInt,
  height: PositiveInt,
  /** Absent when not known: a picture from before the index whose file does not say. */
  seed: S.optional(Count),
  steps: S.optional(PositiveInt),
  /** When it was sent, and when its file was saved. */
  queuedAt: Millis,
  doneAt: Millis,
  /** ComfyUI's time making it. Absent on pictures made before it was kept. */
  runMs: S.optional(Count),
  /** The file's size in bytes. */
  bytes: Count,
  /** The full picture, relative to the data dir; the thumbnail is /files/thumbs/<jobId>.webp. */
  imagePath: S.String,
});
export type Picture = typeof Picture.Type;

/** `before`: the previous page's `next`. `q`: words in the prompt. `setup`: a preset id. */
export const PictureListParams = S.Struct({
  before: S.optional(S.String.check(S.isMaxLength(40))),
  q: S.optional(S.String.check(S.isMaxLength(500))),
  setup: S.optional(S.String.check(S.isMaxLength(100))),
  limit: PositiveInt.check(S.isLessThanOrEqualTo(500)),
});
export type PictureListParams = typeof PictureListParams.Type;

/** Newest first. `count`: every picture the filter matches. `next`: absent on the last page. */
export const PictureList = S.Struct({
  pictures: S.Array(Picture),
  count: Count,
  next: S.optional(S.String),
});
export type PictureList = typeof PictureList.Type;
