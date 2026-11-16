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
  imageChoice: S.optional(ImageChoice),
  imageCount: S.optional(ImageCount),
});
export type Thread = typeof Thread.Type;

export const Role = S.Literals(["user", "assistant", "system"]);
export type Role = typeof Role.Type;

export const MessageStats = S.Struct({
  promptTokens: S.optional(Count),
  completionTokens: S.optional(Count),
  durationMs: S.optional(S.Finite),
  numCtx: S.optional(PositiveInt),
  // external: Ollama's eval_duration is decode only, not the load or the prompt
  evalDurationMs: S.optional(S.Finite),
  // external: Ollama's prompt_eval_duration is the time spent reading the prompt
  promptEvalDurationMs: S.optional(S.Finite),
});
export type MessageStats = typeof MessageStats.Type;

/** One tool call in a turn, shown as a step row. */
export const ToolStep = S.Struct({
  callId: S.String,
  name: S.String,
  state: S.Literals(["running", "done", "error"]),
  stopped: S.optional(S.Literal(true)),
  summary: S.String,
  detail: S.optional(S.String),
  durationMs: S.optional(S.Finite),
  links: S.optional(S.Array(S.String)),
});
export type ToolStep = typeof ToolStep.Type;

/** Image jobs are durable messages; events carry the same state as the saved card. */
export const ImageEvent = S.Struct({
  jobId: S.String,
  threadId: S.optional(S.String),
  state: S.Literals(["queued", "running", "done", "error", "cancelled"]),
  phase: S.optional(S.Literals(["freeing", "stopping"])),
  // external: ComfyUI reports executing per node and progress frames on its websocket
  stage: S.optional(S.Literals(["queued", "loading", "encoding", "sampling", "decoding"])),
  // external: ComfyUI's progress frame carries the sampler's step as value and max
  steps: S.optional(S.Struct({ done: S.Int, total: S.Int })),
  sampled: S.optional(S.Literal(true)),
  progress: S.optional(S.Finite),
  imagePath: S.optional(S.String),
  message: S.optional(S.String),
  errorKind: S.optional(S.String),
  retryJobId: S.optional(S.String),
  choice: S.optional(ImageChoice),
  sent: S.optional(ImageChoice),
  group: S.optional(ImageGroup),
  runMs: S.optional(Count),
});
export type ImageEvent = typeof ImageEvent.Type;

/**
 * How a turn ended, as the server decided it: done; stopped by a person's Stop
 * (reply.stop), or by deleting its question; preempted, the server stopping it to make way for
 * something (another model's load, a runtime change, the app closing); or failed. `at` is when it
 * ended: for a Stop, when the cancel came. Rides on the one terminal event, done or error.
 */
export const TurnEnded = S.Struct({
  reason: S.Literals(["done", "stopped", "preempted", "failed"]),
  at: Millis,
});
export type TurnEnded = typeof TurnEnded.Type;

/**
 * A reply's times, stamped by the server from the events it sent, so every window
 * and every reload shows the same seconds. Absent on rows saved before 2026-11-14 and on pictures.
 */
export const ReplyTimes = S.Struct({
  startedAt: Millis,
  readyAt: S.optional(Millis),
  firstTokenAt: S.optional(Millis),
  thoughtMs: S.optional(Count),
  spans: S.Array(S.Struct({ from: Count, ms: Count })),
  callsAt: S.Record(S.String, Count),
  workMs: S.optional(Count),
  ended: TurnEnded,
  why: S.optional(S.Struct({ code: S.String, message: S.String, neededBy: S.optional(S.String) })),
});
export type ReplyTimes = typeof ReplyTimes.Type;

/**
 * A non-image file attached to a message: the server's own copy in its data folder. The model
 * never gets its contents in the prompt, only a line naming it; with tools on it reads the copy
 * through the read tool, by its label, in this thread's turns only.
 */
