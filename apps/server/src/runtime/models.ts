// Model list straight from the runtime. No settings step: whatever the
// running Ollama has is what the picker shows. refresh() runs on window focus
// (wiring adds the trigger) and emits only when the list actually changed.
// Each model carries its /api/show capabilities (cached by digest) and the
// one chat starts on carries the pick (runtime/pick.ts).
import { fetchShow } from "../fit/ollama.ts";
import { httpGet } from "./http.ts";
import type { ChatPick } from "./pick.ts";
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

/** Capabilities by digest. A digest names exact weights, so its capabilities never change. */
export type CapabilityCache = Map<string, readonly string[]>;

/**
 * A guess for when /api/show fails or is too old to list capabilities: the
 * same name-and-family heuristic the catalog used before capabilities were
 * read. Not cached, so the next refresh asks /api/show again.
 */
export const guessCapabilities = (m: { name: string; family?: string }): readonly string[] =>
  /embed/i.test(m.name) || /bert/i.test(m.family ?? "") ? ["embedding"] : ["completion"];

async function capabilitiesOf(baseUrl: string, m: ModelInfo, timeoutMs: number, cache: CapabilityCache | undefined): Promise<readonly string[]> {
  const known = cache?.get(m.digest);
  if (known) return known;
  try {
    const show = await fetchShow(baseUrl, m.name, AbortSignal.timeout(timeoutMs));
    if (show.capabilities === undefined) return guessCapabilities(m);
    cache?.set(m.digest, show.capabilities);
    return show.capabilities;
  } catch {
    return guessCapabilities(m);
  }
}

export async function listModels(baseUrl: string, timeoutMs = 5000, cache?: CapabilityCache): Promise<ModelInfo[]> {
  const tags = await getDecoded(baseUrl, "/api/tags", timeoutMs, (v) => decode(TagsResponse, v));
  const models = tags.models
    .map((m): ModelInfo => {
      const info: ModelInfo = { name: m.name, digest: m.digest, sizeBytes: m.size, modifiedAt: m.modified_at, capabilities: [] };
      if (m.details?.family) info.family = m.details.family;
      if (m.details?.parameter_size) info.parameterSize = m.details.parameter_size;
      if (m.details?.quantization_level) info.quantization = m.details.quantization_level;
      return info;
    })
    .toSorted((a, b) => a.name.localeCompare(b.name));
  // One /api/show per digest not seen before, all at once.
  const caps = await Promise.all(models.map((m) => capabilitiesOf(baseUrl, m, timeoutMs, cache)));
  return models.map((m, i) => ({ ...m, capabilities: caps[i] ?? [] }));
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

export type ModelCatalogOptions = {
  timeoutMs?: number;
  minIntervalMs?: number;
  now?: () => number;
  /**
   * The chat pick (runtime/pick.ts with the fit check and settings bound).
   * Runs when the installed list or pickKey() changes; a pick with a
   * verdict is reused until then, so the starting model stays put while the
   * GPU's free memory moves. Without it no model carries a pick.
   */
  pick?: (models: readonly ModelInfo[], baseUrl: string) => Promise<ChatPick | undefined>;
  /** The settings the pick depends on, as a string; a change re-runs the pick on the next refresh. */
  pickKey?: () => string;
  log?: (line: string) => void;
};

/** `baseUrl` is read on each refresh so the catalog follows runtime changes. */
export function createModelCatalog(baseUrl: () => string | undefined, options: number | ModelCatalogOptions = {}): ModelCatalog {
  const opts: ModelCatalogOptions = typeof options === "number" ? { timeoutMs: options } : options;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const minIntervalMs = opts.minIntervalMs ?? 0;
  const now = opts.now ?? Date.now;
  let models: ModelInfo[] | undefined;
  let last: { at: number; url: string | undefined; result: Promise<Refreshed> } | undefined;
  const listeners = new Set<Listener<readonly ModelInfo[]>>();
  /** Bumped per fetch started; only the latest one, still for the current base URL, may set `models`. */
  let latest = 0;
  const capabilities: CapabilityCache = new Map();
  let lastPick: { key: string; pick: ChatPick | undefined } | undefined;

  const withPick = async (listed: ModelInfo[], url: string): Promise<ModelInfo[]> => {
    if (opts.pick === undefined) return listed;
    const pickKey = `${key(listed)}|${url}|${opts.pickKey?.() ?? ""}`;
    let pick = lastPick?.key === pickKey ? lastPick.pick : undefined;
    if (lastPick?.key !== pickKey) {
      try {
        pick = await opts.pick(listed, url);
      } catch (e) {
        opts.log?.(`chat pick failed: ${(e as Error).message}`);
        pick = undefined;
      }
      // A pick without a verdict (no GPU reading) is retried on the next refresh.
      lastPick = pick?.pick.verdict === undefined ? undefined : { key: pickKey, pick };
    }
    const chosen = pick;
    return chosen === undefined ? listed : listed.map((m) => (m.name === chosen.name ? { ...m, pick: chosen.pick } : m));
  };

  const fetchNow = async (url: string | undefined): Promise<Refreshed> => {
    const seq = ++latest;
    const next = url ? await withPick(await listModels(url, timeoutMs, capabilities), url) : [];
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
