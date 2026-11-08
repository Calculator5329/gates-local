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
/** /api/show answered without a capabilities field: an Ollama too old to report them. The UI says so instead of offering a download. */
export const UNREPORTED_CAPABILITIES: readonly string[] = ["unknown", "unreported"];
export const capabilitiesUnknown = (m: { readonly capabilities: readonly string[] }): boolean => m.capabilities.includes("unknown");

async function capabilitiesOf(baseUrl: string, m: ModelInfo, timeoutMs: number, cache: CapabilityCache | undefined): Promise<readonly string[]> {
  const known = cache?.get(m.digest);
  if (known) return known;
  try {
    const show = await fetchShow(baseUrl, m.name, AbortSignal.timeout(timeoutMs));
    if (show.capabilities === undefined) return UNREPORTED_CAPABILITIES;
    cache?.set(m.digest, show.capabilities);
    return show.capabilities;
  } catch {
    return UNKNOWN_CAPABILITIES;
  }
}

/** `stopped`: checked once the tags arrive; when it holds, no /api/show starts and capabilities stay empty. */
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
  /** The retry timer; tests pass a fake. Default: an unref'd setTimeout. */
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

/** `baseUrl` is read on each refresh so the catalog follows runtime changes. */
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

  /** The runtime the backoff belongs to; a different one starts over from retryBaseMs. */
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
      // Discovery settled: the retry armed by an earlier refresh has nothing left to do (MP2-02).
      cancelRetry();
      retryMs = retryBaseMs;
      return;
    }
    if (stopped || retryBaseMs <= 0 || url === undefined || retry !== undefined) return;
    retry = timers.set(() => {
      retry = undefined;
      // A retry belongs to its runtime; after a switch the new one is refreshed by the switch itself.
      if (stopped || baseUrl() !== url) return;
      // A fetch already running for this runtime answers the retry too (MP2-02); its result re-arms if still unsettled.
      const run = inFlight.get(url) ?? catalog.refresh({ force: true });
      run.catch((e: unknown) => {
        opts.log?.(`model discovery retry failed: ${(e as Error).message}`);
        // A failed retry is armed again, at the next doubled delay (MP2-01).
        if (baseUrl() === url) scheduleRetry(url, false);
      });
    }, retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  };

  const unchanged = (): Refreshed => ({ models: models ?? [], changed: false });
  const fetchNow = async (url: string | undefined): Promise<Refreshed> => {
    const listed = url ? await listModels(url, timeoutMs, capabilities, () => stopped) : [];
    // After stop() no later stage starts, and nothing is applied or announced (MP3-01, MP4-02).
    if (stopped) return unchanged();
    const picked = url ? await withPick(listed, url) : { models: listed, settled: true };
    const next = picked.models;
    // A fetch from a runtime that is no longer current changes nothing; its caller gets the current list (MP2-02).
    // Fetches for one runtime never overlap (refresh below), so the last to settle for the current runtime is the newest.
    if (stopped || baseUrl() !== url) return unchanged();
    const changed = models === undefined || key(models) !== key(next);
    models = next;
    // Unknown capabilities (MP-01) and an incomplete pick (MP-02) are asked again without waiting for a focus.
    scheduleRetry(url, picked.settled && !next.some(capabilitiesUnknown));
    if (changed) for (const l of listeners) l(next);
    return { models: next, changed };
  };

  /**
   * One fetch at a time per runtime (MP2-02). An unforced refresh joins the
   * running one; a forced one (a finished pull, a settings change) must see
   * the runtime after it was asked, so it waits for the running fetch and
   * then runs once, shared by every forced call that arrived meanwhile.
   */
  // Kept per runtime until it settles, so a switch A, B, back to A finds A's fetch still running (MP4-01).
  const inFlight = new Map<string | undefined, Promise<Refreshed>>();
  const queued = new Map<string | undefined, Promise<Refreshed>>();
  const start = (url: string | undefined): Promise<Refreshed> => {
    const result = fetchNow(url);
    inFlight.set(url, result);
    last = { at: now(), url, result };
    const done = () => {
      if (inFlight.get(url) === result) inFlight.delete(url);
    };
    // A failed fetch is not reused.
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
      // Work queued for this runtime has not started yet, so it answers this call too, even between the running fetch settling and it starting.
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
          // Back through refresh(), so it waits behind whatever runs now (a fetch for a newer runtime); stop() drops it.
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
