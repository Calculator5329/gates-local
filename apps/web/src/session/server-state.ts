import type { State } from "../store.ts";
import { settingsRevision, type ClientSync, type Settings, type SyncMetadata } from "@gates-local/contracts";

export interface SettingsAuthority {
  begin(sync: ClientSync | undefined): void;
  accept(settings: Settings, sync: SyncMetadata): { previous: Settings | undefined } | undefined;
  current(): Settings | undefined;
}

/** A legacy receipt or accepted projection, applied in its current JavaScript task. */
export type ServerEvent = Partial<State> | ((state: State) => Partial<State> | void);

/** No queue, promise or batching: domain guards and existing application points stay in place. */
export function createServerState(read: () => State, publish: (patch: Partial<State>) => void) {
  let epoch: string | undefined;
  let revision = -1;
  let current: Settings | undefined;
  const authority: SettingsAuthority = {
    begin(sync) {
      const next = sync?.mode === "ordered" && sync.domains.includes("settings") ? sync.epoch : undefined;
      if (next === epoch) return;
      epoch = next; revision = -1; current = undefined;
    },
    accept(settings, metadata) {
      const next = epoch === undefined ? undefined : settingsRevision(metadata, epoch);
      if (next === undefined || next <= revision) return;
      const previous = current;
      revision = next; current = settings;
      return { previous };
    },
    current: () => current,
  };
  function applyServerEvent(event: ServerEvent): void {
    const patch = typeof event === "function" ? event(read()) : event;
    if (patch !== undefined) publish(patch);
  }
  return Object.assign(applyServerEvent, { settings: authority });
}