export const AttachedFile = S.Struct({
  path: S.String.check(S.isPattern(/^files\/att-[a-f0-9-]{36}$/)),
  name: S.String.check(S.isMinLength(1), S.isMaxLength(255)),
  size: Count,
  type: S.String.check(S.isMaxLength(200)),
});
export type AttachedFile = typeof AttachedFile.Type;

export const Message = S.Struct({
  contextNotice: S.optional(S.String),
  id: S.String,
  threadId: S.String,
  role: Role,
  content: S.String,
  thinking: S.optional(S.String),
  model: S.optional(S.String),
  createdAt: Millis,
  stats: S.optional(MessageStats),
  tools: S.optional(S.Array(ToolStep)),
  images: S.optional(S.Array(S.String)),
  files: S.optional(S.Array(AttachedFile)),
  interrupted: S.optional(S.Literal(true)),
  imageJob: S.optional(ImageEvent),
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
  numCtx: PositiveInt,
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
  // external: Ollama's /api/show lists capabilities; completion means it can chat
  capabilities: S.Array(ModelCapability),
  // external: Ollama's /api/show may or may not report a model's context length
  maxContext: S.optional(PositiveInt),
  pick: S.optional(ModelPick),
});
export type ModelInfo = typeof ModelInfo.Type;

/**
 * A model's measured speed on this computer: completion tokens over decode time,
 * summed over its finished replies of the last 14 days. Never an estimate; a model
 * without enough measured replies has no entry.
 */
export const ModelSpeed = S.Struct({
  model: S.String,
  tokensPerSecond: S.Finite.check(S.isGreaterThan(0)),
  replies: PositiveInt,
});
export type ModelSpeed = typeof ModelSpeed.Type;

/** The parts a Measure score is made of (version 2); each has its own count and weight. */
export const MeasurePart = S.Literals(["tools", "files", "database", "instructions", "pages"]);
export type MeasurePart = typeof MeasurePart.Type;

/** One thing the window does to a page a model wrote (Measure's Pages part), by CSS selector. */
export const PageAction = S.Union([
  S.Struct({ do: S.Literal("click"), target: S.String }),
  S.Struct({ do: S.Literal("fill"), target: S.String, text: S.String }),
  S.Struct({ do: S.Literal("read"), target: S.String }),
  S.Struct({ do: S.Literal("visible"), target: S.String }),
]);
export type PageAction = typeof PageAction.Type;

/**
 * One check of a Measure run. A measure saved before version 2 has only id, kind ("tools" or
 * "sql"), ok, and maybe reply and result.
 */
export const MeasureCheck = S.Struct({
  id: S.String,
  kind: S.Literals(["tools", "sql", "files", "database", "instructions", "pages"]),
  ok: S.Boolean,
  reply: S.optional(S.String),
  result: S.optional(S.String),
  state: S.optional(S.Literals(["pending", "skipped"])),
  needs: S.optional(S.String),
  why: S.optional(S.String),
  calls: S.optional(S.Array(S.String)),
  tokens: S.optional(S.Int),
  // external: Ollama's eval_count counts thinking and answer tokens together
  thinkTokens: S.optional(S.Int),
  cut: S.optional(S.Boolean),
  cutThinking: S.optional(S.Boolean),
  ms: S.optional(S.Finite),
  page: S.optional(S.String),
  script: S.optional(S.Array(PageAction)),
});
export type MeasureCheck = typeof MeasureCheck.Type;

/**
 * The version a Measure made now carries. It goes up whenever a check, a grade, a weight or how the
 * checks run changes, so a score from before is marked as earlier and never sits beside a new one
 * as if made alike.
 */
export const MEASURE_VERSION = 4;

/** A part's count: checks passed of the ones that ran, and its weight in the score. */
export const MeasurePartCount = S.Struct({ part: MeasurePart, passed: S.Int, total: S.Int, weight: S.Int });
export type MeasurePartCount = typeof MeasurePartCount.Type;

