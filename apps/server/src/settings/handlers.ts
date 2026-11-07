// settings.get, settings.update and the settings.changed push.
import type { Handlers } from "../ws/server.ts";
import type { Push } from "../app.ts";
import type { SettingsStore } from "./store.ts";

export interface SettingsHandlerDeps {
  readonly settings: SettingsStore;
  readonly push: Push;
}

export function createSettingsHandlers(deps: SettingsHandlerDeps) {
  return {
    "settings.get": () => deps.settings.get(),
    "settings.update": (patch) => {
      const before = deps.settings.get();
      const next = deps.settings.update(patch);
      if (next !== before) deps.push("settings.changed", next);
      return next;
    },
  } satisfies Partial<Handlers>;
}
