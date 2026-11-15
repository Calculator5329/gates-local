import type { State } from "../store/store.ts";
import { revisionOf, type ClientSync, type FixedScope, type Settings, type SyncDomain, type SyncMetadata, type SyncRow } from "@gates-local/contracts";

/**
 * The window's side of ordered data: the last number it applied per thing. A value applies only
 * when its number is newer; a new server process (a new epoch) forgets every number.
 */
export interface Ordering {
  /** After each negotiation. Returns true when the numbers were forgotten. */
  begin(sync: ClientSync | undefined): boolean;
  /** This connection ordered `domain`: its answers and pushes carry numbers. */
  ordered(domain: SyncDomain): boolean;
  /** True, and remembered, when `metadata` numbers `row`'s thing newer than the last applied. */
  accept(row: SyncRow, metadata: SyncMetadata | undefined): boolean;
  /** True while `metadata`'s number for `row`'s thing is still the last one applied: nothing newer came since it was accepted. */
  newest(row: SyncRow, metadata: SyncMetadata | undefined): boolean;
}

export interface SettingsAuthority {
  begin(sync: ClientSync | undefined): void;
  accept(settings: Settings, sync: SyncMetadata): { previous: Settings | undefined } | undefined;
  current(): Settings | undefined;
}

/** A legacy receipt or accepted projection, applied in its current JavaScript task. */
export type ServerEvent = Partial<State> | ((state: State) => Partial<State> | void);

export function createOrdering(): Ordering {
  let epoch: string | undefined;
  let domains: readonly SyncDomain[] = [];
  const applied = new Map<FixedScope, number>();
  return {
    begin(sync) {
      domains = sync?.mode === "ordered" ? sync.domains : [];
      const next = sync?.mode === "ordered" ? sync.epoch : undefined;
      if (next === epoch) return false;
      epoch = next; applied.clear();
      return true;
    },
    ordered: domain => epoch !== undefined && domains.includes(domain),
    accept(row, metadata) {
      if (epoch === undefined || !domains.includes(row.domain)) return false;
      const next = revisionOf(metadata, epoch, row.scope);
      if (next === undefined || next <= (applied.get(row.scope) ?? -1)) return false;
      applied.set(row.scope, next);
      return true;
    },
    newest(row, metadata) {
      const rev = epoch === undefined ? undefined : revisionOf(metadata, epoch, row.scope);
      return rev !== undefined && applied.get(row.scope) === rev;
    },
  };
}

const SETTINGS_ROW: SyncRow = { domain: "settings", scope: "settings" };

/** No queue, promise or batching: each kind's accepted value is applied in the task it arrived in. */
export function createServerState(read: () => State, publish: (patch: Partial<State>) => void) {
  const ordering = createOrdering();
  let current: Settings | undefined;
  const authority: SettingsAuthority = {
    begin(sync) {
      if (ordering.begin(sync)) current = undefined;
    },
    accept(settings, metadata) {
      if (!ordering.accept(SETTINGS_ROW, metadata)) return;
      const previous = current;
      current = settings;
      return { previous };
    },
    current: () => current,
  };
  function applyServerEvent(event: ServerEvent): void {
    const patch = typeof event === "function" ? event(read()) : event;
    if (patch !== undefined) publish(patch);
  }
  return Object.assign(applyServerEvent, { settings: authority, ordering });
}
