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

async function getDecoded<T>(baseUrl: string, route: string, timeoutMs: number, parse: (v: unknown) => { ok: true; value: T } | { ok: false; message: string }, signal?: AbortSignal): Promise<T> {
  const url = new URL(route, baseUrl).href;
  const r = await httpGet(url, timeoutMs, signal);
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

/** /api/ps; `signal` ends the read early (shutdown, a runtime switch). */
export async function listLoaded(baseUrl: string, timeoutMs = 5000, signal?: AbortSignal): Promise<LoadedModel[]> {
  const ps = await getDecoded(baseUrl, "/api/ps", timeoutMs, (v) => decode(PsResponse, v), signal);
  return ps.models.map((m): LoadedModel => {
    const l: LoadedModel = { name: m.name, sizeBytes: m.size, sizeVramBytes: m.size_vram };
    if (m.expires_at) l.expiresAt = m.expires_at;
    if (m.context_length !== undefined) l.contextLength = m.context_length;
    return l;
  });
}

const key = (models: readonly ModelInfo[]) => JSON.stringify(models);

type Refreshed = { models: readonly ModelInfo[]; changed: boolean };

export type ModelCatalog = {
  /** Last list seen; undefined before the first successful refresh. */
  current(): readonly ModelInfo[] | undefined;
  /**
   * Fetch from the runtime; emits models.changed only when the list differs.
   * Within minIntervalMs of the last real fetch from the same runtime, the
   * same result comes back without a new /api/tags call, unless forced
   * (a finished download or removal forces one).
   */
  refresh(options?: { force?: boolean }): Promise<Refreshed>;
  onChange(listener: Listener<readonly ModelInfo[]>): () => void;
};

export type ModelCatalogOptions = { timeoutMs?: number; minIntervalMs?: number; now?: () => number };

/** `baseUrl` is read on each refresh so the catalog follows runtime changes. */
export function createModelCatalog(baseUrl: () => string | undefined, options: number | ModelCatalogOptions = {}): ModelCatalog {
  const opts = typeof options === "number" ? { timeoutMs: options } : options;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const minIntervalMs = opts.minIntervalMs ?? 0;
  const now = opts.now ?? Date.now;
  let models: ModelInfo[] | undefined;
  let last: { at: number; url: string | undefined; result: Promise<Refreshed> } | undefined;
  const listeners = new Set<Listener<readonly ModelInfo[]>>();
  /** Bumped per fetch started; only the latest one, still for the current base URL, may set `models`. */
  let latest = 0;

  const fetchNow = async (url: string | undefined): Promise<Refreshed> => {
    const seq = ++latest;
    const next = url ? await listModels(url, timeoutMs) : [];
    // An older fetch (or one from the runtime before a switch) answers its own caller and changes nothing.
    if (seq !== latest || baseUrl() !== url) return { models: next, changed: false };
    const changed = models === undefined || key(models) !== key(next);
    models = next;
    if (changed) for (const l of listeners) l(next);
    return { models: next, changed };
  };

  return {
    current: () => models,
    refresh(how) {
      const url = baseUrl();
      if (how?.force !== true && last !== undefined && last.url === url && now() - last.at < minIntervalMs) return last.result;
      const result = fetchNow(url);
      last = { at: now(), url, result };
      // A failed fetch is not reused.
      result.catch(() => {
        if (last?.result === result) last = undefined;
      });
      return result;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
