// Model list straight from the runtime. No settings step: whatever the
// running Ollama has is what the picker shows. refresh() runs on window focus
// (wiring adds the trigger) and emits only when the list actually changed.
import { httpGet } from "./http.ts";
import { PsResponse, TagsResponse, decode, parseJson } from "./schemas.ts";
import type { Listener, LoadedModel, ModelInfo } from "./types.ts";

export class RuntimeResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeResponseError";
  }
}

async function getDecoded<T>(baseUrl: string, route: string, timeoutMs: number, parse: (v: unknown) => { ok: true; value: T } | { ok: false; message: string }): Promise<T> {
  const url = new URL(route, baseUrl).href;
  const r = await httpGet(url, timeoutMs);
  if (r.kind !== "response") throw new RuntimeResponseError(`GET ${url} failed: ${r.kind === "error" ? r.code : r.kind}`);
  if (r.status !== 200) throw new RuntimeResponseError(`GET ${url} gave HTTP ${r.status}`);
  const json = parseJson(r.body);
  if (!json.ok) throw new RuntimeResponseError(`GET ${url} did not return JSON`);
  const d = parse(json.value);
  if (!d.ok) throw new RuntimeResponseError(`GET ${url} returned an unexpected shape: ${d.message}`);
  return d.value;
}

export async function listModels(baseUrl: string, timeoutMs = 5000): Promise<ModelInfo[]> {
  const tags = await getDecoded(baseUrl, "/api/tags", timeoutMs, (v) => decode(TagsResponse, v));
  return tags.models
    .map((m): ModelInfo => {
      const info: ModelInfo = { name: m.name, digest: m.digest, sizeBytes: m.size, modifiedAt: m.modified_at };
      if (m.details?.family) info.family = m.details.family;
      if (m.details?.parameter_size) info.parameterSize = m.details.parameter_size;
      if (m.details?.quantization_level) info.quantization = m.details.quantization_level;
      return info;
    })
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

export async function listLoaded(baseUrl: string, timeoutMs = 5000): Promise<LoadedModel[]> {
  const ps = await getDecoded(baseUrl, "/api/ps", timeoutMs, (v) => decode(PsResponse, v));
  return ps.models.map((m): LoadedModel => {
    const l: LoadedModel = { name: m.name, sizeBytes: m.size, sizeVramBytes: m.size_vram };
    if (m.expires_at) l.expiresAt = m.expires_at;
    return l;
  });
}

const key = (models: readonly ModelInfo[]) => JSON.stringify(models);

export type ModelCatalog = {
  /** Last list seen; undefined before the first successful refresh. */
  current(): readonly ModelInfo[] | undefined;
  /** Fetch from the runtime; emits models.changed only when the list differs. */
  refresh(): Promise<{ models: readonly ModelInfo[]; changed: boolean }>;
  onChange(listener: Listener<readonly ModelInfo[]>): () => void;
};

/** `baseUrl` is read on each refresh so the catalog follows runtime changes. */
export function createModelCatalog(baseUrl: () => string | undefined, timeoutMs = 5000): ModelCatalog {
  let models: ModelInfo[] | undefined;
  const listeners = new Set<Listener<readonly ModelInfo[]>>();
  return {
    current: () => models,
    async refresh() {
      const url = baseUrl();
      const next = url ? await listModels(url, timeoutMs) : [];
      const changed = models === undefined || key(models) !== key(next);
      models = next;
      if (changed) for (const l of listeners) l(next);
      return { models: next, changed };
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
