import { AttachedFile, BlockingTurn, FitOffer, ImageChoice, ImageCount } from "@gates-local/contracts";
import * as S from "effect/Schema";

export const SavedEntry = S.Struct({
  id: S.String.check(S.isMinLength(1), S.isMaxLength(200)),
  threadId: S.String,
  messageId: S.String.check(S.isMinLength(1), S.isMaxLength(200)),
  text: S.String,
  images: S.optional(S.Array(S.String).check(S.isMaxLength(8))),
  files: S.optional(S.Array(AttachedFile).check(S.isMaxLength(8))),
  at: S.Finite,
  waitFor: S.Literals(["setup", "download", "reply"]),
  model: S.optional(S.String),
  numCtx: S.optional(S.Int.check(S.isGreaterThan(0))),
  think: S.optional(S.Boolean),
  draw: S.optional(ImageChoice),
  drawCount: S.optional(ImageCount),
  held: S.optional(S.Literal(true)),
  retry: S.optional(S.Literals(["running", "failed"])),
  now: S.optional(S.Literal(true)),
  stopOthers: S.optional(S.Literal(true)),
  stopTurns: S.optional(S.Array(S.String).check(S.isMaxLength(32))),
  editing: S.optional(S.Literal(true)),
  sending: S.optional(S.String),
  why: S.optional(S.Struct({ code: S.String, message: S.String, blocking: S.optional(S.Array(BlockingTurn)), offer: S.optional(FitOffer) })),
});
export type SavedEntry = typeof SavedEntry.Type;
