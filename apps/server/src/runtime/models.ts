import { UNREPORTED_MAX_CONTEXT } from "../fit/constants.ts";
import { reportedContextLength } from "../fit/estimate.ts";
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

type Described = { capabilities: readonly string[]; maxContext?: number };

export type CapabilityCache = Map<string, Described>;

export const UNKNOWN_CAPABILITIES: readonly string[] = ["unknown"];
export const UNREPORTED_CAPABILITIES: readonly string[] = ["unknown", "unreported"];
export const capabilitiesUnknown = (m: { readonly capabilities: readonly string[] }): boolean => m.capabilities.includes("unknown");

async function describe(baseUrl: string, m: ModelInfo, timeoutMs: number, cache: CapabilityCache | undefined): Promise<Described> {
  const known = cache?.get(m.digest);
  if (known) return known;
  try {
    const show = await fetchShow(baseUrl, m.name, AbortSignal.timeout(timeoutMs));
    const maxContext = reportedContextLength(show.model_info) ?? UNREPORTED_MAX_CONTEXT;
    if (show.capabilities === undefined) return { capabilities: UNREPORTED_CAPABILITIES, maxContext };
    const described = { capabilities: show.capabilities, maxContext };
    cache?.set(m.digest, described);
    return described;
  } catch {
    return { capabilities: UNKNOWN_CAPABILITIES };
  }
}

export async function listModels(baseUrl: string, timeoutMs = 5000, cache?: CapabilityCache, stopped?: () => boolean): Promise<ModelInfo[]> {
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
  if (stopped?.() === true) return models;
  const described = await Promise.all(models.map((m) => describe(baseUrl, m, timeoutMs, cache)));
  return models.map((m, i) => ({ ...m, capabilities: described[i]?.capabilities ?? [], ...(described[i]?.maxContext === undefined ? {} : { maxContext: described[i].maxContext }) }));
}

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
  current(): readonly ModelInfo[] | undefined;
  refresh(options?: { force?: boolean }): Promise<Refreshed>;
  onChange(listener: Listener<readonly ModelInfo[]>): () => void;
  stop(): void;
};

export type ModelCatalogOptions = {
  timeoutMs?: number;
  minIntervalMs?: number;
  now?: () => number;
  pick?: (models: readonly ModelInfo[], baseUrl: string) => Promise<ChatPick | undefined>;
  pickKey?: () => string;
  retryMs?: number;
  timers?: RetryTimers;
  log?: (line: string) => void;
};

export type RetryTimers = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
const realTimers: RetryTimers = {
  set(fn, ms) {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const RETRY_MAX_MS = 5 * 60_000;

export function createModelCatalog(baseUrl: () => string | undefined, options: number | ModelCatalogOptions = {}): ModelCatalog {
  const opts: ModelCatalogOptions = typeof options === "number" ? { timeoutMs: options } : options;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const minIntervalMs = opts.minIntervalMs ?? 0;
  const now = opts.now ?? Date.now;
  let models: ModelInfo[] | undefined;
  let last: { at: number; url: string | undefined; result: Promise<Refreshed> } | undefined;
  const listeners = new Set<Listener<readonly ModelInfo[]>>();
  const capabilities: CapabilityCache = new Map();
  let lastPick: { key: string; pick: ChatPick } | undefined;
  const retryBaseMs = opts.retryMs ?? 5000;
  let retryMs = retryBaseMs;
  const timers = opts.timers ?? realTimers;
  let retry: unknown;
  let stopped = false;

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
      lastPick = pick?.complete === true ? { key: pickKey, pick } : undefined;
    }
    const chosen = pick;
    const stamped = chosen === undefined ? listed : listed.map((m) => (m.name === chosen.name ? { ...m, pick: chosen.pick } : m));
    return { models: stamped, settled: !failed && (chosen === undefined || chosen.complete) };
  };

  let backoffUrl: string | undefined;
  const cancelRetry = () => {
    if (retry !== undefined) timers.clear(retry);
    retry = undefined;
  };
  const scheduleRetry = (url: string | undefined, settled: boolean) => {
    if (url !== backoffUrl) {
      cancelRetry();
      retryMs = retryBaseMs;
      backoffUrl = url;
    }
    if (settled) {
      cancelRetry();
      retryMs = retryBaseMs;
      return;
    }
    if (stopped || retryBaseMs <= 0 || url === undefined || retry !== undefined) return;
    retry = timers.set(() => {
      retry = undefined;
      if (stopped || baseUrl() !== url) return;
      const run = inFlight.get(url) ?? catalog.refresh({ force: true });
      run.catch((e: unknown) => {
        opts.log?.(`model discovery retry failed: ${(e as Error).message}`);
        if (baseUrl() === url) scheduleRetry(url, false);
      });
    }, retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  };

  const unchanged = (): Refreshed => ({ models: models ?? [], changed: false });
  const fetchNow = async (url: string | undefined): Promise<Refreshed> => {
    const listed = url ? await listModels(url, timeoutMs, capabilities, () => stopped) : [];
    if (stopped) return unchanged();
    const picked = url ? await withPick(listed, url) : { models: listed, settled: true };
    const next = picked.models;
    // why: fetches for one runtime never overlap, so the last to settle here is the newest
    if (stopped || baseUrl() !== url) return unchanged();
    const changed = models === undefined || key(models) !== key(next);
    models = next;
    scheduleRetry(url, picked.settled && !next.some(capabilitiesUnknown));
    if (changed) for (const l of listeners) l(next);
    return { models: next, changed };
  };

  const inFlight = new Map<string | undefined, Promise<Refreshed>>();
  const queued = new Map<string | undefined, Promise<Refreshed>>();
  const start = (url: string | undefined): Promise<Refreshed> => {
    const result = fetchNow(url);
    inFlight.set(url, result);
    last = { at: now(), url, result };
    const done = () => {
      if (inFlight.get(url) === result) inFlight.delete(url);
    };
    result.then(done, () => {
      done();
      if (last?.result === result) last = undefined;
    });
    return result;
  };

  const catalog: ModelCatalog = {
    current: () => models,
    stop() {
      stopped = true;
      cancelRetry();
    },
    refresh(how) {
      if (stopped) return Promise.resolve(unchanged());
      const url = baseUrl();
      const force = how?.force === true;
      if (!force && last !== undefined && last.url === url && now() - last.at < minIntervalMs) return last.result;
      const running = inFlight.get(url);
      const waiting = queued.get(url);
      if (waiting !== undefined && (force || running === undefined)) return waiting;
      if (running === undefined) return start(url);
      if (!force) return running;
      const result: Promise<Refreshed> = running
        .then(
          () => undefined,
          () => undefined,
        )
        .then(() => {
          if (queued.get(url) === result) queued.delete(url);
          return catalog.refresh({ force: true });
        });
      queued.set(url, result);
      return result;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return catalog;
}