/**
 * A model measured on this computer when the person asked (Settings › Models, Measure): its
 * reply speed and the share of checks it passed. Kept per model and digest, so a re-pulled
 * model with new weights is measured again. Without `version` it is an older measure of eight
 * single-shot checks, kept readable until the model is measured again. Version 2 is the five parts
 * with earlier checks and grades: fewer tasks, some replies graded differently, the chat's own
 * sampling; its score is not alike with a version 3 one. Version 3 has this build's checks, but
 * skipped a check whose turn the model itself ended (tool calls the tools refused, calls up to the
 * turn limit, a window it filled), where this build fails it: its score can be higher.
 */
export const ModelMeasure = S.Struct({
  model: S.String,
  digest: S.String,
  at: S.Finite,
  version: S.optional(S.Literals([2, 3, 4])),
  numCtx: S.Int,
  think: S.optional(S.Boolean),
  sampling: S.optional(S.Struct({ temperature: S.Finite, seed: S.Int })),
  tokensPerSecond: S.Finite.check(S.isGreaterThanOrEqualTo(0)),
  firstTokenMs: S.optional(S.Finite),
  slow: S.optional(S.Literals(["decode", "first-token"])),
  score: S.Int.check(S.isBetween({ minimum: 0, maximum: 100 })),
  parts: S.optional(S.Array(MeasurePartCount)),
  checks: S.Array(MeasureCheck),
});
export type ModelMeasure = typeof ModelMeasure.Type;

/**
 * What the window saw on one page: each read or visible action's text, in order, or why it could
 * not run (`error`, a fail). `skipped`: the window runs no pages on this computer, and why; the
 * check counts for nothing either way.
 */
export const PageSeen = S.Struct({ id: S.String, seen: S.Array(S.String), error: S.optional(S.String), skipped: S.optional(S.String) });
export type PageSeen = typeof PageSeen.Type;

/** One page a saved reply wrote (a closed html block that is a whole document), and that reply's id. */
export const ThreadPage = S.Struct({ messageId: S.String, code: S.String });
export type ThreadPage = typeof ThreadPage.Type;

/** A Measure run while it goes: waiting for the GPU, then each step; ends done or error. */
export const MeasureRun = S.Struct({
  model: S.String,
  state: S.Literals(["waiting", "running", "done", "error"]),
  done: S.Int,
  total: S.Int,
  message: S.optional(S.String),
});
export type MeasureRun = typeof MeasureRun.Type;

/**
 * models.measures' answer: every saved measure, and the server's own record of the run, its last
 * step, while it waits or runs and after it stopped on an error (none once a run is done). A
 * window that connects mid-run, or missed a run's last push, shows this.
 */
export const MeasureList = S.Struct({ measures: S.Array(ModelMeasure), run: S.optional(MeasureRun) });
export type MeasureList = typeof MeasureList.Type;

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
  detail: S.optional(S.String),
  busyPorts: S.optional(S.Array(S.String)),
  noAppCopy: S.optional(S.Boolean),
  modelsDir: S.optional(S.String),
  // external: OLLAMA_MAX_LOADED_MODELS=1 makes Ollama unload one model to load another
  holdsOne: S.optional(S.Boolean),
  failure: S.optional(S.Literals(["download", "checksum", "disk", "install", "start"])),
  install: S.optional(S.Struct({
    receivedBytes: Count,
    totalBytes: Count,
    bytesPerSecond: S.optional(S.Finite),
    diskBytes: S.optional(Count),
    stalled: S.optional(S.Literal(true)),
  })),
});
export type RuntimeStatus = typeof RuntimeStatus.Type;

/**
 * A verdict in the app's words, made by the server where it judged (fit-words.ts fitWords) and
 * printed by clients as sent. basis: what it was judged against, the card's own memory ("card",
 * every list) or what is free right now ("now", a send). label: the status line ("Should run
 * well"); word, chip and detail: the composer and a card ("Uses system memory · slower", "system
 * memory", "2.7 GB in system memory"); mark: the memory mark's name; short: the picker's word;
 * amt: the spill or shortfall in bytes, 0 on the GPU.
 */
