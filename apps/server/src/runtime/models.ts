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
 * The capability list of a model /api/show could not describe (it failed, or
 * listed no capabilities). Never "completion": an embedding model under a
 * chat-looking alias must not become a chat choice (MP-01). Not cached; the
 * catalog asks /api/show again until it answers.
 */
export const UNKNOWN_CAPABILITIES: readonly string[] = ["unknown"];
export const capabilitiesUnknown = (m: { readonly capabilities: readonly string[] }): boolean => m.capabilities.includes("unknown");

async function capabilitiesOf(baseUrl: string, m: ModelInfo, timeoutMs: number, cache: CapabilityCache | undefined): Promise<readonly string[]> {
  const known = cache?.get(m.digest);
  if (known) return known;
  try {
    const show = await fetchShow(baseUrl, m.name, AbortSignal.timeout(timeoutMs));
    if (show.capabilities === undefined) return UNKNOWN_CAPABILITIES;
    cache?.set(m.digest, show.capabilities);
    return show.capabilities;
  } catch {
    return UNKNOWN_CAPABILITIES;
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
  /** Cancel a pending retry; no more retries start. */
  stop(): void;
};

export type ModelCatalogOptions = {
  timeoutMs?: number;
  minIntervalMs?: number;
  now?: () => number;
  /**
   * The chat pick (runtime/pick.ts with the fit check and settings bound).
   * Runs when the installed list or pickKey() changes; a complete pick is
   * reused until then, so the starting model stays put while the GPU's free
   * memory moves. An incomplete one (a fit that did not run) is never
   * reused. Without it no model carries a pick.
   */
  pick?: (models: readonly ModelInfo[], baseUrl: string) => Promise<ChatPick | undefined>;
  /** The settings the pick depends on, as a string; a change re-runs the pick on the next refresh. */
  pickKey?: () => string;
  /**
   * While a model's capabilities are unknown or the pick is incomplete, a
   * forced refresh runs after this delay, doubling up to 5 minutes, until
   * both settle. 0 turns it off. Default 5000.
   */
  retryMs?: number;
  log?: (line: string) => void;
};

const RETRY_MAX_MS = 5 * 60_000;

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
  let lastPick: { key: string; pick: ChatPick } | undefined;
  const retryBaseMs = opts.retryMs ?? 5000;
  let retryMs = retryBaseMs;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  /** The list with the pick stamped, and whether that pick is a decision (not a guess to redo). */
  const withPick = async (listed: ModelInfo[], url: string): Promise<{ models: ModelInfo[]; settled: boolean }> => {
    if (opts.pick === undefined) return { models: listed, settled: true };
    const pickKey = `${key(listed)}|${url}|${opts.pickKey?.() ?? ""}`;
    let pick = lastPick?.key === pickKey ? lastPick.pick : undefined;
    let failed = false;
    if (lastPick?.key !== pickKey) {
      try {
        pick = await opts.pick(listed, url);
      } catch (e) {
        opts.log?.(`chat pick failed: ${(e as Error).message}`);
        pick = undefined;
        failed = true;
      }
      // An incomplete pick (a fit that did not run) is picked again on the next refresh (MP-02).
      lastPick = pick?.complete === true ? { key: pickKey, pick } : undefined;
    }
    const chosen = pick;
    const stamped = chosen === undefined ? listed : listed.map((m) => (m.name === chosen.name ? { ...m, pick: chosen.pick } : m));
    return { models: stamped, settled: !failed && (chosen === undefined || chosen.complete) };
  };

  const scheduleRetry = (settled: boolean) => {
    if (settled) retryMs = retryBaseMs;
    if (settled || stopped || retryBaseMs <= 0 || retry !== undefined) return;
    retry = setTimeout(() => {
      retry = undefined;
      catalog.refresh({ force: true }).catch((e: unknown) => opts.log?.(`model discovery retry failed: ${(e as Error).message}`));
    }, retryMs);
    retry.unref?.();
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  };

  const fetchNow = async (url: string | undefined): Promise<Refreshed> => {
    const seq = ++latest;
    const listed = url ? await listModels(url, timeoutMs, capabilities) : [];
    const picked = url ? await withPick(listed, url) : { models: listed, settled: true };
    const next = picked.models;
    // An older fetch (or one from the runtime before a switch) answers its own caller and changes nothing.
    if (seq !== latest || baseUrl() !== url) return { models: next, changed: false };
    const changed = models === undefined || key(models) !== key(next);
    models = next;
    // Unknown capabilities (MP-01) and an incomplete pick (MP-02) are asked again without waiting for a focus.
    scheduleRetry(picked.settled && !next.some(capabilitiesUnknown));
    if (changed) for (const l of listeners) l(next);
    return { models: next, changed };
  };

  const catalog: ModelCatalog = {
    current: () => models,
    stop() {
      stopped = true;
      if (retry !== undefined) clearTimeout(retry);
      retry = undefined;
    },
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
  return catalog;
}
