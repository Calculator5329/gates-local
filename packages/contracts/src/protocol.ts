// The wire protocol: envelopes, the method table, the push table and the
// boundary codecs both ends use. Decode functions never throw; a message
// that does not decode comes back as a WireError with a named code.
import * as Result from "effect/Result";
import * as S from "effect/Schema";
import { SyncDomain, SyncMetadata, SyncNegotiation } from "./sync.ts";
import {
  BlockingTurn,
  CatalogEntry,
  ChatEvent,
  FitTable,
  GpuStatus,
  ImageChoice,
  ImageCount,
  ImageEvent,
  ImageGroup,
  ImageDownload,
  ImagePresets,
  ImageStatus,
  ShellStatus,
  Message,
  ModelInfo,
  ModelSpeed,
  NumCtx,
  ModelLoad,
  PullProgress,
  RuntimeStatus,
  Settings,
  SetupPlan,
  SetupProbe,
  SettingsPatch,
  ModelDefaults,
  ModelSettingsPatch,
  PictureList,
  PictureListParams,
  Source,
  SourceKind,
  SourceImport,
  SourceImports,
  Thread,
  UpdateCheck,
  UpdateStatus,
  UpdatePreparation,
  UpdateCommitResult,
  UpdateCommitRequest,
} from "./shapes.ts";

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------- errors

/** Codes the protocol itself produces. Handlers may add their own codes. */
export type WireErrorCode =
  | "bad-message" // the envelope did not decode (bad JSON, wrong shape, binary frame)
  | "unknown-method" // the method is not in the method table
  | "bad-params" // the params did not decode against the method's params Schema
  | "bad-result" // a result did not match the method's result Schema
  | "bad-payload" // a push payload did not match the channel's payload Schema
  | "not-implemented" // the method is in the table but the server registered no handler
  | "internal" // a handler threw without a code
  | "timeout" // the client gave up waiting for a response
  | "closed"; // the socket closed before a response arrived

export class WireError extends Error {
  override readonly name = "WireError";
  readonly code: WireErrorCode | (string & {});
  /** For chat.send's "would-stop": the running turns in the way. */
  readonly blocking?: readonly BlockingTurn[];
  constructor(code: WireErrorCode | (string & {}), message: string, blocking?: readonly BlockingTurn[]) {
    super(message);
    this.code = code;
    if (blocking !== undefined) this.blocking = blocking;
  }
}

export type Decoded<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: WireError };

function check<T>(schema: S.Codec<T, unknown>, input: unknown, code: string, where: string): Decoded<T> {
  const r = S.decodeUnknownResult(schema)(input);
  return Result.isSuccess(r)
    ? { ok: true, value: r.success }
    : { ok: false, error: new WireError(code, `${where}: ${r.failure.message}`) };
}

function encodeWith(schema: S.Top, input: unknown, code: string, where: string): Decoded<unknown> {
  const r = S.encodeUnknownResult(schema as S.Codec<unknown, unknown>)(input);
  return Result.isSuccess(r)
    ? { ok: true, value: r.success }
    : { ok: false, error: new WireError(code, `${where}: ${r.failure.message}`) };
}

// ---------------------------------------------------------------- tables

const NoParams = S.Struct({});
const ThreadRef = S.Struct({ threadId: S.String });
const ModelRef = S.Struct({ name: S.String });
const SourceRef = S.Struct({ id: S.String });
/**
 * One UTC hour of one model: tokens in and out, replies begun, and summed times (ms) with the
 * tokens of the requests that reported them, so a speed is a ratio of sums. No text, thread or title.
 */
const UsageRow = S.Struct({
  hour: S.Finite, model: S.String, promptTokens: S.Finite, completionTokens: S.Finite, replies: S.Finite,
  decodeMs: S.Finite, decodeTokens: S.Finite, readMs: S.Finite, readTokens: S.Finite, wallMs: S.Finite,
});
const UsageRead = S.Struct({ rows: S.Array(UsageRow), models: S.Array(S.String) });

/**
 * "allow": the phone listener may call this method. "deny": only the computer may.
 * The phone is for chat: it reads threads, sends, stops, picks among installed
 * models, dictates and sees status. It cannot change the computer.
 */
