// settings.get, settings.update and the settings.changed push.
import type { Handlers } from "../ws/server.ts";
import type { Push } from "../app.ts";
import type { SettingsStore } from "./store.ts";
import { fetchShow } from "../fit/ollama.ts";

export interface SettingsHandlerDeps {
  readonly settings: SettingsStore;
  readonly push: Push;
  readonly baseUrl?: () => string | undefined;
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
    "settings.model.update": ({ model, patch }) => {
      const before = deps.settings.get();
      const next = deps.settings.updateModel(model, patch);
      if (next !== before) deps.push("settings.changed", next);
      return next;
    },
    "settings.modelDefaults": async ({ model }) => {
      const baseUrl = deps.baseUrl?.();
      if (baseUrl === undefined) throw new Error("Ollama is not running. Start it to read this model's defaults.");
      const show = await fetchShow(baseUrl, model);
      return { system: show.system ?? "", parameters: show.parameters ?? "" };
    },
  } satisfies Partial<Handlers>;
}
