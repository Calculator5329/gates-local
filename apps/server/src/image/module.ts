import { randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import os from "node:os";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ImageChoice, ImageEvent, ImagePresets, ImageStatus, Params } from "@gates-local/contracts";
import * as S from "effect/Schema";
import type { Push } from "../app.ts";
import { readGpu, untilAborted } from "../fit/gpu.ts";
import type { NvidiaSmiRunner } from "../fit/types.ts";
import type { GpuLease } from "../gpu/lease.ts";
import { canonicalTag } from "../runtime/recommended.ts";
import type { ThreadStore } from "../threads/store.ts";
import { createComfyClient, type ComfyClientDeps } from "./client.ts";
import { availablePresets, defaultChoice, describeChoice, isDefaultChoice, resolveChoice, smallerFit, type LoaderFiles } from "./presets.ts";
import { createComfyService, type ComfyService } from "./service.ts";

/** ComfyUI's last file list, kept in the data dir so the picker lists presets while ComfyUI is stopped. */
const FILES_NAME = "image-files.json";
const KnownFiles = S.Struct({ baseUrl: S.String, readAt: S.Finite, files: S.Record(S.String, S.Array(S.String)) });
type KnownFiles = typeof KnownFiles.Type;

export interface ImageDeps extends ComfyClientDeps {
  admit?(): void;
  dataDir: string;
  lease: GpuLease;
  store: ThreadStore;
  push: Push;
  settings(): { imageGen: boolean; comfyUrl?: string; imageChoice?: ImageChoice };
  /** Only models the app loaded, never the complete /api/ps list. */
  appLoadedModels(): readonly string[];
  ollamaUrl(): string | undefined;
  onModelUnloaded?(model: string): void;
  readGpu?(): Promise<{ freeBytes: number; holders: string; tenants?: readonly GpuHolder[] }>;
  /** The nvidia-smi the default readGpu runs; the e2e stack's fake (GATES_LOCAL_NVIDIA_SMI), as every chat fit uses. */
  runNvidiaSmi?: NvidiaSmiRunner;
  service?: ComfyService;
  requiredBytes?: number;
  idleMs?: number;
  startupTimeoutMs?: number;
  /** How long a swap waits for unloaded memory to show as free; SWAP_WAIT_MS unless a test sets it. */
  swapWaitMs?: number;
  /** The spacing of those reads; SWAP_POLL_MS unless a test sets it. */
  swapPollMs?: number;
  jobTimeoutMs?: number;
  queueTimeoutMs?: number;
  /** This machine's own interface addresses; tests inject them. */
  localAddresses?(): readonly string[];
  /** Every address a host name resolves to; tests inject it. */
  lookupHost?(name: string): Promise<readonly string[]>;
  log?(line: string): void;
}

export interface ImageModule {
  /** Queued and running jobs, including jobs waiting for GPU memory. */
  activeJobs?(): number;
  current(): ImageStatus;
  status(): Promise<ImageStatus>;
  /**
   * The presets ComfyUI has every file for. Reads ComfyUI's file list when it answers (never
   * starts it), else returns the last list read at this address, kept across restarts.
   */
  presets(): Promise<ImagePresets>;
  /** The choice an unset Settings choice means now: the first preset ComfyUI last listed every file for. */
  defaultChoice(): ImageChoice;
  /** A job runs `choice`, else Settings' imageChoice, else defaultChoice(); a retry runs its failed job's. */
  generate(params: Params<"image.generate">): Promise<{ jobId: string }>;
  cancel(jobId: string): { cancelled: boolean };
  /** Test/CLI completion seam; errors are reported on image.event. */
  wait(jobId: string): Promise<void>;
  /**
   * `signal` (a turn's reclaim) ends the wait for the GPU claim and every read under it, so the
   * claim goes back at once; a cancelled call never starts a stop. A stop already begun runs to its end.
   */
  stopIdle(signal?: AbortSignal): Promise<void>;
  /** The MainPID of the ComfyUI this app started while no image job runs (what stopIdle would stop), else undefined. */
  reclaimable(): number | undefined;
  close(): Promise<void>;
  /** Hard shutdown deadline: running jobs cannot delay this run's owned unit stop. */
  killRuntimeNow(): void;
}

const DEFAULT_URL = "http://127.0.0.1:8188";