export type PhoneAccess = "allow" | "deny";

/** A row must decide `phone`, so a new method without that decision does not typecheck. */
export interface MethodRow {
  readonly params: S.Top;
  readonly result: S.Top;
  readonly phone: PhoneAccess;
}

/** One definition for both ends: each method's params and result Schema, and whether the phone may call it. */
export const methods = {
  "sync.negotiate": { params: S.Struct({ ordered: S.Array(SyncDomain) }), result: SyncNegotiation, phone: "allow" },
  "voice.check": { params: S.Struct({ url: S.String }), result: S.Struct({ ready: S.Boolean }), phone: "allow" },
  "voice.transcribe": { params: S.Struct({ id: S.String, audio: S.String }), result: S.Struct({ text: S.String }), phone: "allow" },
  "voice.cancel": { params: S.Struct({ id: S.String }), result: NoParams, phone: "allow" },
  "threads.list": { params: NoParams, result: S.Array(Thread), phone: "allow" },
  "threads.create": { params: S.Struct({ title: S.optional(S.String) }), result: Thread, phone: "allow" },
  "threads.get": { params: ThreadRef, result: S.Struct({ thread: Thread, messages: S.Array(Message) }), phone: "allow" },
  "threads.rename": { params: S.Struct({ threadId: S.String, title: S.String }), result: Thread, phone: "allow" },
  /** The picker's pick in an open thread: that thread sends with it from now on; other threads keep theirs. */
  "threads.setImageChoice": { params: S.Struct({ threadId: S.String, choice: ImageChoice }), result: Thread, phone: "allow" },
  /** The Image-mode count menu's pick in an open thread: its sends make this many pictures from now on. */
  "threads.setImageCount": { params: S.Struct({ threadId: S.String, count: ImageCount }), result: Thread, phone: "allow" },
  "threads.delete": { params: ThreadRef, result: S.Struct({ threadId: S.String }), phone: "deny" },
  "messages.delete": { params: S.Struct({ threadId: S.String, messageId: S.String }), result: S.Struct({ messageId: S.String }), phone: "deny" },
  "models.list": { params: NoParams, result: S.Array(ModelInfo), phone: "allow" },
  "models.refresh": { params: NoParams, result: S.Array(ModelInfo), phone: "allow" },
  "runtime.status": { params: NoParams, result: RuntimeStatus, phone: "allow" },
  /** Look for Ollama again now (start the app's own copy where it may) and answer the new status; runtime.status only reads the cached one. */
  "runtime.retry": { params: NoParams, result: RuntimeStatus, phone: "deny" },
  /** Look for an Ollama that came back; starts and installs nothing, and a ready status stays as it is. The phone's Retry. */
  "runtime.discover": { params: NoParams, result: RuntimeStatus, phone: "allow" },
  /** The server's current fit table (built now if it has none); fit.changed pushes each newer one. */
  "fit.table": { params: NoParams, result: FitTable, phone: "allow" },
  "chat.send": {
    phone: "allow",
    params: S.Struct({
      threadId: S.String,
      content: S.String,
      model: S.String,
      numCtx: NumCtx,
      /** A new send chooses its saved user-message id; retries reuse it. */
      messageId: S.optional(S.String.check(S.isMaxLength(200))),
      /** Retry: the question this send repeats. It goes, with the unfinished words after it, so the thread does not ask twice. */
      retryOf: S.optional(S.String.check(S.isMaxLength(200))),
      /** Up to eight pasted image data URLs (10 MiB each), or this thread's saved user-image paths for Retry. */
      images: S.optional(S.Array(S.String).check(S.isMaxLength(8))),
      /** Thinking for this turn; omitted means the settings default. */
      think: S.optional(S.Boolean),
      /** Tool calls for this turn; omitted means the settings default. */
      tools: S.optional(S.Boolean),
      /**
       * Older clients' Image button. Accepted and ignored: a chat model is offered the image
       * tool only when Settings › Tools › Make images is on (settings.imageTool).
       */
      image: S.optional(S.Boolean),
      /**
       * Image mode: `content` is the prompt of one image job with this preset and size. No chat
       * model runs; `model` and `numCtx` are not used. The turn ends when the job does; its card
       * is the reply. Refused with attachments or while image generation is off.
       */
      draw: S.optional(ImageChoice),
      /**
       * With draw: how many pictures this send makes (1 to 4), one job after another with seeds
       * one apart, shown as tiles of one card. The thread keeps it for its next sends. Omitted: the
       * thread's saved count, else 1.
       */
      drawCount: S.optional(ImageCount),
      /**
       * When this turn's load needs GPU memory a model with a running turn holds (turns.blocking),
       * end those turns first: each saves its partial reply and ends with error code "preempted"
       * (neededBy: this model). Omitted or false: this turn waits for them, as before.
       */
      stopOthers: S.optional(S.Boolean),
      /**
       * With stopOthers: the turns the person agreed to stop (BlockingTurn.turnId). Only these
       * stop; if the load needs any other, the send is refused with code "would-stop" and every
       * turn it would need in `blocking`, so the next yes covers them all. Omitted: standing
       * consent, any turn in the way stops.
       */
      stopTurns: S.optional(S.Array(S.String)),
      /**
       * A person is waiting on this send: when such turns are in the way, refuse with code
       * "would-stop" and the turns in the error's `blocking`, instead of waiting behind them.
       * The client warns and sends again with stopOthers. Ignored with stopOthers.
       */
      askFirst: S.optional(S.Boolean),
    }),
    result: S.Struct({ turnId: S.String, userMessage: Message, replayed: S.optional(S.Boolean) }),
  },
  /** Authoritative running replies when a client connects or reconnects; later changes use chat.event. */
  "turns.active": {
    params: NoParams,
    result: S.Array(S.Struct({ turnId: S.String, threadId: S.String })),
    phone: "allow",
  },
  /**
   * The running turns that would have to stop for `model` at `numCtx` to load as the fit plans
   * it; empty when none (same model, or it fits beside them). Reads only; never loads.
   */
  "turns.blocking": {
    params: S.Struct({ model: S.String, numCtx: NumCtx }),
    result: S.Array(BlockingTurn),
    phone: "allow",
  },
  "chat.cancel": { params: S.Struct({ turnId: S.String }), result: S.Struct({ cancelled: S.Boolean }), phone: "allow" },
  // ---- v2 surface (2026-11-07): settings, GPU, downloads, Library, images
  "settings.get": { params: NoParams, result: Settings, phone: "allow" },
  "settings.update": { params: S.Struct({ ...SettingsPatch.fields, voiceChange: S.optional(S.String.check(S.isMaxLength(128))) }), result: Settings, phone: "deny" },
  "settings.model.update": { params: S.Struct({ model: S.String.check(S.isMinLength(1)), patch: S.NullOr(ModelSettingsPatch) }), result: Settings, phone: "deny" },
  "settings.modelDefaults": { params: S.Struct({ model: S.String.check(S.isMinLength(1)) }), result: ModelDefaults, phone: "allow" },
  "gpu.status": { params: NoParams, result: GpuStatus, phone: "allow" },
  "models.catalog": { params: NoParams, result: S.Array(CatalogEntry), phone: "allow" },
  /** Download jobs still known to the server; reconnect reconciles missed terminal pushes. */
  "models.pulls": { params: NoParams, result: S.Array(PullProgress), phone: "allow" },
  "models.pull": { params: ModelRef, result: PullProgress, phone: "deny" },
  "models.cancelPull": { params: ModelRef, result: S.Struct({ cancelled: S.Boolean }), phone: "deny" },
  "models.remove": { params: ModelRef, result: ModelRef, phone: "deny" },
  /** Preload a model at a window after a fit check (the picker calls it on selection). */
  "models.load": { params: S.Struct({ model: S.String, numCtx: NumCtx }), result: ModelLoad, phone: "allow" },
  /** Each model's measured speed from saved replies (ModelSpeed); later changes come on the models.speed push. */
  "models.speed": { params: NoParams, result: S.Array(ModelSpeed), phone: "allow" },
  "sources.list": { params: NoParams, result: S.Array(Source), phone: "allow" },
  "sources.add": { params: S.Struct({ kind: SourceKind, path: S.String, label: S.optional(S.String) }), result: Source, phone: "deny" },
  "sources.remove": { params: SourceRef, result: SourceRef, phone: "deny" },
  "sources.refresh": { params: SourceRef, result: Source, phone: "deny" },
  "sources.imports": { params: NoParams, result: SourceImports, phone: "allow" },
  "sources.downloadSample": { params: SourceRef, result: SourceImport, phone: "deny" },
  "sources.clone": { params: S.Struct({ url: S.String }), result: SourceImport, phone: "deny" },
  "sources.cancelImport": { params: SourceRef, result: S.Struct({ cancelled: S.Boolean }), phone: "deny" },
  "image.status": { params: NoParams, result: ImageStatus, phone: "allow" },
  /** Whether Run commands can run here: the sandbox probe, asked again when it last failed (Settings › Tools). */
  "tools.shell": { params: NoParams, result: ShellStatus, phone: "allow" },
  /** The presets ComfyUI has every file for, read from ComfyUI (or its last answer when it is not running). */
  "image.presets": { params: NoParams, result: ImagePresets, phone: "allow" },
  "image.generate": {
    /** `choice` omitted: Settings' imageChoice. A retry runs its failed job's choice. */
    params: S.Struct({
      prompt: S.String, threadId: S.optional(S.String), retryOf: S.optional(S.String), choice: S.optional(ImageChoice),
      /** Image mode's several pictures from one send (chat.send drawCount): the card's tile. */
      group: S.optional(ImageGroup),
      /** The seed to run; omitted: a random one. */
      seed: S.optional(S.Int.check(S.isBetween({ minimum: 0, maximum: 2 ** 32 - 1 }))),
    }),
    result: S.Struct({ jobId: S.String }),
    phone: "allow",
  },
  "image.cancel": { params: S.Struct({ jobId: S.String }), result: S.Struct({ cancelled: S.Boolean }), phone: "allow" },
  /** Download the files a setup needs into ComfyUI's model folders; progress on the image.download push. */
  "image.download": { params: S.Struct({ preset: S.String }), result: S.Struct({ files: S.Array(S.String) }), phone: "deny" },
  /** Stop that setup's download; the part already fetched is kept, and the next image.download resumes it. */
  "image.stopDownload": { params: S.Struct({ preset: S.String }), result: S.Struct({ stopped: S.Boolean }), phone: "deny" },
  /** Start ComfyUI with no job (the picker's Start ComfyUI) and answer what it has; the idle stop still applies. */
  "image.start": { params: NoParams, result: ImagePresets, phone: "deny" },
  /** The Pictures screen: finished pictures, newest first, a page at a time. */
  "pictures.list": { params: PictureListParams, result: PictureList, phone: "allow" },
  // ---- setup (2026-11-07): read the machine, then plan models for it
  "setup.probe": { params: NoParams, result: SetupProbe, phone: "deny" },
  "setup.plan": { params: S.Struct({ images: S.optional(S.Boolean) }), result: SetupPlan, phone: "deny" },
  // ---- updates: status is local only; check fetches (manual or desktop timer)
  "update.status": { params: NoParams, result: UpdateStatus, phone: "allow" },
  "update.check": { params: NoParams, result: UpdateCheck, phone: "deny" },
  "update.prepare": { params: S.Struct({ approval: S.String }), result: UpdatePreparation, phone: "deny" },
  "update.commit": { params: UpdateCommitRequest, result: UpdateCommitResult, phone: "deny" },
  "update.cancel": { params: S.Struct({ reservation: S.String }), result: S.Struct({ cancelled: S.Boolean }), phone: "deny" },
  "update.dismissResult": { params: NoParams, result: S.Struct({ dismissed: S.Boolean }), phone: "deny" },
  // An installed copy's Download click (automatic checks off): fetch and check the newer version; never installs.
  "update.download": { params: NoParams, result: UpdateCheck, phone: "deny" },
  // ---- usage (2026-11-11): token counts per UTC hour and model from `since` (ms) on; models in first-use order
  "usage.read": { params: S.Struct({ since: S.Finite }), result: UsageRead, phone: "allow" },
} as const satisfies Record<string, MethodRow>;

