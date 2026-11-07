// models.catalog, models.pull, models.cancelPull, models.remove and
// models.load. models.list and models.refresh stay in app.ts (slice 1).
import type { FitDeps } from "../fit/fit.ts";
import type { SettingsReader } from "../settings/store.ts";
import type { Handlers } from "../ws/server.ts";
import { buildCatalog } from "./catalog.ts";
import { ModelActionError, type ModelLoader } from "./load.ts";
import type { ModelCatalog } from "./models.ts";
import type { PullManager } from "./pull.ts";

export interface RuntimeHandlerDeps {
  readonly baseUrl: () => string | undefined;
  readonly catalog: ModelCatalog;
  readonly settings: Pick<SettingsReader, "get">;
  readonly pulls: PullManager;
  readonly loader: ModelLoader;
  readonly fit?: Omit<FitDeps, "baseUrl">;
  readonly log?: (line: string) => void;
}

/** DELETE /api/delete. Ollama answers 404 with a JSON error for an unknown name. */
async function deleteModel(baseUrl: string, name: string): Promise<void> {
  const res = await fetch(new URL("/api/delete", baseUrl), {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: name }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.ok) return;
  const text = await res.text().catch(() => "");
  let message = text || `HTTP ${res.status}`;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string") message = parsed.error;
  } catch {
    // keep the raw text
  }
  throw new ModelActionError("remove-failed", `Could not remove ${name}: ${message}`);
}

export function createRuntimeHandlers(deps: RuntimeHandlerDeps) {
  const installed = async () => deps.catalog.current() ?? (await deps.catalog.refresh()).models;
  const ready = () => {
    const baseUrl = deps.baseUrl();
    if (baseUrl === undefined) throw new ModelActionError("runtime-not-ready", "Ollama is not running.");
    return baseUrl;
  };

  return {
    "models.catalog": () =>
      buildCatalog({
        baseUrl: deps.baseUrl,
        installed,
        settings: deps.settings,
        ...(deps.fit ? { fit: deps.fit } : {}),
        ...(deps.log ? { log: deps.log } : {}),
      }),
    "models.pull": ({ name }) => deps.pulls.pull(name),
    "models.cancelPull": ({ name }) => ({ cancelled: deps.pulls.cancel(name) }),
    "models.remove": async ({ name }) => {
      const baseUrl = ready();
      if (deps.loader.inUse(name)) {
        throw new ModelActionError("model-in-use", `${name} is answering in a chat right now. Stop that reply or wait for it to finish, then remove the model.`);
      }
      await deleteModel(baseUrl, name);
      await deps.catalog.refresh({ force: true });
      return { name };
    },
    "models.load": ({ model, numCtx }) => deps.loader.load(model, numCtx),
  } satisfies Partial<Handlers>;
}