export const FitWords = S.Struct({
  basis: S.Literals(["card", "now"]),
  k: S.Literals(["gpu", "spill", "no"]),
  label: S.String,
  word: S.String,
  chip: S.String,
  detail: S.String,
  mark: S.String,
  short: S.String,
  amt: S.Number,
});
export type FitWords = typeof FitWords.Type;

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
  message: S.optional(S.String),
  memAvailableBytes: S.optional(Count),
  words: S.optional(FitWords),
});
export type FitReport = typeof FitReport.Type;

/** What holds GPU memory now. `protected` holders are never stopped by the app (whisper, other apps). */
export const GpuOccupant = S.Struct({
  label: S.String,
  bytes: Count,
  kind: S.Literals(["chat-model", "image", "whisper", "other-app", "unknown"]),
  protected: S.Boolean,
});
export type GpuOccupant = typeof GpuOccupant.Type;

const { measuredAt: _rowsShareTheTableReading, ...fitRowFields } = FitReport.fields;
/**
 * One model at one context in the fit table. needVramBytes is always the total the model needs
 * there (GPU plus system memory). A row has no reading of its own: the table's is the only one.
 * stops: the models whose chats a send stops first, set only when stopping them is what makes it fit.
 * card: an installed model's verdict against the GPU's own memory, whatever other programs hold
 * right now; the row itself is planned right now, as a send loads
 * it. Every list and Settings show the card; only the composer and a send read right now. A row
 * offered for download is judged against the card already and has none.
 * card.inTheWay: set when the card fits the model and right now it spills: who holds the card's
 * memory, biggest first, only as many as it takes to cover the spill (all of them when even that
 * does not). Never the model runtime's own runners: models that leave for the load are already
 * counted free, and a busy chat is `stops`.
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
      inTheWay: S.optional(S.Array(GpuOccupant)),
      words: fitRowFields.words,
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
    gpuCount: S.optional(Count),
    others: S.optional(S.Struct({ programs: S.Array(S.String), bytes: Count })),
  }),
  S.Struct({ kind: S.Literal("cpu"), totalBytes: S.optional(Count) }),
  S.Struct({ kind: S.Literal("unreadable"), detail: S.String }),
]);
export type FitMemory = typeof FitMemory.Type;

/**
 * Every installed chat model and every model offered for download, at each context the app offers
 * (one row per size a model runs at), from one GPU reading. boot names the server process and seq
 * counts the tables it has built. A window orders tables by the sync number every answer and push
 * of the table carries (scope "fit-table"), never by these.
 */
export const FitTable = S.Struct({
  reading: S.Struct({ boot: S.String, seq: Count, measuredAt: Millis }),
  memory: FitMemory,
  rows: S.Array(FitRow),
});
export type FitTable = typeof FitTable.Type;

const OfferVerdict = S.Literals(["fits", "spills"]);

/**
 * What a memory refusal ("wont-fit") offers, worked out from the reading that refused it
 * (apps/server/src/fit/alternatives.ts). context: the largest smaller context of the refused model
 * that runs. model: only when no context of it runs, the largest installed chat model that does, at
 * the default context. short: what the refused load lacks, the usable GPU memory and the usable
 * system memory apart (margins already taken off), for the one line said when nothing else runs.
 */
export const FitOffer = S.Struct({
  context: S.optional(S.Struct({ numCtx: PositiveInt, verdict: OfferVerdict, words: S.optional(FitWords) })),
  model: S.optional(S.Struct({ model: S.String, numCtx: PositiveInt, verdict: OfferVerdict, words: S.optional(FitWords) })),
  short: S.Struct({ needBytes: Count, gpuBytes: Count, ramBytes: Count, shortBytes: Count }),
});
export type FitOffer = typeof FitOffer.Type;

/** A running turn a load would have to stop (turns.blocking). */
export const BlockingTurn = S.Struct({
  threadId: S.String,
  title: S.String,
  model: S.String,
  turnId: S.optional(S.String),
});
export type BlockingTurn = typeof BlockingTurn.Type;

export const NumCtx = PositiveInt;