/** Server-to-client channels and their payload Schemas. */
export const pushes = {
  "update.changed": { payload: UpdateStatus },
  "chat.event": { payload: S.Struct({ turnId: S.String, threadId: S.String, event: ChatEvent }) },
  "runtime.changed": { payload: RuntimeStatus },
  "models.changed": { payload: S.Array(ModelInfo) },
  "threads.changed": { payload: ThreadRef },
  // ---- v2 surface (2026-11-07)
  // Transient provenance, never persisted in Settings. A client can distinguish
  // its older save completing from a new action in another window.
  "settings.changed": { payload: S.Struct({ ...Settings.fields, voiceChange: S.optional(S.String.check(S.isMaxLength(128))) }) },
  "gpu.changed": { payload: GpuStatus },
  /** A newer fit table: after a GPU reading moves, the model list changes, a load ends, a model unloads, or a turn starts or ends. */
  "fit.changed": { payload: FitTable },
  /** One per progress step of every download, until done, error or cancelled. */
  "models.pull": { payload: PullProgress },
  "models.load": { payload: ModelLoad },
  /** The whole list again, after a finished reply or a deletion changed what it counts. */
  "models.speed": { payload: S.Array(ModelSpeed) },
  "sources.changed": { payload: S.Array(Source) },
  "sources.imports": { payload: SourceImports },
  "image.status": { payload: ImageStatus },
  "image.event": { payload: ImageEvent },
  /** A model file image.download is fetching: its setup, its place in the list, its progress. */
  "image.download": { payload: ImageDownload },
  /** A model request finished and was counted; usage.read has the new numbers. */
  "usage.changed": { payload: S.Struct({}) },
} as const;

