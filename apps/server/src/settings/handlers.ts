// settings.get, settings.update and the settings.changed push.
import type { HandlerContext, Handlers } from "../ws/server.ts";
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
    "settings.get": (_params?: object, ctx?: HandlerContext) => {
      const value = deps.settings.get();
      ctx?.capture?.([deps.settings.stamp(value)]);
      return value;
    },
    "settings.update": ({ voiceChange, ...patch }, ctx?: HandlerContext) => {
      const before = deps.settings.get();
      const next = deps.settings.update(patch);
      const changes = [deps.settings.stamp(next)];
      ctx?.capture?.(changes);
      if (next !== before || voiceChange !== undefined) deps.push("settings.changed", { ...next, ...(voiceChange === undefined ? {} : { voiceChange }) }, changes);
      return next;
    },
    "settings.model.update": ({ model, patch }, ctx?: HandlerContext) => {
      const before = deps.settings.get();
      const next = deps.settings.updateModel(model, patch);
      const changes = [deps.settings.stamp(next)];
      ctx?.capture?.(changes);
      if (next !== before) deps.push("settings.changed", next, changes);
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