export const ReplyId = S.String.check(S.isMinLength(1), S.isMaxLength(200));
const ReplyCommon = {
  id: ReplyId,
  threadId: S.String,
  rev: Count,
};
/** The message as the window that typed it sends it (reply.send). */
export const ReplySaid = {
  messageId: S.String.check(S.isMinLength(1), S.isMaxLength(200)),
  text: S.String,
  images: S.optional(S.Array(S.String).check(S.isMaxLength(8))),
  files: S.optional(S.Array(AttachedFile).check(S.isMaxLength(8))),
  model: S.optional(S.String),
  numCtx: S.optional(NumCtx),
  think: S.optional(S.Boolean),
  tools: S.optional(S.Boolean),
  draw: S.optional(ImageChoice),
  drawCount: S.optional(ImageCount),
  retryOf: S.optional(S.String.check(S.isMaxLength(200))),
};
const ReplyWords = { ...ReplySaid, at: Millis };

/** What is in the way of a queued message right now. The server works it out; a window never does. */
export const WaitFor = S.Union([
  S.Struct({ what: S.Literal("setup") }),
  S.Struct({ what: S.Literal("download"), model: S.optional(S.String) }),
  S.Struct({ what: S.Literal("reply"), reply: ReplyId }),
  S.Struct({ what: S.Literal("retry"), reply: ReplyId }),
]);
export type WaitFor = typeof WaitFor.Type;

/** Why a message is on hold. */
export const HeldWhy = S.Union([
  S.Struct({ why: S.Literal("stopped") }),
  S.Struct({ why: S.Literal("failed") }),
  S.Struct({ why: S.Literal("restart") }),
  S.Struct({
    why: S.Literal("refused"),
    code: S.String,
    message: S.String,
    blocking: S.optional(S.Array(BlockingTurn)),
    offer: S.optional(FitOffer),
  }),
]);
export type HeldWhy = typeof HeldWhy.Type;

/** The yes to stopping replies in other chats: standing, or for the replies a warning named. */
export const StopConsent = S.Union([
  S.Struct({ kind: S.Literal("standing") }),
  S.Struct({ kind: S.Literal("named"), replies: S.Array(ReplyId).check(S.isMaxLength(32)) }),
]);
export type StopConsent = typeof StopConsent.Type;

const QueuedReply = S.Struct({ ...ReplyCommon, ...ReplyWords, stage: S.Literal("queued"), waitFor: S.optional(WaitFor) });
const HeldReply = S.Struct({ ...ReplyCommon, ...ReplyWords, stage: S.Literal("held"), held: HeldWhy });
const NextReply = S.Struct({ ...ReplyCommon, ...ReplyWords, stage: S.Literal("next"), consent: S.optional(StopConsent) });
const EditingReply = S.Struct({
  ...ReplyCommon, ...ReplyWords, stage: S.Literal("editing"),
  by: S.String,
  back: S.Union([
    S.Struct({ stage: S.Literal("queued") }),
    S.Struct({ stage: S.Literal("held"), held: HeldWhy }),
    S.Struct({ stage: S.Literal("next"), consent: S.optional(StopConsent) }),
  ]),
});
const StartingReply = S.Struct({
  ...ReplyCommon, ...ReplyWords, stage: S.Literal("starting"),
  attempt: PositiveInt,
  startedAt: Millis,
  loading: S.optional(S.Literal(true)),
});
const ReplyClock = {
  questionId: S.String,
  model: S.String,
  startedAt: Millis,
  readyAt: S.optional(Millis),
  firstTokenAt: S.optional(Millis),
  workMs: Count,
  toolMs: Count,
  try: PositiveInt,
  spans: S.Array(S.Struct({ from: Count, ms: Count })),
  callsAt: S.Record(S.String, Count),
};
const LiveReply = S.Struct({
  ...ReplyCommon, ...ReplyClock, stage: S.Literals(["loading", "thinking", "tool", "writing"]),
  // why: silent: its model is in memory and has sent nothing yet, so there is no work to time
  silent: S.optional(S.Literal(true)),
});
// why: stoppedAt: a Stop was taken and the engine has not let go of its pictures yet
const DrawingReply = S.Struct({ ...ReplyCommon, stage: S.Literal("drawing"), questionId: S.String, preset: S.String, startedAt: Millis, jobs: S.Array(S.String), stoppedAt: S.optional(Millis) });
const StoppingReply = S.Struct({ ...ReplyCommon, ...ReplyClock, stage: S.Literal("stopping"), stoppedAt: Millis });
const DoneReply = S.Struct({ ...ReplyCommon, stage: S.Literal("done"), at: Millis, questionId: S.String, replyId: S.String });
const StoppedReply = S.Struct({
  ...ReplyCommon, stage: S.Literal("stopped"), at: Millis, questionId: S.String,
  replyId: S.optional(S.String),
  by: S.Union([
    S.Struct({ who: S.Literal("person") }),
    S.Struct({ who: S.Literal("preempted"), neededBy: S.optional(S.String) }),
    S.Struct({ who: S.Literal("runtime") }),
    S.Struct({ who: S.Literal("closing") }),
  ]),
});
const FailedReply = S.Struct({
  ...ReplyCommon, stage: S.Literal("failed"), at: Millis,
  questionId: S.optional(S.String),
  code: S.String, message: S.String,
});