/**
 * One spelling per IP address: lowercase, no brackets or zone, IPv6 written
 * the way the URL parser writes it, and an IPv4-mapped IPv6 address
 * (::ffff:a.b.c.d, which the parser writes as ::ffff:XXXX:YYYY) as plain
 * dotted IPv4. Anything that is not an IP literal comes back lowercased.
 */
export function canonicalAddress(address: string): string {
  let a = address.toLowerCase().replace(/^\[(.*)\]$/, "$1").split("%")[0]!;
  if (net.isIPv6(a)) {
    a = new URL(`http://[${a}]`).hostname.slice(1, -1);
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
    if (mapped) {
      const hi = parseInt(mapped[1]!, 16), lo = parseInt(mapped[2]!, 16);
      a = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    }
  }
  return a;
}

/** This machine's interface addresses, in canonicalAddress form. */
export function localAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) out.push(canonicalAddress(a.address));
  return out;
}

const lookupHost = async (name: string): Promise<readonly string[]> =>
  (await dns.lookup(name, { all: true, verbatim: true })).map((entry) => entry.address);

/** Loopback (all of 127.0.0.0/8 and ::1), the wildcard addresses, or one of this machine's interfaces. */
const isLocalAddress = (address: string, own: readonly string[]) => {
  const a = canonicalAddress(address);
  return /^127(\.\d{1,3}){3}$/.test(a) || a === "::1" || a === "0.0.0.0" || a === "::" || own.map(canonicalAddress).includes(a);
};

/**
 * True when a ComfyUI at this host runs on this machine's GPU; only then do
 * the VRAM fit and the chat unload apply. An IP literal is local when it is
 * loopback, the wildcard address ComfyUI prints when started with --listen,
 * or one of this machine's interface addresses. A name is local when any
 * address it resolves to is local; `localhost` and `*.localhost` always are.
 * One trailing dot is ignored for those checks, but DNS gets the name as
 * the HTTP request will send it: with search suffixes, `comfy.lan.` and
 * `comfy.lan` can resolve to different hosts. When the name cannot be
 * resolved the answer is true: an unknown host gets the fit, never a
 * skipped one. An aborted signal ends a pending lookup with its reason.
 */
export async function isLocalHost(hostname: string, own: readonly string[] = localAddresses(),
  lookup: (name: string) => Promise<readonly string[]> = lookupHost, signal?: AbortSignal): Promise<boolean> {
  const name = hostname.toLowerCase();
  const h = name.replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const literal = h.replace(/^\[(.*)\]$/, "$1");
  if (net.isIP(literal)) return isLocalAddress(literal, own);
  signal?.throwIfAborted();
  try {
    const addresses = await untilAborted(lookup(name), signal);
    return addresses.length === 0 || addresses.some((address) => isLocalAddress(address, own));
  } catch {
    if (signal?.aborted) throw signal.reason;
    return true;
  }
}

/**
 * After unloading chat models, how long the fit keeps reading the GPU before it refuses.
 * Ollama answers the unload before its runner has handed the memory back.
 */
export const SWAP_WAIT_MS = 20_000;
/** The spacing of those reads, as readNvidiaSmi spaces its retries. */
export const SWAP_POLL_MS = 250;

const detail = (error: unknown) => error instanceof Error ? error.message : String(error);
const imageError = (code: string, message: string) => Object.assign(new Error(message), { code });
const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
const same = (a: ImageChoice, b: ImageChoice) => a.preset === b.preset && a.width === b.width && a.height === b.height;

/** One process on the GPU as nvidia-smi lists it (fit/gpu.ts GpuTenant). */
export interface GpuHolder { pid: number; usedBytes?: number; label?: string; role?: string }

/**
 * The refusal the card shows, in one sentence: what the image needs, what is free, who holds the
 * most of the rest, and a setup that would fit when one does (`smaller`, from smallerFit). `ours`
 * are this app's chat models Ollama still lists after the unload and the wait: an Ollama runner is
 * then this app's, and the sentence never says to close another app. Undefined when Ollama's list
 * could not be read; the sentence then names Ollama and claims nothing about whose model it is.
 */
