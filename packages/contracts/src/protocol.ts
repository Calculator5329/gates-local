import * as Result from "effect/Result";
import * as S from "effect/Schema";
import { SyncDomain, SyncMetadata, SyncNegotiation, type SyncRow } from "./sync.ts";
import { SuggestedList } from "./chat-models.ts";
import {
  AttachedFile,
  BlockingTurn,
  CatalogEntry,
  ModelEstimate,
  ReplyAnswer,
  ReplyChange,
  ReplyId,
  ReplyListed,
  ReplySaid,
  StreamedWords,
  StopConsent,
  type FitOffer,
  FitTable,
  GpuStatus,
  ImageChoice,
  ImageCount,
  ImageEvent,
  ImageGroup,
  ImageDownload,
  ImagePresets,
  ImageSetup,
  ImageSetupProgress,
  ImageStatus,
  ShellStatus,
  Message,
  ModelInfo,
  ModelSpeed,
  ModelMeasure,
  MeasureList,
  MeasureRun,
  PageSeen,
  ThreadPage,
  NumCtx,
  MemoryState,
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
  UpdateStatus,
  UpdatePreparation,
  UpdateCommitResult,
  UpdateCommitRequest,
} from "./shapes.ts";

export const PROTOCOL_VERSION = 2;

/** Codes the protocol itself produces. Handlers may add their own codes. */
export type WireErrorCode =
  | "bad-message"
  | "unknown-method"
  | "bad-params"
  | "bad-result"
  | "bad-payload"
  | "not-implemented"
  // why: a page and a server from different releases; the page offers a reload
  | "other-version"
  | "internal"
  | "timeout"
  | "closed";

