// The wire protocol: envelopes, the method table, the push table and the
// boundary codecs both ends use. Decode functions never throw; a message
// that does not decode comes back as a WireError with a named code.
import { Result, Schema as S } from "effect";
import {
  CatalogEntry,
  ChatEvent,
  FitReport,
  GpuStatus,
  ImageEvent,
  ImageStatus,
  Message,
  ModelInfo,
  NumCtx,
  ModelLoad,
  PullProgress,
  RuntimeStatus,
  Settings,
  SettingsPatch,
  Source,
  SourceKind,
  Thread,
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
  constructor(code: WireErrorCode | (string & {}), message: string) {
    super(message);
    this.code = code;
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

/** One definition for both ends: each method's params and result Schema. */
export const methods = {
  "threads.list": { params: NoParams, result: S.Array(Thread) },
  "threads.create": { params: S.Struct({ title: S.optional(S.String) }), result: Thread },
  "threads.get": { params: ThreadRef, result: S.Struct({ thread: Thread, messages: S.Array(Message) }) },
  "threads.rename": { params: S.Struct({ threadId: S.String, title: S.String }), result: Thread },
  "threads.delete": { params: ThreadRef, result: S.Struct({ threadId: S.String }) },
  "models.list": { params: NoParams, result: S.Array(ModelInfo) },
  "models.refresh": { params: NoParams, result: S.Array(ModelInfo) },
  "runtime.status": { params: NoParams, result: RuntimeStatus },
  "fit.check": { params: S.Struct({ model: S.String, numCtx: NumCtx }), result: FitReport },
  "chat.send": {
    params: S.Struct({
      threadId: S.String,
      content: S.String,
      model: S.String,
      numCtx: NumCtx,
      /** Thinking for this turn; omitted means the settings default. */
      think: S.optional(S.Boolean),
      /** Tool calls for this turn; omitted means the settings default. */
      tools: S.optional(S.Boolean),
      /** The model may make an image this turn (needs image generation set up). */
      image: S.optional(S.Boolean),
    }),
    result: S.Struct({ turnId: S.String, userMessage: Message }),
  },
  "chat.cancel": { params: S.Struct({ turnId: S.String }), result: S.Struct({ cancelled: S.Boolean }) },
  // ---- v2 surface (2026-11-07): settings, GPU, downloads, Library, images
  "settings.get": { params: NoParams, result: Settings },
  "settings.update": { params: SettingsPatch, result: Settings },
  "gpu.status": { params: NoParams, result: GpuStatus },
  "models.catalog": { params: NoParams, result: S.Array(CatalogEntry) },
  "models.pull": { params: ModelRef, result: PullProgress },
  "models.cancelPull": { params: ModelRef, result: S.Struct({ cancelled: S.Boolean }) },
  "models.remove": { params: ModelRef, result: ModelRef },
  /** Preload a model at a window after a fit check (the picker calls it on selection). */
  "models.load": { params: S.Struct({ model: S.String, numCtx: NumCtx }), result: ModelLoad },
  "sources.list": { params: NoParams, result: S.Array(Source) },
  "sources.add": { params: S.Struct({ kind: SourceKind, path: S.String, label: S.optional(S.String) }), result: Source },
  "sources.remove": { params: SourceRef, result: SourceRef },
  "sources.refresh": { params: SourceRef, result: Source },
  "image.status": { params: NoParams, result: ImageStatus },
  "image.generate": {
    params: S.Struct({ prompt: S.String, threadId: S.optional(S.String) }),
    result: S.Struct({ jobId: S.String }),
  },
  "image.cancel": { params: S.Struct({ jobId: S.String }), result: S.Struct({ cancelled: S.Boolean }) },
} as const;

/** Server-to-client channels and their payload Schemas. */
export const pushes = {
  "chat.event": { payload: S.Struct({ turnId: S.String, threadId: S.String, event: ChatEvent }) },
  "runtime.changed": { payload: RuntimeStatus },
  "models.changed": { payload: S.Array(ModelInfo) },
  "threads.changed": { payload: ThreadRef },
  // ---- v2 surface (2026-11-07)
  "settings.changed": { payload: Settings },
  "gpu.changed": { payload: GpuStatus },
  /** One per progress step of every download, until done, error or cancelled. */
  "models.pull": { payload: PullProgress },
  "models.load": { payload: ModelLoad },
  "sources.changed": { payload: S.Array(Source) },
  "image.status": { payload: ImageStatus },
  "image.event": { payload: ImageEvent },
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

export const ErrorBody = S.Struct({ code: S.String, message: S.String });

export const ResponseOkEnvelope = S.Struct({
  type: S.Literal("response"),
  id: S.String,
  ok: S.Literal(true),
  result: S.Unknown,
});
export const ResponseErrEnvelope = S.Struct({
  type: S.Literal("response"),
  id: S.String,
  ok: S.Literal(false),
  error: ErrorBody,
});
export const PushEnvelope = S.Struct({
  type: S.Literal("push"),
  channel: S.String,
  payload: S.Unknown,
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

export function encodeResult<M extends MethodName>(id: string, method: M, result: ResultOf<M>): Decoded<string> {
  if (!isMethod(method)) return { ok: false, error: new WireError("unknown-method", `unknown method "${String(method)}"`) };
  const r = encodeWith(methods[method].result, result, "bad-result", `${method} result`);
  if (!r.ok) return r;
  return { ok: true, value: JSON.stringify({ type: "response", id, ok: true, result: r.value }) };
}

export function encodeErrorResponse(id: string, code: string, message: string): string {
  return JSON.stringify({ type: "response", id, ok: false, error: { code, message } });
}

export function encodePush<C extends Channel>(channel: C, payload: Payload<C>): Decoded<string> {
  if (!isChannel(channel)) return { ok: false, error: new WireError("bad-payload", `unknown channel "${String(channel)}"`) };
  const p = encodeWith(pushes[channel].payload, payload, "bad-payload", `${channel} payload`);
  if (!p.ok) return p;
  return { ok: true, value: JSON.stringify({ type: "push", channel, payload: p.value }) };
}

export type ServerMessage =
  | { readonly type: "response"; readonly id: string; readonly ok: true; readonly result: unknown }
  | { readonly type: "response"; readonly id: string; readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
  | { readonly type: "push"; readonly channel: string; readonly payload: unknown };

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