export function fitSentence(needBytes: number, freeBytes: number, holders: readonly GpuHolder[], ours: readonly string[] | undefined, smaller?: string): string {
  const base = `The image needs ${gib(needBytes)} and ${gib(freeBytes)} is free`;
  const out = smaller === undefined ? "" : `; ${smaller} would fit`;
  const top = holders.filter((h) => (h.usedBytes ?? 0) > 0).toSorted((a, b) => (b.usedBytes ?? 0) - (a.usedBytes ?? 0))[0];
  if (top === undefined) return `${base}${out}.`;
  const held = gib(top.usedBytes ?? 0);
  if (top.role === "ollama") {
    if (ours === undefined) return `${base}; Ollama holds ${held}${out}.`;
    if (ours.length > 0) return `${base}; this app's chat model${ours.length === 1 ? ` ${ours[0]} still holds` : `s ${ours.join(", ")} still hold`} ${held}, try again in a moment${out}.`;
    return `${base}; a chat model this app did not load holds ${held}, stop it${out}.`;
  }
  return `${base}; ${top.label ?? `process ${top.pid}`} holds ${held}, close it${out}.`;
}

/** The long form (status detail and log) keeps every number; `said` is the card's one sentence. */
export function imageFitError(estimatedBytes: number, creditedBytes: number, freeBytes: number, holders: string, said?: string) {
  const needBytes = Math.max(0, estimatedBytes - creditedBytes);
  const shortfallBytes = Math.max(0, needBytes - freeBytes);
  return Object.assign(imageError("wont-fit", `Image generation needs ${gib(needBytes)}, ${gib(freeBytes)} free, ${gib(shortfallBytes)} short (estimated total ${gib(estimatedBytes)}, credited ComfyUI resident ${gib(creditedBytes)}). Memory holders: ${holders}. Protected occupants are left running.`),
    { estimatedBytes, creditedBytes, needBytes, freeBytes, shortfallBytes, holders, said: said ?? fitSentence(needBytes, freeBytes, [], []) });
}