export class WireError extends Error {
  override readonly name = "WireError";
  readonly code: WireErrorCode | (string & {});
  readonly blocking?: readonly BlockingTurn[];
  readonly offer?: FitOffer;
  constructor(code: WireErrorCode | (string & {}), message: string, blocking?: readonly BlockingTurn[], offer?: FitOffer) {
    super(message);
    this.code = code;
    if (blocking !== undefined) this.blocking = blocking;
    if (offer !== undefined) this.offer = offer;
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

const NoParams = S.Struct({});
const ModelList = S.Struct({ runtime: RuntimeStatus, models: S.Array(ModelInfo) });
const ThreadRef = S.Struct({ threadId: S.String });
const ModelRef = S.Struct({ name: S.String });
const SourceRef = S.Struct({ id: S.String });
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
  readonly sync?: SyncRow;
}

/** A push channel: its payload, and when the payload is the whole of one numbered thing, which. */
export interface PushRow {
  readonly payload: S.Top;
  readonly sync?: SyncRow;
}

const SETTINGS: SyncRow = { domain: "settings", scope: "settings" };
const SOURCES: SyncRow = { domain: "sources", scope: "sources" };
const SOURCE_IMPORTS: SyncRow = { domain: "sources", scope: "source-imports" };
const UPDATE: SyncRow = { domain: "updates", scope: "update" };
const RUNTIME: SyncRow = { domain: "models", scope: "runtime" };
const MODELS: SyncRow = { domain: "models", scope: "models" };
const MODEL_LIST: SyncRow = { domain: "models", scope: "models", also: ["runtime"] };
const CATALOG: SyncRow = { domain: "models", scope: "catalog" };
const SUGGESTED: SyncRow = { domain: "models", scope: "suggested" };
const GPU: SyncRow = { domain: "models", scope: "gpu" };
const FIT_TABLE: SyncRow = { domain: "models", scope: "fit-table" };
const PULLS: SyncRow = { domain: "models", scope: "pulls" };
const LOADS: SyncRow = { domain: "models", scope: "loads" };
const MEMORY: SyncRow = { domain: "models", scope: "memory" };
const SPEEDS: SyncRow = { domain: "models", scope: "speeds" };
const MEASURES: SyncRow = { domain: "models", scope: "measures" };
const IMAGE_STATUS: SyncRow = { domain: "images", scope: "image-status" };
const IMAGE_PRESETS_READ: SyncRow = { domain: "images", scope: "image-presets", also: ["image-download"] };
const IMAGE_PRESETS: SyncRow = { domain: "images", scope: "image-presets" };
const IMAGE_DOWNLOAD: SyncRow = { domain: "images", scope: "image-download" };
const IMAGE_SETUP: SyncRow = { domain: "images", scope: "image-setup" };
const IMAGE_JOBS: SyncRow = { domain: "images", scope: "image-jobs" };
const THREADS: SyncRow = { domain: "threads", scope: "threads" };
const CHAT: SyncRow = { domain: "threads", scope: "threads", member: "thread" };

/** One definition for both ends: each method's params and result Schema, and whether the phone may call it. */
export const methods = {
  "sync.negotiate": { params: S.Struct({ ordered: S.Array(SyncDomain) }), result: SyncNegotiation, phone: "allow" },
  "voice.check": { params: S.Struct({ url: S.String }), result: S.Struct({ ready: S.Boolean }), phone: "allow" },
  "voice.transcribe": { params: S.Struct({ id: S.String, audio: S.String }), result: S.Struct({ text: S.String }), phone: "allow" },
  "voice.cancel": { params: S.Struct({ id: S.String }), result: NoParams, phone: "allow" },
  "threads.list": { params: NoParams, result: S.Array(Thread), phone: "allow", sync: THREADS },
  "threads.create": { params: S.Struct({ title: S.optional(S.String) }), result: Thread, phone: "allow", sync: THREADS },
  "threads.get": {
    params: S.Struct({ threadId: S.String, before: S.optional(S.String), limit: S.optional(S.Int.check(S.isBetween({ minimum: 1, maximum: 100_000 }))) }),
    result: S.Struct({ thread: Thread, messages: S.Array(Message), earlier: S.optional(S.Int) }),
    phone: "allow",
    sync: CHAT,
  },
  "threads.pages": { params: S.Struct({ threadId: S.String, before: S.optional(S.String) }), result: S.Array(ThreadPage), phone: "allow" },
  "threads.rename": { params: S.Struct({ threadId: S.String, title: S.String }), result: Thread, phone: "allow", sync: THREADS },
  "threads.setImageChoice": { params: S.Struct({ threadId: S.String, choice: ImageChoice }), result: Thread, phone: "allow", sync: THREADS },
  "threads.setImageCount": { params: S.Struct({ threadId: S.String, count: ImageCount }), result: Thread, phone: "allow", sync: THREADS },
  "threads.delete": { params: ThreadRef, result: S.Struct({ threadId: S.String }), phone: "deny", sync: THREADS },
  "messages.delete": { params: S.Struct({ threadId: S.String, messageId: S.String }), result: S.Struct({ messageId: S.String }), phone: "deny" },
  "files.attach": {
    params: S.Struct({ name: S.String.check(S.isMinLength(1), S.isMaxLength(255)), type: S.String.check(S.isMaxLength(200)), data: S.String }),
    result: AttachedFile,
    phone: "allow",
  },
  "files.keep": {
    params: S.Struct({ paths: S.Array(S.String.check(S.isMaxLength(200))).check(S.isMaxLength(512)) }),
    result: S.Struct({ missing: S.Array(S.String) }),
    phone: "allow",
  },
  "files.release": {
    params: S.Struct({ paths: S.Array(S.String.check(S.isMaxLength(200))).check(S.isMaxLength(64)) }),
    result: NoParams,
    phone: "allow",
  },
  "models.list": { params: NoParams, result: ModelList, phone: "allow", sync: MODEL_LIST },
  "models.refresh": { params: NoParams, result: ModelList, phone: "allow", sync: MODEL_LIST },
  "runtime.status": { params: NoParams, result: RuntimeStatus, phone: "allow", sync: RUNTIME },
  "runtime.retry": { params: NoParams, result: RuntimeStatus, phone: "deny", sync: RUNTIME },
  "runtime.discover": { params: NoParams, result: RuntimeStatus, phone: "allow", sync: RUNTIME },
  "fit.table": { params: NoParams, result: FitTable, phone: "allow", sync: FIT_TABLE },
  "turns.blocking": {
    params: S.Struct({ model: S.String, numCtx: NumCtx }),
    result: S.Array(BlockingTurn),
    phone: "allow",
  },
  "reply.send": {
    params: S.Struct({
      id: ReplyId,
      threadId: S.String,
      ...ReplySaid,
      // why: a person is waiting, so refuse rather than wait behind another chat's reply
      askFirst: S.optional(S.Boolean),
      consent: S.optional(StopConsent),
      // why: a page's own queue from before the server kept one moves here on hold, never sent unasked
      held: S.optional(S.Literal(true)),
    }),
    result: ReplyAnswer,
    phone: "allow",
  },
  "reply.change": {
    params: S.Struct({
      id: ReplyId,
      base: S.String.check(S.isMinLength(1), S.isMaxLength(200)),
      messageId: S.String.check(S.isMinLength(1), S.isMaxLength(200)),
      text: S.optional(S.String),
      images: S.optional(S.Array(S.String).check(S.isMaxLength(8))),
      files: S.optional(S.Array(AttachedFile).check(S.isMaxLength(8))),
      model: S.optional(S.String),
      numCtx: S.optional(NumCtx),
    }),
    result: ReplyAnswer,
    phone: "allow",
  },
  "reply.edit": { params: S.Struct({ id: ReplyId, open: S.Boolean }), result: ReplyAnswer, phone: "allow" },
  "reply.remove": { params: S.Struct({ id: ReplyId }), result: ReplyAnswer, phone: "allow" },
  "reply.now": { params: S.Struct({ id: ReplyId, consent: S.optional(StopConsent) }), result: ReplyAnswer, phone: "allow" },
  "reply.hold": { params: S.Struct({ id: ReplyId }), result: ReplyAnswer, phone: "allow" },
  "reply.stop": { params: S.Struct({ id: ReplyId }), result: ReplyAnswer, phone: "allow" },
  "reply.list": { params: NoParams, result: S.Array(ReplyListed), phone: "allow" },
  "settings.get": { params: NoParams, result: Settings, phone: "allow", sync: SETTINGS },
  "settings.update": { params: S.Struct({ ...SettingsPatch.fields, voiceChange: S.optional(S.String.check(S.isMaxLength(128))) }), result: Settings, phone: "deny", sync: SETTINGS },
  "settings.model.update": { params: S.Struct({ model: S.String.check(S.isMinLength(1)), patch: S.NullOr(ModelSettingsPatch) }), result: Settings, phone: "deny", sync: SETTINGS },
  "settings.modelDefaults": { params: S.Struct({ model: S.String.check(S.isMinLength(1)) }), result: ModelDefaults, phone: "allow" },
  "gpu.status": { params: NoParams, result: GpuStatus, phone: "allow", sync: GPU },
  "memory.status": { params: NoParams, result: MemoryState, phone: "allow", sync: MEMORY },
  "models.catalog": { params: NoParams, result: S.Array(CatalogEntry), phone: "allow", sync: CATALOG },
  "models.suggested": { params: NoParams, result: SuggestedList, phone: "allow", sync: SUGGESTED },
  "models.estimate": { params: S.Struct({ name: S.String.check(S.isMinLength(1)), numCtx: NumCtx }), result: ModelEstimate, phone: "allow" },
  "models.pulls": { params: NoParams, result: S.Array(PullProgress), phone: "allow", sync: PULLS },
  "models.pull": { params: ModelRef, result: PullProgress, phone: "deny" },
  "models.cancelPull": { params: ModelRef, result: S.Struct({ cancelled: S.Boolean }), phone: "deny" },
  "models.remove": { params: ModelRef, result: ModelRef, phone: "deny" },
  "models.load": { params: S.Struct({ model: S.String, numCtx: NumCtx }), result: ModelLoad, phone: "allow" },
  "models.speed": { params: NoParams, result: S.Array(ModelSpeed), phone: "allow", sync: SPEEDS },
  "models.measures": { params: NoParams, result: MeasureList, phone: "allow", sync: MEASURES },
  "models.measure": { params: ModelRef, result: MeasureRun, phone: "deny" },
  "models.measurePages": { params: S.Struct({ model: S.String, at: S.Finite, pages: S.Array(PageSeen) }), result: ModelMeasure, phone: "deny" },
  "models.measurePagesClaim": { params: S.Struct({ model: S.String, at: S.Finite }), result: S.Struct({ claimed: S.Boolean }), phone: "deny" },
  "sources.list": { params: NoParams, result: S.Array(Source), phone: "allow", sync: SOURCES },
  "sources.add": { params: S.Struct({ kind: SourceKind, path: S.String, label: S.optional(S.String) }), result: Source, phone: "deny" },
  "sources.remove": { params: SourceRef, result: SourceRef, phone: "deny" },
  "sources.refresh": { params: SourceRef, result: Source, phone: "deny" },
  "sources.imports": { params: NoParams, result: SourceImports, phone: "allow", sync: SOURCE_IMPORTS },
  "sources.downloadSample": { params: SourceRef, result: SourceImport, phone: "deny" },
  "sources.clone": { params: S.Struct({ url: S.String }), result: SourceImport, phone: "deny" },
  "sources.cancelImport": { params: SourceRef, result: S.Struct({ cancelled: S.Boolean }), phone: "deny" },
  "image.status": { params: NoParams, result: ImageStatus, phone: "allow", sync: IMAGE_STATUS },
  "tools.shell": { params: NoParams, result: ShellStatus, phone: "allow" },
  "image.presets": { params: NoParams, result: ImagePresets, phone: "allow", sync: IMAGE_PRESETS_READ },
  "image.generate": {
    params: S.Struct({
      prompt: S.String, threadId: S.optional(S.String), retryOf: S.optional(S.String), choice: S.optional(ImageChoice),
      group: S.optional(ImageGroup),
      seed: S.optional(S.Int.check(S.isBetween({ minimum: 0, maximum: 2 ** 32 - 1 }))),
    }),
    result: S.Struct({ jobId: S.String }),
    phone: "allow",
  },
  "image.cancel": { params: S.Struct({ jobId: S.String }), result: S.Struct({ cancelled: S.Boolean }), phone: "allow" },
  "image.download": { params: S.Struct({ preset: S.String }), result: S.Struct({ files: S.Array(S.String) }), phone: "deny" },
  "image.stopDownload": { params: S.Struct({ preset: S.String }), result: S.Struct({ stopped: S.Boolean }), phone: "deny" },
  "image.start": { params: NoParams, result: ImagePresets, phone: "deny", sync: IMAGE_PRESETS_READ },
  "image.setupInfo": { params: NoParams, result: ImageSetup, phone: "allow", sync: IMAGE_SETUP },
  "image.setup": { params: NoParams, result: S.Struct({ started: S.Boolean }), phone: "deny" },
  "pictures.list": { params: PictureListParams, result: PictureList, phone: "allow" },
  "setup.probe": { params: NoParams, result: SetupProbe, phone: "deny" },
  "setup.plan": { params: S.Struct({ images: S.optional(S.Boolean) }), result: SetupPlan, phone: "deny" },
  "update.status": { params: NoParams, result: UpdateStatus, phone: "allow", sync: UPDATE },
  "update.check": { params: NoParams, result: UpdateStatus, phone: "deny", sync: UPDATE },
  "update.prepare": { params: S.Struct({ approval: S.String }), result: UpdatePreparation, phone: "deny" },
  "update.commit": { params: UpdateCommitRequest, result: UpdateCommitResult, phone: "deny" },
  "update.cancel": { params: S.Struct({ reservation: S.String }), result: S.Struct({ cancelled: S.Boolean }), phone: "deny" },
  "update.dismissResult": { params: NoParams, result: UpdateStatus, phone: "deny", sync: UPDATE },
  "update.download": { params: NoParams, result: UpdateStatus, phone: "deny", sync: UPDATE },
  "usage.read": { params: S.Struct({ since: S.Finite }), result: UsageRead, phone: "allow" },
} as const satisfies Record<string, MethodRow>;

/** Server-to-client channels and their payload Schemas. */
export const pushes = {
  "update.changed": { payload: UpdateStatus, sync: UPDATE },
  "reply.changed": { payload: ReplyChange },
  "reply.words": { payload: StreamedWords },
  "runtime.changed": { payload: RuntimeStatus, sync: RUNTIME },
  "models.changed": { payload: S.Array(ModelInfo), sync: MODELS },
  "models.suggested": { payload: SuggestedList, sync: SUGGESTED },
  "threads.changed": { payload: S.Struct({ threadId: S.String, thread: S.NullOr(Thread) }), sync: CHAT },
  "settings.changed": { payload: S.Struct({ ...Settings.fields, voiceChange: S.optional(S.String.check(S.isMaxLength(128))) }), sync: SETTINGS },
  "gpu.changed": { payload: GpuStatus, sync: GPU },
  "fit.changed": { payload: FitTable, sync: FIT_TABLE },
  "models.pull": { payload: PullProgress, sync: PULLS },
  "models.load": { payload: ModelLoad, sync: LOADS },
  "memory.changed": { payload: MemoryState, sync: MEMORY },
  "models.speed": { payload: S.Array(ModelSpeed), sync: SPEEDS },
  "models.measures": { payload: S.Array(ModelMeasure), sync: MEASURES },
  "models.measuring": { payload: MeasureRun, sync: MEASURES },
  "sources.changed": { payload: S.Array(Source), sync: SOURCES },
  "sources.imports": { payload: SourceImports, sync: SOURCE_IMPORTS },
  "image.status": { payload: ImageStatus, sync: IMAGE_STATUS },
  "image.presets": { payload: ImagePresets, sync: IMAGE_PRESETS },
  "image.event": { payload: ImageEvent, sync: IMAGE_JOBS },
  "image.download": { payload: ImageDownload, sync: IMAGE_DOWNLOAD },
  "image.setup": { payload: ImageSetupProgress, sync: IMAGE_SETUP },
  "usage.changed": { payload: S.Struct({}) },
} as const satisfies Record<string, PushRow>;

export type Methods = typeof methods;
export type MethodName = keyof Methods;
export type Params<M extends MethodName> = Methods[M]["params"]["Type"];
export type ResultOf<M extends MethodName> = Methods[M]["result"]["Type"];
/** The calls that name one reply and are answered with what happened to it (ReplyAnswer). */
export type ReplyCall = { [M in MethodName]: M extends `reply.${string}` ? (ResultOf<M> extends ReplyAnswer ? M : never) : never }[MethodName];

export type Pushes = typeof pushes;
export type Channel = keyof Pushes;
export type Payload<C extends Channel> = Pushes[C]["payload"]["Type"];

export const methodNames = Object.keys(methods) as MethodName[];
export const channelNames = Object.keys(pushes) as Channel[];

/** The table's answer for the phone listener; the server and the phone client both read it here. */
export const phoneMay = (method: MethodName): boolean => methods[method].phone === "allow";

/** The numbered thing a method answers with, from its row; both ends enforce it for ordered domains. */
export const methodSync = (method: MethodName): SyncRow | undefined => (methods[method] as MethodRow).sync;
/** The numbered thing a push carries, from its row. */
export const pushSync = (channel: Channel): SyncRow | undefined => (pushes[channel] as PushRow).sync;

function isMethod(name: string): name is MethodName {
  return Object.hasOwn(methods, name);
}
function isChannel(name: string): name is Channel {
  return Object.hasOwn(pushes, name);
}

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