export type Methods = typeof methods;
export type MethodName = keyof Methods;
export type Params<M extends MethodName> = Methods[M]["params"]["Type"];
export type ResultOf<M extends MethodName> = Methods[M]["result"]["Type"];

export type Pushes = typeof pushes;
export type Channel = keyof Pushes;
export type Payload<C extends Channel> = Pushes[C]["payload"]["Type"];

export const methodNames = Object.keys(methods) as MethodName[];
export const channelNames = Object.keys(pushes) as Channel[];

/** The table's answer for the phone listener; the server and the phone client both read it here. */
export const phoneMay = (method: MethodName): boolean => methods[method].phone === "allow";

function isMethod(name: string): name is MethodName {
  return Object.hasOwn(methods, name);
}
function isChannel(name: string): name is Channel {
  return Object.hasOwn(pushes, name);
}

// ---------------------------------------------------------------- envelopes

export const RequestEnvelope = S.Struct({
  type: S.Literal("request"),
  id: S.String,
  method: S.String,
  params: S.Unknown,
});

export const ErrorBody = S.Struct({ code: S.String, message: S.String, blocking: S.optional(S.Array(BlockingTurn)) });

export const ResponseOkEnvelope = S.Struct({
  type: S.Literal("response"),
  id: S.String,
  ok: S.Literal(true),
  result: S.Unknown,
  sync: S.optional(SyncMetadata),
});
export const ResponseErrEnvelope = S.Struct({
  type: S.Literal("response"),
  id: S.String,
  ok: S.Literal(false),
  error: ErrorBody,
  sync: S.optional(SyncMetadata),
});
export const PushEnvelope = S.Struct({
  type: S.Literal("push"),
  channel: S.String,
  payload: S.Unknown,
  sync: S.optional(SyncMetadata),
});
export const ServerEnvelope = S.Union([ResponseOkEnvelope, ResponseErrEnvelope, PushEnvelope]);

