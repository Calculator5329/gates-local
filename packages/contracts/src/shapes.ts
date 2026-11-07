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

export const Message = S.Struct({
  id: S.String,
  threadId: S.String,
  role: Role,
  content: S.String,
  thinking: S.optional(S.String),
  model: S.optional(S.String),
  createdAt: Millis,
  stats: S.optional(MessageStats),
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
  detail: S.optional(S.String),
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
});
export type FitReport = typeof FitReport.Type;

export const ChatEvent = S.Union([
  S.Struct({ type: S.Literal("delta"), text: S.String }),
  S.Struct({ type: S.Literal("thinking"), text: S.String }),
  S.Struct({ type: S.Literal("done"), message: Message }),
  S.Struct({ type: S.Literal("error"), code: S.String, message: S.String }),
]);
export type ChatEvent = typeof ChatEvent.Type;

export const NumCtx = PositiveInt;