export function createImageModule(deps: ImageDeps): ImageModule {
  const log = deps.log ?? ((line: string) => console.error(`[image] ${line}`));
  for (const job of deps.store.interruptImageJobs()) log(`job ${job.jobId} failed kind=restarted`);
  const service = deps.service ?? createComfyService();
  const jobs = new Map<string, { controller: AbortController; ended: Promise<void>; committing: boolean }>();
  let status: ImageStatus = { state: "off", owner: "none" };
  let owned: { pid: number; baseUrl: string } | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let activeJob: string | undefined;
  /**
   * Our own prompts that ignored the 30 s cancel deadline, one per ComfyUI
   * address; ComfyUI may still be running them. `pid` is the MainPID of the
   * app-started ComfyUI that ran it, when the address was ours. A record
   * goes when its prompt is no longer running or its process changed.
   */
  const stuck = new Map<string, { promptId: string; pid?: number }>();
  const emit: Push = (channel, payload) => { try { deps.push(channel, payload); } catch { /* a disconnected client cannot strand a GPU job */ } };
  const update = (next: ImageStatus): ImageStatus => { status = next; emit("image.status", status); return status; };
  const config = () => {
    const settings = deps.settings();
    const url = new URL(settings.comfyUrl ?? DEFAULT_URL);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw imageError("image-config", "Set a ComfyUI HTTP address without credentials or query parameters in Settings.");
    const baseUrl = url.href.replace(/\/$/, "");
    return { enabled: settings.imageGen, baseUrl, managed: baseUrl === DEFAULT_URL && settings.comfyUrl === undefined, hostname: url.hostname };
  };
  const client = (baseUrl: string) => createComfyClient(baseUrl, deps);
  const filesPath = path.join(deps.dataDir, FILES_NAME);
  let known: KnownFiles | undefined;
  try { known = S.decodeUnknownSync(KnownFiles)(JSON.parse(readFileSync(filesPath, "utf8"))); }
  catch { known = undefined; /* absent or unreadable: read again from ComfyUI */ }
  const remember = (baseUrl: string, files: LoaderFiles) => {
    known = { baseUrl, readAt: Date.now(), files };
    try {
      const tmp = `${filesPath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(known));
      renameSync(tmp, filesPath);
    } catch (error) { log(`ComfyUI file list not kept: ${detail(error)}`); }
  };
  /** The last file list read at the configured address, or undefined. */
  const knownFiles = (): KnownFiles | undefined => {
    try { return known?.baseUrl === config().baseUrl ? known : undefined; }
    catch { return undefined; }
  };
  const clearIdle = () => { clearTimeout(idleTimer); idleTimer = undefined; };
  const armIdle = () => {
    clearIdle();
    if (!owned || closed) return;
    idleTimer = setTimeout(() => { void module.stopIdle().catch((error: unknown) => {
      update({ ...status, state: "error", detail: `ComfyUI idle stop failed: ${detail(error)}` });
      if (owned) armIdle();
    }); }, deps.idleMs ?? 300_000);
    idleTimer.unref();
  };
  const discover = async (): Promise<ImageStatus> => {
    const cfg = config();
    if (!cfg.enabled) return update({ state: "off", owner: owned ? "app" : "none" });
    if (jobs.size > 0) return status;
    if (await client(cfg.baseUrl).healthy()) {
      if (jobs.size > 0) return status;
      if (owned && cfg.managed) {
        const unit = await service.inspect();
        if (unit.pid !== owned.pid || !unit.active) owned = undefined;
      }
      if (jobs.size > 0) return status;
      return update({ state: "ready", owner: owned?.baseUrl === cfg.baseUrl ? "app" : "external", baseUrl: cfg.baseUrl });
    }
    const unit = cfg.managed ? await service.inspect() : { present: false, active: false, activeState: "unknown", pid: 0 };
    const starting = unit.present && !["inactive", "failed"].includes(unit.activeState);
    if (jobs.size > 0) return status;
    if (owned?.baseUrl === cfg.baseUrl && (!unit.active || unit.pid !== owned.pid)) owned = undefined;
    return update({ state: starting ? "starting" : unit.present ? "stopped" : "missing", owner: owned?.baseUrl === cfg.baseUrl ? "app" : starting ? "external" : "none", baseUrl: cfg.baseUrl,
      detail: starting ? "ComfyUI is running or changing state but its HTTP interface is not ready yet." : unit.present ? "ComfyUI will start when you make an image." : "ComfyUI did not answer. Install the local user service or set a running ComfyUI address in Settings." });
  };
  const measure = deps.readGpu ?? (async () => {
    const gpu = await readGpu(deps.runNvidiaSmi);
    return { freeBytes: gpu.freeBytes, tenants: gpu.tenants, holders: gpu.tenants.map((t) => `${t.label} (${t.usedBytes === undefined ? "unknown" : gib(t.usedBytes)})`).join(", ") || "unlisted GPU occupants" };
  });
  /**
   * `needBytes`: the preset's need at the job's size (presets.ts). `freeing` is told when the
   * unload of this app's chat models begins (true) and when the memory is back or the wait gave up (false).
   */
  const fit = async (cfg: ReturnType<typeof config>, needBytes: number, signal: AbortSignal, freeing: (on: boolean) => void) => {
    if (!await isLocalHost(cfg.hostname, deps.localAddresses?.() ?? localAddresses(), deps.lookupHost ?? lookupHost, signal)) return;
    signal.throwIfAborted();
    const stats = await client(cfg.baseUrl).stats(signal).catch(() => undefined);
    signal.throwIfAborted();
    if (stats && stats.devices.length > 0 && stats.devices.every((device) => device.type === "cpu")) return;
    const estimate = deps.requiredBytes ?? needBytes;
    const unit = stats && cfg.managed ? await service.inspect() : undefined;
    const resident = (gpu: Awaited<ReturnType<typeof measure>>) => {
      if (!stats) return 0;
      let bytes: number | undefined;
      if (unit && unit.present && unit.pid > 0) {
        const sum = (gpu.tenants ?? []).filter((tenant) => tenant.pid === unit.pid).reduce((total, tenant) => total + (tenant.usedBytes ?? 0), 0);
        if (sum > 0) bytes = sum;
      }
      // No measured row for the MainPID (not listed, or [N/A]): ComfyUI's own torch reservation is still only its memory.
      bytes ??= stats.devices[0]?.torch_vram_total ?? 0;
      return Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
    };
    let gpu = await measure();
    let credited = resident(gpu);
    let need = Math.max(0, estimate - credited);
    if (!Number.isFinite(gpu.freeBytes) || gpu.freeBytes < 0) throw new Error("GPU free memory could not be measured. Retry when the GPU status is available.");
    const remeasure = async () => {
      gpu = await measure();
      credited = resident(gpu);
      need = Math.max(0, estimate - credited);
    };
    let models: string[] = [];
    if (gpu.freeBytes < need) {
      models = [...new Set(deps.appLoadedModels())];
      const ollama = deps.ollamaUrl();
      if (ollama && models.length > 0) {
        freeing(true);
        for (const model of models) {
          signal.throwIfAborted();
          const response = await (deps.fetch ?? fetch)(`${ollama.replace(/\/$/, "")}/api/generate`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, keep_alive: 0 }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
          });
          if (!response.ok) throw new Error(`Could not unload app chat model ${model}: Ollama HTTP ${response.status}.`);
          await response.arrayBuffer();
          deps.onModelUnloaded?.(model);
        }
        // Ollama answers before its runner has handed the memory back: read until it shows, or the bound passes.
        const deadline = Date.now() + (deps.swapWaitMs ?? SWAP_WAIT_MS);
        for (;;) {
          await remeasure();
          if (!Number.isFinite(gpu.freeBytes) || gpu.freeBytes < 0 || gpu.freeBytes >= need || Date.now() >= deadline) break;
          await delay(deps.swapPollMs ?? SWAP_POLL_MS, undefined, { signal });
        }
        if (gpu.freeBytes >= need) freeing(false); // a refusal's own event ends the step otherwise
      } else await remeasure();
    }
    signal.throwIfAborted();
    if (!Number.isFinite(gpu.freeBytes) || gpu.freeBytes < 0) throw new Error("GPU free memory could not be measured after unloading app chat.");
    if (gpu.freeBytes < need) {
      const others = (gpu.tenants ?? []).filter((tenant) => !(unit && unit.pid > 0 && tenant.pid === unit.pid)); // ComfyUI's own memory is credited
      // this app's only while Ollama still lists it: an unloaded model that is gone holds nothing
      const ours = await stillListed([...new Set([...models, ...deps.appLoadedModels()])], signal);
      const smaller = smallerFit(knownFiles()?.files, estimate, gpu.freeBytes + credited);
      throw imageFitError(estimate, credited, gpu.freeBytes, gpu.holders, fitSentence(need, gpu.freeBytes, others, ours, smaller));
    }
  };
  /** Of `models`, the ones Ollama's /api/ps still lists; undefined when that list cannot be read. */
  const stillListed = async (models: readonly string[], signal: AbortSignal): Promise<string[] | undefined> => {
    const ollama = deps.ollamaUrl();
    if (models.length === 0) return [];
    if (!ollama) return undefined;
    try {
      const response = await (deps.fetch ?? fetch)(`${ollama.replace(/\/$/, "")}/api/ps`, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
      if (!response.ok) return undefined;
      const body = await response.json() as { models?: readonly { name?: unknown }[] };
      const listed = new Set((body.models ?? []).flatMap((m) => typeof m.name === "string" ? [canonicalTag(m.name)] : []));
      return models.filter((model) => listed.has(canonicalTag(model)));
    } catch {
      signal.throwIfAborted();
      return undefined;
    }
  };
  const ensure = async (baseUrl: string, managed: boolean, signal: AbortSignal) => {
    const comfy = client(baseUrl);
    if (await comfy.healthy()) {
      if (owned && managed) { const unit = await service.inspect(); if (owned.pid !== unit.pid || !unit.active) owned = undefined; }
      return comfy;
    }
    const before = managed ? await service.inspect() : { present: false, active: false, activeState: "unknown", pid: 0 };
    if (!before.present) throw imageError("image-missing", "ComfyUI did not answer. Install comfyui.service or set a running ComfyUI address in Settings.");
    const canStart = ["inactive", "failed"].includes(before.activeState);
    update({ state: "starting", owner: owned ? "app" : canStart ? "none" : "external", baseUrl });
    signal.throwIfAborted();
    // Active and transitional units belong to their existing owner. Wait, never adopt.
    if (canStart) {
      await service.start();
      const after = await service.inspect();
      if (!after.active || after.pid <= 0) throw new Error("ComfyUI started without a live MainPID. Check comfyui.service and retry.");
      owned = { pid: after.pid, baseUrl };
    }
    const deadline = Date.now() + (deps.startupTimeoutMs ?? 60_000);
    while (!await comfy.healthy()) {
      signal.throwIfAborted();
      if (Date.now() >= deadline) throw new Error("ComfyUI did not become ready within the startup timeout. Check comfyui.service and retry.");
      await delay(250, undefined, { signal });
    }
    signal.throwIfAborted();
    return comfy;
  };
  const chooseDefault = () => defaultChoice(knownFiles()?.files);
  /** What a send runs now: the saved choice, or the default for the files last read. */
  const currentChoice = () => describeChoice(deps.settings().imageChoice ?? chooseDefault(), chooseDefault());
  const module: ImageModule = {
    current: () => status,
    activeJobs: () => jobs.size,
    status: discover,
    defaultChoice: chooseDefault,
    async presets() {
      const cfg = config();
      if (!cfg.enabled) return { presets: [], current: currentChoice() };
      const comfy = client(cfg.baseUrl);
      if (await comfy.healthy()) {
        try { remember(cfg.baseUrl, await comfy.files()); }
        catch (error) { log(`ComfyUI file list not read: ${detail(error)}`); }
      }
      const last = knownFiles();
      return last === undefined ? { presets: [], current: currentChoice() } : { presets: availablePresets(last.files), readAt: last.readAt, current: currentChoice() };
    },
    async generate(params) {
      if (closed) throw imageError("shutting-down", "Image generation is shutting down.");
      deps.admit?.();
      let cfg = { enabled: false, baseUrl: "", managed: false, hostname: "" };
      if (params.threadId) deps.store.getThread(params.threadId);
      const jobId = randomUUID();
      let prompt = params.prompt;
      // Unset: nothing saved in Settings, and the choice sent (or a retry's stored one) is absent
      // or one of the defaults. The picker saves every pick, so with nothing saved a default is all
      // a send can carry (the composer and the image tool send the one they show). The job settles
      // it again from ComfyUI's own list, so a default whose files went missing is passed over.
      const saved = deps.settings().imageChoice;
      let choice = params.choice ?? saved ?? chooseDefault();
      let unset = saved === undefined && isDefaultChoice(params.choice);
      if (params.retryOf !== undefined) {
        if (!params.threadId) throw imageError("bad-params", "An image retry must name its thread.");
        const retry = deps.store.claimImageRetry(params.threadId, params.retryOf, jobId, choice);
        if (!retry.created) return { jobId: retry.jobId };
        prompt = retry.prompt;
        choice = retry.choice;
        unset = saved === undefined && isDefaultChoice(retry.choice);
      } else resolveChoice(choice); // an unknown preset or size is refused before any card
      if (!prompt.trim()) throw imageError("bad-params", "Describe the image you want to make.");
      const sent = choice; // the card's box keeps this shape whatever the job settles to
      clearIdle();
      const controller = new AbortController();
      const deadline = new AbortController();
      const signal = AbortSignal.any([controller.signal, deadline.signal]);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      let stage = "image-config";
      const event = (state: ImageEvent["state"], rest: Partial<ImageEvent> = {}) => {
        const payload: ImageEvent = { jobId, ...params.threadId ? { threadId: params.threadId } : {}, state, choice, ...same(choice, sent) ? {} : { sent }, ...rest };
        deps.store.saveImageJob(payload, prompt);
        emit("image.event", payload);
      };
      event("queued");
      // Waiting has its own limit; it never spends the render's full run budget.
      timeout = setTimeout(() => { timedOut = true; deadline.abort(new Error("Image queue timed out.")); }, deps.queueTimeoutMs ?? 1_800_000);
      timeout.unref();
      // Begin after registering the promise; generate returns before any running event.
      const ended = Promise.resolve().then(async () => {
        try {
          await deps.lease.run("image", signal, async () => {
            clearTimeout(timeout);
            timeout = setTimeout(() => { timedOut = true; deadline.abort(new Error("Image run timed out.")); }, deps.jobTimeoutMs ?? 600_000);
            timeout.unref();
            const latest = config();
            if (!latest.enabled) throw imageError("image-off", "Image generation was turned off while this job waited.");
            cfg = latest;
            activeJob = jobId;
            event("running", { progress: 0 });
            update({ state: "busy", owner: owned ? "app" : "none", baseUrl: cfg.baseUrl });
            // Inside the job: a retry's stored choice a newer table no longer has fails its card in words.
            let { size } = resolveChoice(choice);
            const freeing = (on: boolean) => event("running", on ? { progress: 0, phase: "freeing" } : { progress: 0 });
            // An unset default settles to the files ComfyUI lists, so the fit and any unload judge the
            // setup that will really run. A default whose files ComfyUI does not list is passed over without a word.
            const read = async (from: Awaited<ReturnType<typeof ensure>>) => {
              try { remember(cfg.baseUrl, await from.files(signal)); }
              catch (error) { signal.throwIfAborted(); log(`ComfyUI file list not read: ${detail(error)}`); }
            };
            const settle = () => {
              const settled = chooseDefault();
              if (same(settled, choice)) return;
              choice = settled;
              ({ size } = resolveChoice(choice));
              event("running", { progress: 0 });
            };
            // Never read: ComfyUI is started (or found) and its list read before the first fit.
            stage = "image-missing";
            const early = unset && knownFiles() === undefined ? await ensure(cfg.baseUrl, cfg.managed, signal) : undefined;
            if (early) await read(early);
            if (unset) settle();
            stage = "image-fit";
            await fit(cfg, size.bytes, signal, freeing);
            stage = "image-missing";
            const comfy = early ?? await ensure(cfg.baseUrl, cfg.managed, signal);
            // read before: the read now ComfyUI is up catches files gone since
            if (unset && !early) { await read(comfy); settle(); }
            stage = "image-render";
            const earlier = stuck.get(cfg.baseUrl);
            if (earlier) {
              if ((await comfy.running(signal)).includes(earlier.promptId)) throw imageError("image-busy", "ComfyUI is still running an earlier image from this app that did not stop when cancelled. Wait for it to finish, then retry.");
              stuck.delete(cfg.baseUrl);
            }
            stage = "image-fit";
            await fit(cfg, size.bytes, signal, freeing); // startup or another GPU app may have changed the room
            stage = "image-render";
            update({ state: "busy", owner: owned?.baseUrl === cfg.baseUrl ? "app" : "external", baseUrl: cfg.baseUrl });
            const bytes = await comfy.render(prompt, jobId, signal, (progress) => event("running", { progress }), () => {
              const job = jobs.get(jobId);
              if (job) job.committing = true;
              clearTimeout(timeout);
            }, choice);
            const imagePath = `images/${jobId}.png`;
            stage = "image-save";
            await mkdir(path.join(deps.dataDir, "images"), { recursive: true });
            const pendingPath = path.join(deps.dataDir, "images", `${jobId}.pending`);
            await writeFile(pendingPath, bytes, { flag: "wx" });
            await rename(pendingPath, path.join(deps.dataDir, imagePath));
            event("done", { progress: 1, imagePath });
            if (params.threadId) emit("threads.changed", { threadId: params.threadId });
            update({ state: "ready", owner: owned?.baseUrl === cfg.baseUrl ? "app" : "external", baseUrl: cfg.baseUrl });
          });
        } catch (error) {
          const message = timedOut && !controller.signal.aborted ? "Image exceeded its run timeout. Retry when ComfyUI is ready." : detail(error);
          const cancelDetail = error instanceof Error && "cancelDetail" in error && typeof error.cancelDetail === "string" ? error.cancelDetail : undefined;
          const stuckPromptId = error instanceof Error && "stuckPromptId" in error && typeof error.stuckPromptId === "string" ? error.stuckPromptId : undefined;
          if (stuckPromptId) stuck.set(cfg.baseUrl, { promptId: stuckPromptId, ...owned?.baseUrl === cfg.baseUrl ? { pid: owned.pid } : {} });
          const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : stage;
          const missingFile = error instanceof Error && "file" in error && typeof error.file === "string" ? error.file : undefined;
          const reasons: Record<string, string> = {
            "image-config": "Check the ComfyUI address in Settings, then try again.",
            "image-off": "Turn on image generation in Settings, then try again.",
            "image-fit": "GPU memory could not be checked; check the GPU status and try again.",
            "wont-fit": "There is not enough GPU memory for this image.", // the fit's own sentence wins below
            "image-missing": "ComfyUI is not ready; check its service or address in Settings and try again.",
            "image-model": missingFile === undefined ? "Pick an image model ComfyUI has, then try again." : `Install ${missingFile} in ComfyUI, then try again.`,
            "image-busy": "ComfyUI is busy; wait for its other job to finish and try again.",
            "image-disconnected": "ComfyUI disconnected; wait until it is ready and try again.",
            "image-workflow": "ComfyUI did not make an image; check its workflow and try again.",
            "image-result": "ComfyUI returned an invalid image; check its workflow and try again.",
            "image-render": "The image did not finish; check ComfyUI and try again.",
            "image-save": "The image could not be saved; check free disk space and try again.",
          };
          const errorKind = controller.signal.aborted ? "cancelled" : timedOut ? "timeout" : Object.hasOwn(reasons, code) ? code : stage;
          const reason = controller.signal.aborted ? "The image was cancelled; try again when you are ready." : timedOut ? "The image timed out; wait until ComfyUI is ready and try again."
            : errorKind === "wont-fit" && error instanceof Error && "said" in error && typeof error.said === "string" ? error.said : reasons[errorKind];
          log(`job ${jobId} failed kind=${errorKind}`);
          event(controller.signal.aborted ? "cancelled" : "error", { message: reason, errorKind });
          if (cancelDetail && activeJob === jobId) {
            // Only a prompt that outlived the deadline means ComfyUI is still up; a failed cleanup alone does not.
            update({ state: "error", owner: owned?.baseUrl === cfg.baseUrl ? "app" : stuckPromptId ? "external" : "none", baseUrl: cfg.baseUrl, detail: `${message} ${cancelDetail}` });
          } else if (controller.signal.aborted && activeJob === jobId) {
            const healthy = await client(cfg.baseUrl).healthy();
            if (activeJob === jobId) update({ state: healthy ? "ready" : "stopped", owner: owned?.baseUrl === cfg.baseUrl ? "app" : healthy ? "external" : "none", baseUrl: cfg.baseUrl });
          } else if (!controller.signal.aborted && (activeJob === jobId || activeJob === undefined)) {
            update({ state: "error", owner: owned?.baseUrl === cfg.baseUrl ? "app" : "none", baseUrl: cfg.baseUrl, detail: message });
          }
        } finally {
          clearTimeout(timeout);
          if (activeJob === jobId) activeJob = undefined;
          jobs.delete(jobId);
          if (jobs.size === 0) armIdle();
        }
      });
      jobs.set(jobId, { controller, ended, committing: false });
      return { jobId };
    },
    cancel(jobId) {
      const job = jobs.get(jobId);
      if (!job || job.committing || job.controller.signal.aborted) return { cancelled: false };
      job.controller.abort(new Error("Image cancelled.")); return { cancelled: true };
    },
    async wait(jobId) { await jobs.get(jobId)?.ended; },
    async stopIdle(signal) {
      clearIdle();
      if (!owned || jobs.size > 0) return;
      await deps.lease.run("image", signal, async () => {
        if (!owned || jobs.size > 0) return;
        // The reads end at the signal, so a cancel gives the claim back at once; the stop does not.
        const unit = await untilAborted(service.inspect(), signal);
        // A record from an earlier process at this address names no prompt this ComfyUI runs for us;
        // the next job at this address or a stop clears it.
        const mine = stuck.get(owned.baseUrl);
        if (!unit.active || unit.pid !== owned.pid) { owned = undefined; return; }
        // Another Comfy client may have submitted work since ours ended.
        // Our own prompt stuck past its cancel deadline does not keep an app-started ComfyUI up.
        signal?.throwIfAborted();
        if (!await untilAborted(client(owned.baseUrl).idle(mine?.pid === owned.pid ? mine.promptId : undefined), signal)) { armIdle(); return; }
        signal?.throwIfAborted();
        const latest = await untilAborted(service.inspect(), signal);
        if (!latest.active || latest.pid !== owned.pid) { owned = undefined; return; }
        if (jobs.size > 0) return;
        signal?.throwIfAborted();
        await service.stop();
        const baseUrl = owned.baseUrl; owned = undefined;
        stuck.delete(baseUrl);
        update({ state: "stopped", owner: "none", baseUrl });
      }).catch((error: unknown) => {
        // A cancelled reclaim leaves ComfyUI to its idle timer.
        if (signal?.aborted) armIdle();
        throw error;
      });
    },
    reclaimable: () => (owned && jobs.size === 0 && !closed ? owned.pid : undefined),
    killRuntimeNow() {
      if (!owned) return;
      const pid = owned.pid;
      owned = undefined;
      service.killRuntimeNow?.(pid);
    },
    async close() {
      closed = true; clearIdle();
      const pending = [...jobs.values()];
      for (const job of pending) if (!job.committing) job.controller.abort(new Error("Image generation is shutting down."));
      await Promise.all(pending.map((job) => job.ended));
      await module.stopIdle();
    },
  };
  return module;
}