/** A removed message is not in the union: it is on no list. */
export const Reply = S.Union([QueuedReply, HeldReply, EditingReply, NextReply, StartingReply, LiveReply, DrawingReply, StoppingReply, DoneReply, StoppedReply, FailedReply]);
export type Reply = typeof Reply.Type;

/**
 * The one answer to every call that names a reply (reply.*), for a well-formed call that met the
 * record in some stage. A window changes its copy of a record only when the answer or a push
 * says so.
 */
export const ReplyAnswer = S.Union([
  S.Struct({ answer: S.Literal("done"), reply: Reply }),
  S.Struct({ answer: S.Literal("gone"), why: S.Literals(["sent", "removed", "chat-deleted", "unknown"]), question: S.optional(Message) }),
  S.Struct({ answer: S.Literal("sending"), reply: Reply }),
  S.Struct({ answer: S.Literal("elsewhere"), reply: Reply }),
]);
export type ReplyAnswer = typeof ReplyAnswer.Type;
/** What a caller gets back: the server's answer, or the client's word that there was none. The server never sends "not-reached". */
export type ReplyOutcome = ReplyAnswer | { readonly answer: "not-reached"; readonly why: "closed" | "timeout" };

/**
 * One record changed, or left (reply.changed). Always the whole record, numbered by the one
 * counter every record shares: a window keeps a record only when its `rev` is above the one it has.
 */
export const ReplyChange = S.Union([
  S.Struct({
    kind: S.Literal("is"),
    reply: Reply,
    // why: the saved rows come with the change, so no window reads the chat again to show them
    saved: S.optional(S.Array(Message)),
    // why: the chat's number once they were written; a window current before them is current at it
    chatNumber: S.optional(Count),
  }),
  S.Struct({ kind: S.Literal("left"), id: ReplyId, threadId: S.String, rev: Count, why: S.Literals(["removed", "chat-deleted", "settled"]) }),
]);
export type ReplyChange = typeof ReplyChange.Type;

/** The words a reply on its way has written so far. */
export const SoFar = S.Struct({ text: S.String, thinking: S.String, steps: S.Array(ToolStep) });
export type SoFar = typeof SoFar.Type;

/** One record of reply.list: a message waiting or a reply on its way, with its words so far. */
export const ReplyListed = S.Struct({ reply: Reply, soFar: S.optional(SoFar) });
export type ReplyListed = typeof ReplyListed.Type;

/**
 * Streamed words of one reply (reply.words). Text and thinking say where they start, so a window
 * that has them already, from the list or an earlier push, keeps only what is new.
 */