/** A request after full decode: the method is known and its params decoded. */
export type DecodedRequest = { [M in MethodName]: { readonly id: string; readonly method: M; readonly params: Params<M> } }[MethodName];

export type RequestRefusal = { readonly ok: false; readonly error: WireError; readonly id?: string };

function parseJson(raw: unknown): Decoded<unknown> {
  if (typeof raw !== "string") return { ok: false, error: new WireError("bad-message", "frame is not text") };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch (e) {
    return { ok: false, error: new WireError("bad-message", `not JSON: ${(e as Error).message}`) };
  }
}

/** Best-effort id from a message whose envelope failed, so the refusal can be answered. */
function salvageId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

/** Server side: decode one inbound text frame down to a typed request. Never throws. */
export function decodeRequest(raw: unknown): { readonly ok: true; readonly value: DecodedRequest } | RequestRefusal {
  const json = parseJson(raw);
  if (!json.ok) return json;
  const env = check(RequestEnvelope, json.value, "bad-message", "request envelope");
  if (!env.ok) {
    const id = salvageId(json.value);
    return id === undefined ? env : { ...env, id };
  }
  const { id, method, params } = env.value;
  if (!isMethod(method)) return { ok: false, id, error: new WireError("unknown-method", `unknown method "${method}"`) };
  const p = check(methods[method].params as S.Codec<unknown, unknown>, params, "bad-params", `${method} params`);
  if (!p.ok) return { ok: false, id, error: p.error };
  return { ok: true, value: { id, method, params: p.value } as DecodedRequest };
}

