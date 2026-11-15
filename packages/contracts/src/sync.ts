// Ordered data. The server numbers every change to a thing; every answer and push about it carries
// the number, and the window drops anything that is not newer than what it applied. A kind of data
// joins ORDERED_DOMAINS only once every place the server writes it is numbered: from then on the
// socket server refuses an answer or push of that kind without a number, and so does the client.
import * as S from "effect/Schema";

export const SyncDomain = S.Literals(["settings", "models", "threads", "turns", "sources", "images", "updates"]);
export type SyncDomain = typeof SyncDomain.Type;

/** The things that have one number each, and the families (`thread:<id>`) that have one per member. */
const FIXED_SCOPES = ["settings", "runtime", "models", "catalog", "threads", "gpu", "fit-inputs", "active-turns", "sources", "source-imports", "image-status", "update",
  "suggested", "fit-table", "pulls", "loads", "memory", "speeds", "measures", "image-presets", "image-download", "image-setup", "image-jobs"] as const;
export type FixedScope = typeof FIXED_SCOPES[number];

const Revision = S.Int.check(S.isGreaterThanOrEqualTo(0), S.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const Scope = S.String.check(S.isPattern(new RegExp(`^(?:${FIXED_SCOPES.join("|")}|(?:thread|turn|fit|pull|load|image):.+)$`)));
const Epoch = S.String.check(S.isMinLength(1));
export const SyncMetadata = S.Struct({
  epoch: Epoch,
  changes: S.Array(S.Union([
    S.Struct({ scope: Scope, kind: S.Literal("snapshot"), rev: Revision }),
    S.Struct({ scope: Scope, kind: S.Literal("patch"), baseRev: Revision, rev: Revision }),
    S.Struct({ scope: Scope, kind: S.Literal("invalidate"), rev: Revision }),
  ])),
});
export type SyncMetadata = typeof SyncMetadata.Type;
export type SyncChange = SyncMetadata["changes"][number];

export const SyncNegotiation = S.Struct({ epoch: Epoch, ordered: S.Array(SyncDomain) });
export type SyncNegotiation = typeof SyncNegotiation.Type;

/**
 * What a method row answers with, or a push row announces: the whole of one numbered thing. On a
 * connection that ordered `domain`, the answer or push must carry a snapshot number for `scope`.
 */
export interface SyncRow {
  readonly domain: SyncDomain;
  readonly scope: FixedScope;
  /** Other things the answer carries whole beside `scope`'s, each with its own number (the list's runtime). */
  readonly also?: readonly FixedScope[];
}

/** Every scope a frame of `row` carries a number for. */
export const scopesOf = (row: SyncRow): readonly FixedScope[] => [row.scope, ...row.also ?? []];

/**
 * Kinds the socket server numbers itself, in the order it gives them out: each push takes the
 * next number for its scope as it is sent, and each read takes one as it starts. A read gives the
 * owner's value as it is at or after its start, and a push goes out as its value becomes current,
 * so a higher number is never an older value. A part (one download's progress) takes the number of
 * the whole it belongs to (every download), so a read of the whole is ordered against its parts.
 */
export const SENT_IN_ORDER: readonly SyncDomain[] = ["models", "images"];

/** Only domains whose every writer is numbered; the socket server and the client enforce the rows of these. */
export const ORDERED_DOMAINS: readonly SyncDomain[] = ["settings", "models", "sources", "updates", "images"];

/** The one snapshot number `sync` gives `scope` in this epoch; undefined when it gives none, several, or another epoch's. */
export function revisionOf(sync: SyncMetadata | undefined, epoch: string, scope: FixedScope): number | undefined {
  if (sync?.epoch !== epoch) return undefined;
  const changes = sync.changes.filter(change => change.scope === scope);
  return changes.length === 1 && changes[0]?.kind === "snapshot" ? changes[0].rev : undefined;
}
