// Optional synchronization envelopes. Domains opt in only after all their writers are versioned.
import * as S from "effect/Schema";

export const SyncDomain = S.Literals(["settings", "models", "threads", "turns", "sources", "images", "updates"]);
export type SyncDomain = typeof SyncDomain.Type;

const Revision = S.Int.check(S.isGreaterThanOrEqualTo(0), S.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const Scope = S.String.check(S.isPattern(/^(?:settings|runtime|models|catalog|threads|gpu|fit-inputs|active-turns|sources|source-imports|image-status|update|(?:thread|turn|fit|pull|load|image):.+)$/));
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

/** Only domains whose complete writer and acceptance paths have migrated. */
export const ORDERED_DOMAINS: readonly SyncDomain[] = ["settings"];

export const settingsSnapshotMethod = (method: string) =>
  method === "settings.get" || method === "settings.update" || method === "settings.model.update";

/** A full settings contribution has one unambiguous stamp in the negotiated epoch. */
export function settingsRevision(sync: SyncMetadata | undefined, epoch: string): number | undefined {
  if (sync?.epoch !== epoch) return undefined;
  const changes = sync.changes.filter(change => change.scope === "settings");
  return changes.length === 1 && changes[0]?.kind === "snapshot" ? changes[0].rev : undefined;
}