export function encodeRequest<M extends MethodName>(id: string, method: M, params: Params<M>): Decoded<string> {
  if (!isMethod(method)) return { ok: false, error: new WireError("unknown-method", `unknown method "${String(method)}"`) };
  const p = encodeWith(methods[method].params, params, "bad-params", `${method} params`);
  if (!p.ok) return p;
  return { ok: true, value: JSON.stringify({ type: "request", id, method, params: p.value }) };
}

export function encodeResult<M extends MethodName>(id: string, method: M, result: ResultOf<M>, sync?: SyncMetadata): Decoded<string> {
  if (!isMethod(method)) return { ok: false, error: new WireError("unknown-method", `unknown method "${String(method)}"`) };
  const r = encodeWith(methods[method].result, result, "bad-result", `${method} result`);
  if (!r.ok) return r;
  const metadata = sync === undefined ? { ok: true as const, value: undefined } : encodeWith(SyncMetadata, sync, "bad-result", "response synchronization");
  if (!metadata.ok) return metadata;
  return { ok: true, value: JSON.stringify({ type: "response", id, ok: true, result: r.value, ...(sync === undefined ? {} : { sync: metadata.value }) }) };
}

export function encodeErrorResponse(id: string, code: string, message: string, blocking?: readonly BlockingTurn[]): string {
  return JSON.stringify({ type: "response", id, ok: false, error: { code, message, ...(blocking === undefined ? {} : { blocking }) } });
}

export function encodePush<C extends Channel>(channel: C, payload: Payload<C>, sync?: SyncMetadata): Decoded<string> {
  if (!isChannel(channel)) return { ok: false, error: new WireError("bad-payload", `unknown channel "${String(channel)}"`) };
  const p = encodeWith(pushes[channel].payload, payload, "bad-payload", `${channel} payload`);
  if (!p.ok) return p;
  const metadata = sync === undefined ? { ok: true as const, value: undefined } : encodeWith(SyncMetadata, sync, "bad-payload", "push synchronization");
  if (!metadata.ok) return metadata;
  return { ok: true, value: JSON.stringify({ type: "push", channel, payload: p.value, ...(sync === undefined ? {} : { sync: metadata.value }) }) };
}

export type ServerMessage = typeof ServerEnvelope.Type;

/** Client side: decode the envelope of one inbound frame. Results and payloads decode later, by method or channel. */
export function decodeServerMessage(raw: unknown): Decoded<ServerMessage> {
  const json = parseJson(raw);
  if (!json.ok) return json;
  return check(ServerEnvelope, json.value, "bad-message", "server envelope");
}

export function decodeResult<M extends MethodName>(method: M, result: unknown): Decoded<ResultOf<M>> {
  if (!isMethod(method)) return { ok: false, error: new WireError("unknown-method", `unknown method "${String(method)}"`) };
  return check(methods[method].result as S.Codec<ResultOf<M>, unknown>, result, "bad-result", `${method} result`);
}

export function decodePayload(channel: string, payload: unknown): Decoded<{ channel: Channel; payload: unknown }> {
  if (!isChannel(channel)) return { ok: false, error: new WireError("bad-payload", `unknown channel "${channel}"`) };
  const p = check(pushes[channel].payload as S.Codec<unknown, unknown>, payload, "bad-payload", `${channel} payload`);
  return p.ok ? { ok: true, value: { channel, payload: p.value } } : p;
}
