import { suggestedList } from "@gates-local/contracts";
import type { FitDeps } from "../fit/fit.ts";
import { chatList } from "./chat-list.ts";
import type { SettingsReader } from "../settings/store.ts";
import type { Handlers } from "../ws/server.ts";
import { buildCatalog, estimateTyped } from "./catalog.ts";
import type { RegistryLookup } from "./registry-size.ts";
import { ModelActionError, type ModelLoader } from "./load.ts";
import type { ModelCatalog } from "./models.ts";
import type { PullManager } from "./pull.ts";
import { parseJson } from "./schemas.ts";

export interface RuntimeHandlerDeps {
  readonly baseUrl: () => string | undefined;
  readonly catalog: ModelCatalog;
  readonly settings: Pick<SettingsReader, "get">;
  readonly pulls: PullManager;
  readonly loader: ModelLoader;
  readonly fit?: Omit<FitDeps, "baseUrl">;
  readonly lookup?: (name: string, signal: AbortSignal) => Promise<RegistryLookup>;
  readonly log?: (line: string) => void;
}

async function deleteModel(baseUrl: string, name: string): Promise<void> {
  const res = await fetch(new URL("/api/delete", baseUrl), {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: name }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.ok) return;
  const text = await res.text().catch(() => "");
  const parsed = parseJson(text);
  const error = parsed.ok ? (parsed.value as { error?: unknown } | null)?.error : undefined;
  const message = typeof error === "string" ? error : text || `HTTP ${res.status}`;
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
    "models.suggested": () => suggestedList(chatList()),
    "models.estimate": ({ name, numCtx }) =>
      estimateTyped({ ...(deps.lookup ? { lookup: deps.lookup } : {}), ...(deps.fit ? { fit: deps.fit } : {}) }, name, numCtx, AbortSignal.timeout(10_000)),
    "models.pulls": () => deps.pulls.pending(),
    "models.pull": ({ name }) => {
      ready();
      return deps.pulls.pull(name);
    },
    "models.cancelPull": ({ name }) => ({ cancelled: deps.pulls.cancel(name) }),
    "models.remove": async ({ name }) => {
      const baseUrl = ready();
      const done = deps.loader.beginRemove(name);
      try {
        await deleteModel(baseUrl, name);
      } finally {
        done();
      }
      await deps.catalog.refresh({ force: true });
      return { name };
    },
    "models.load": ({ model, numCtx, typed }) => deps.loader.load(model, numCtx, typed === true ? { typed } : {}),
  } satisfies Partial<Handlers>;
}
