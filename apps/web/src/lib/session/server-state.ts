import type { State } from "../store/store.ts";
import { revisionOf, type ClientSync, type FixedScope, type Settings, type SyncMetadata, type SyncRow } from "@gates-local/contracts";

export interface Ordering {
  begin(sync: ClientSync): boolean;
  accept(row: SyncRow, metadata: SyncMetadata | undefined): boolean;
  newest(row: SyncRow, metadata: SyncMetadata | undefined): boolean;
}

export interface SettingsAuthority {
  begin(sync: ClientSync): void;
  accept(settings: Settings, sync: SyncMetadata): { previous: Settings | undefined } | undefined;
  current(): Settings | undefined;
}

export type ServerEvent = Partial<State> | ((state: State) => Partial<State> | void);

export function createOrdering(): Ordering {
  let epoch: string | undefined;
  const applied = new Map<FixedScope, number>();
  return {
    begin(sync) {
      if (sync.epoch === epoch) return false;
      epoch = sync.epoch; applied.clear();
      return true;
    },
    accept(row, metadata) {
      if (epoch === undefined) return false;
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