export const WordsPart = S.Union([
  S.Struct({ type: S.Literal("text"), from: Count, text: S.String }),
  S.Struct({ type: S.Literal("thinking"), from: Count, text: S.String }),
  S.Struct({ type: S.Literal("tool"), step: ToolStep }),
  // why: the server runs a failed reply once more; what the first try wrote is cleared
  S.Struct({ type: S.Literal("again") }),
]);
export type WordsPart = typeof WordsPart.Type;
export const StreamedWords = S.Struct({ id: ReplyId, part: WordsPart });
export type StreamedWords = typeof StreamedWords.Type;

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
  systemPrompt: S.optional(S.String),
  temperature: S.optional(decimalControl("temperature")),
  top_p: S.optional(decimalControl("top_p")),
  top_k: S.optional(integerControl("top_k")),
  repeat_penalty: S.optional(decimalControl("repeat_penalty")),
  seed: S.optional(integerControl("seed")),
  // external: Ollama's num_predict -1 is no limit and -2 fills the context
  num_predict: S.optional(ReplyLimit),
  // external: Ollama's keep_alive is seconds; 0 unloads at once, a negative value keeps it
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
  defaultModel: S.optional(S.String),
  defaultNumCtx: ContextSize,
  thinking: S.Boolean,
  theme: Theme,
  runtimeMode: RuntimeMode,
  tools: S.Boolean,
  imageGen: S.Boolean,
  imageChoice: S.optional(ImageChoice),
  imageTool: S.optional(S.Boolean),
  comfyUrl: S.optional(S.String),
  imageFolder: S.optional(S.String),
  whisperUrl: S.optional(S.String),
  updateEveryChange: S.optional(S.Boolean),
  updateAutomatic: S.optional(S.Boolean),
  accent: S.optional(Accent),
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
  imageTool: S.optional(S.NullOr(S.Boolean)),
  comfyUrl: S.optional(S.NullOr(S.String)),
  imageFolder: S.optional(S.NullOr(S.String)),
  whisperUrl: S.optional(S.NullOr(S.String)),
  updateEveryChange: S.optional(S.Boolean),
  updateAutomatic: S.optional(S.Boolean),
  accent: S.optional(Accent),
  systemPrompt: S.optional(S.NullOr(S.String)),
  modelSettings: S.optional(S.Null),
});
export type SettingsPatch = typeof SettingsPatch.Type;

export const GpuStatus = S.Struct({
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
  name: S.String,
  label: S.String,
  purpose: S.String,
  downloadBytes: Count,
  installed: S.Boolean,
  recommended: S.Boolean,
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
  tables: S.optional(S.Array(S.Struct({ name: S.String, rows: S.optional(Count) }))),
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
  addressSet: S.optional(S.Boolean),
  own: S.optional(S.Boolean),
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
  short: S.optional(S.String),
  family: S.String,
  group: S.optional(S.String),
  tier: S.optional(S.String),
  style: S.optional(S.String),
  model: S.optional(S.String),
  sizes: S.Array(ImageSize),
  measured: S.Boolean,
  needs: S.optional(S.Struct({
    files: S.Array(S.String), bytes: S.optional(Count), download: S.optional(S.Boolean),
    leftBytes: S.optional(Count),
  })),
  why: S.optional(S.String),
});
export type ImagePreset = typeof ImagePreset.Type;

/** One file of a setup's download (image.download): which setup, which file of how many, and its PullProgress. */
export const ImageDownload = S.Struct({
  ...PullProgress.fields,
  preset: S.String,
  file: S.Int,
  files: S.Int,
  setupCompletedBytes: S.optional(Count),
  setupTotalBytes: S.optional(Count),
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
  message: S.optional(S.String),
  toCard: S.optional(S.Literal(true)),
});
export type ImageSetupProgress = typeof ImageSetupProgress.Type;

/**
 * What Set up images would fetch on this computer, or why it cannot run here: the app's own
 * ComfyUI (the engine) and the recommended setup for this card, as one download.
 */
export const ImageSetup = S.Struct({
  why: S.optional(S.String),
  engine: S.optional(S.Struct({ version: S.String, bytes: Count, installed: S.Boolean })),
  model: S.optional(S.Struct({ preset: S.String, name: S.String, bytes: Count })),
  cpu: S.optional(S.Struct({ low: Count, high: Count })),
  freeBytes: S.optional(Count),
  needBytes: S.optional(Count),
  toCard: S.optional(S.Literal(true)),
  progress: S.optional(ImageSetupProgress),
});
export type ImageSetup = typeof ImageSetup.Type;

export const ImagePresets = S.Struct({
  presets: S.Array(ImagePreset),
  others: S.optional(S.Array(ImagePreset)),
  readAt: S.optional(Millis),
  current: S.Struct({ preset: ImagePreset, width: S.Int, height: S.Int }),
  noGpu: S.optional(S.String),
  slow: S.optional(S.String),
  unloadsChat: S.optional(S.Boolean),
  download: S.optional(ImageDownload),
  disk: S.optional(S.Struct({ folder: S.optional(S.String), freeBytes: S.optional(Count), picked: S.Boolean, line: S.optional(S.String) })),
});
export type ImagePresets = typeof ImagePresets.Type;

/** What `setup.probe` reads about this machine before it plans models. */
export const SetupProbe = S.Struct({
  os: S.Struct({ platform: S.String, release: S.String, arch: S.String }),
  cpu: S.Struct({ model: S.String, threads: PositiveInt }),
  memory: S.Struct({ totalBytes: Count, availableBytes: Count }),
  gpu: GpuStatus,
  diskFreeBytes: Count,
  ollama: S.NullOr(
    S.Struct({ baseUrl: S.String, version: S.String, owner: RuntimeOwner, models: S.Array(S.String) }),
  ),
  comfy: S.NullOr(
    S.Struct({
      baseUrl: S.String,
      owner: RuntimeOwner,
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

/** The version this copy runs, read from the clone's .git folder (no git process, no network). */
export const UpdateVersion = S.Union([
  S.Struct({ kind: S.Literal("release"), tag: S.String, commit: S.String, date: S.optional(Millis) }),
  S.Struct({ kind: S.Literal("commit"), commit: S.String, date: S.optional(Millis) }),
  S.Struct({ kind: S.Literal("not-a-clone") }),
  S.Struct({ kind: S.Literal("unreadable"), detail: S.String }),
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
    targetCommit: S.optional(S.String),
    total: Count,
    changes: S.Array(S.String),
    notes: S.optional(S.String),
  }),
  S.Struct({ state: S.Literal("cannot-check"), checkedAt: Millis, reason: UpdateBlocked, lines: S.Array(S.String), page: S.optional(S.String) }),
  S.Struct({
    state: S.Literal("newer"), checkedAt: Millis, current: S.String, target: S.String, forThisCopy: S.Boolean, lines: S.Array(S.String), page: S.String, download: S.optional(UpdateDownload),
    restart: S.optional(S.Boolean),
  }),
]);
export type UpdateCheck = typeof UpdateCheck.Type;

/** The last update run, shown once on the next start. */
export const UpdateResult = S.Struct({
  at: Millis,
  outcome: S.Literals(["updated", "rolled-back", "stopped", "rollback-failed", "refused"]),
  line: S.String,
  page: S.optional(S.String),
  logPath: S.optional(S.String),
  commands: S.optional(S.Array(S.String)),
});
export type UpdateResult = typeof UpdateResult.Type;

export const UpdateStatus = S.Struct({
  version: UpdateVersion,
  result: S.NullOr(UpdateResult),
  lastCheck: S.NullOr(UpdateCheck),
  activity: S.optional(S.Array(S.String)),
  approval: S.optional(S.String),
  installing: S.optional(S.Boolean),
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

/** One finished picture. Its job id is its card's message id. */
export const Picture = S.Struct({
  jobId: S.String,
  threadId: S.String,
  threadTitle: S.String,
  prompt: S.String,
  preset: S.optional(S.String),
  width: PositiveInt,
  height: PositiveInt,
  seed: S.optional(Count),
  steps: S.optional(PositiveInt),
  queuedAt: Millis,
  doneAt: Millis,
  runMs: S.optional(Count),
  bytes: Count,
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
