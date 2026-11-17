import { randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import os from "node:os";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { imageFitVerdict, type GpuStatus, type ImageChoice, type ImageDownload, type ImageEvent, type ImagePresets, type ImageStatus, type Params, type PullProgress } from "@gates-local/contracts";
import * as S from "effect/Schema";
import type { Push } from "../app/push.ts";
import { forgetGpuReadings, holdersSummary, readGpu, untilAborted } from "../fit/gpu.ts";
import type { NvidiaSmiRunner } from "../fit/types.ts";
import type { GpuLease } from "../gpu/lease.ts";
import { ENGINE_BUSY_NOTE, imageSetup, type EngineLeave, type MemoryEngine, type MemoryOwner, type Want } from "../gpu/memory.ts";
import { pngFacts } from "../pictures/png.ts";
import type { PictureFacts } from "../pictures/table.ts";
import type { ThreadStore } from "../threads/store.ts";
import { threadChanged } from "../threads/sync.ts";
import { CANCEL_WAIT_MS, createComfyClient, type ComfyClientDeps } from "./client.ts";
import { downloadFile, haveFile, partBytes, sizeOf, volumeFree, volumeOf, type DownloadOptions } from "./download.ts";
import { isLocalComfy } from "./installed.ts";
import { appPreset, cardBytes, DEFAULT_CHOICE, defaultChoice, describeChoice, isDefaultChoice, judgeRow, listPresets, liveChoice, MIN_ROOM, NO_GPU, presetFiles, resolveChoice, sameRow, SLOW, smallerFit, tiersFor, workflowPreset, type ComfyLists, type KnownWorkflow, type Preset } from "./presets.ts";
import { createComfyService, type ComfyService } from "./service.ts";
import { engineStatus, mayWrite, type Seen, type StatusWriter } from "./engine-status.ts";
import { extraModelPathsLine, MODEL_KINDS, type OwnComfy } from "./own.ts";

export function sharedFolder(dirs: readonly string[]): string {
  let at = path.resolve(dirs[0] ?? ".");
  const inside = (dir: string) => { const rel = path.relative(at, path.resolve(dir)); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); };
  while (!dirs.every(inside) && path.dirname(at) !== at) at = path.dirname(at);
  return at;
}

const FILES_NAME = "image-files.json";
const Source = S.Struct({ directory: S.optional(S.String), url: S.optional(S.String), bytes: S.optional(S.Finite), sha256: S.optional(S.String) });
const Workflow = S.Struct({ id: S.String, name: S.String, group: S.String, graph: S.optional(S.Unknown), why: S.optional(S.String), sources: S.optional(S.Record(S.String, Source)), family: S.optional(S.String) });
// external: ComfyUI reports its model folders only while running, through /internal/folder_paths
const KnownFiles = S.Struct({ baseUrl: S.String, readAt: S.Finite, files: S.Record(S.String, S.Array(S.String)), classes: S.optional(S.Array(S.String)), workflows: S.optional(S.Array(Workflow)), folders: S.optional(S.Record(S.String, S.Array(S.String))) });
type KnownFiles = typeof KnownFiles.Type;
type ImageSettings = { imageGen: boolean; comfyUrl?: string; imageChoice?: ImageChoice; imageFolder?: string };

export interface ImageDeps extends ComfyClientDeps {
  admit?(): void;
  dataDir: string;
  lease: GpuLease;
  store: ThreadStore;
  push: Push;
  thumbnail?(jobId: string, png: Buffer): Promise<void>;
  settings(): ImageSettings;
  onSettings?(listener: (next: ImageSettings, previous: ImageSettings) => void): void;
  memory?: MemoryOwner;
  readGpu?(): Promise<{ freeBytes: number; holders: string; tenants?: readonly GpuHolder[] }>;
  gpuStatus?(): Promise<GpuStatus>;
  memTotal?(): Promise<number | undefined>;
  runNvidiaSmi?: NvidiaSmiRunner;
  service?: ComfyService;
  own?: OwnComfy;
  defaultUrl?: string;
  requiredBytes?: number;
  idleMs?: number;
  startupTimeoutMs?: number;
  jobTimeoutMs?: number;
  queueTimeoutMs?: number;
  stuckHoldMs?: number;
  faultForTest?: "stuck-picture-gives-the-card-back" | "stop-an-engine-the-app-did-not-start" | "picture-without-lease";
  localAddresses?(): readonly string[];
  lookupHost?(name: string): Promise<readonly string[]>;
  download?: Pick<DownloadOptions, "fetch" | "allow" | "freeBytes" | "intervalMs"> & { readonly records?: false };
  log?(line: string): void;
}

// why: setup and GPU status read this one held value rather than asking ComfyUI again
export interface ImageEngine {
  address?: string;
  owner: "app" | "outside" | "none";
  state: ImageStatus["state"];
  pid?: number;
  room?: number;
  files?: KnownFiles;
}

export interface ImageModule extends MemoryEngine {
  activeJobs?(): number;
  current(): ImageStatus;
  engine(): ImageEngine;
  status(): Promise<ImageStatus>;
  presets(): Promise<ImagePresets>;
  defaultChoice(): ImageChoice;
  runnable(): boolean;
  generate(params: Params<"image.generate">): Promise<{ jobId: string }>;
  cancel(jobId: string): { cancelled: boolean };
  download(preset: string): Promise<{ files: string[] }>;
  setupLeft(preset: string): Promise<number | undefined>;
  stopDownload(preset: string): { stopped: boolean };
  start(): Promise<ImagePresets>;
  // why: tests and the CLI await a job's end here, as its errors go out on image.event, not thrown
  wait(jobId: string): Promise<void>;
  stopIdle(signal?: AbortSignal): Promise<void>;
  reclaimable(): number | undefined;
  close(): Promise<void>;
  killRuntimeNow(): void;
}

const DEFAULT_URL = "http://127.0.0.1:8188";

export const IMAGES_UNSET = "Images are not set up on this computer. No ComfyUI answered; start one, or set its address in Settings › Image generation.";
export const notRunning = (baseUrl: string) => `ComfyUI at ${baseUrl} is not running. Start it there, then try again.`;

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

export function localAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) out.push(canonicalAddress(a.address));
  return out;
}

const lookupHost = async (name: string): Promise<readonly string[]> =>
  (await dns.lookup(name, { all: true, verbatim: true })).map((entry) => entry.address);

const isLocalAddress = (address: string, own: readonly string[]) => {
  const a = canonicalAddress(address);
  return /^127(\.\d{1,3}){3}$/.test(a) || a === "::1" || a === "0.0.0.0" || a === "::" || own.map(canonicalAddress).includes(a);
};

// external: with DNS search suffixes, comfy.lan. and comfy.lan can resolve to different hosts
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

const detail = (error: unknown) => error instanceof Error ? error.message : String(error);
const imageError = (code: string, message: string) => Object.assign(new Error(message), { code });
const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
const same = (a: ImageChoice, b: ImageChoice) => a.preset === b.preset && a.width === b.width && a.height === b.height;

// why: a busy processor took 9 minutes a step, so its limit is over five times the 4-minute promise
export const RUN_LIMIT_MS = { card: 600_000, cpu: 1_800_000 } as const;
const QUEUE_LIMIT_MS = 1_800_000;
const minutes = (ms: number) => Math.round(ms / 60_000);
export const ranLong = (min: number, stopped = true) => stopped
  ? `The picture took longer than the ${min}-minute limit on this computer, so the image engine stopped it. Try again when you are ready.`
  : `The picture took longer than the ${min}-minute limit on this computer, and the image engine is still stopping it.`;
// external: ComfyUI checks for an interrupt only between steps, and a processor step takes minutes
export const CANCEL_WAIT = { card: CANCEL_WAIT_MS, cpu: RUN_LIMIT_MS.cpu } as const;
// why: a load is one uninterruptible step, and the largest setup loads from a slow disk in less
export const STUCK_HOLD_MS = 300_000;
export const STUCK_HOLD_NOTE = "ComfyUI has not stopped the picture yet. Chat and new pictures wait until it has.";
export const waitedLong = (min: number) => `The picture waited ${min} minutes for its turn and did not start. Try again when you are ready.`;

export interface GpuHolder { pid: number; usedBytes?: number; label?: string; role?: string; system?: true; unnamed?: true }

export function fitSentence(needBytes: number, freeBytes: number, holders: readonly GpuHolder[], ours: readonly string[] | undefined, smaller?: string): string {
  const base = `The image needs ${gib(needBytes)} and ${gib(freeBytes)} is free`;
  const out = smaller === undefined ? "" : `; ${smaller} would fit`;
  const top = holders.filter((h) => (h.usedBytes ?? 0) > 0 && h.system !== true && h.unnamed !== true && h.role !== "whisper").toSorted((a, b) => (b.usedBytes ?? 0) - (a.usedBytes ?? 0))[0];
  if (top === undefined) return `${base}${out}.`;
  const held = gib(top.usedBytes ?? 0);
  if (top.role === "ollama") {
    if (ours === undefined) return `${base}; Ollama holds ${held}${out}.`;
    if (ours.length > 0) return `${base}; this app's chat model${ours.length === 1 ? ` ${ours[0]} still holds` : `s ${ours.join(", ")} still hold`} ${held}, try again in a moment${out}.`;
    return `${base}; a chat model this app did not load holds ${held}, stop it${out}.`;
  }
  return `${base}; ${top.label ?? `process ${top.pid}`} holds ${held}, close it${out}.`;
}

export function imageFitError(needBytes: number, freeBytes: number, holders: string, said?: string) {
  const shortfallBytes = Math.max(0, needBytes - freeBytes);
  return Object.assign(imageError("wont-fit", `Image generation needs ${gib(needBytes)}, ${gib(freeBytes)} free, ${gib(shortfallBytes)} short. GPU memory by process: ${holders}. Protected occupants are left running.`),
    { needBytes, freeBytes, shortfallBytes, holders, said: said ?? fitSentence(needBytes, freeBytes, [], []) });
}

export function imageRoom(gpu: GpuStatus | undefined, cpuOnly: boolean | undefined): number | undefined {
  if (cpuOnly === true) return 0;
  if (gpu === undefined || gpu.vendor === "unreadable") return undefined;
  if (gpu.vendor === "none") return cpuOnly === false ? undefined : 0;
  if (gpu.totalBytes === undefined) return undefined;
  return cardBytes(gpu.totalBytes);
}

const roomWords = (room: number | undefined): { noGpu?: string; slow?: string; unloadsChat?: boolean } =>
  room === 0 ? { slow: SLOW } : room === undefined ? {} : room < MIN_ROOM ? { noGpu: NO_GPU } : { unloadsChat: true };

const READ: StatusWriter = { kind: "read" };

export function createImageModule(deps: ImageDeps): ImageModule {
  const log = deps.log ?? ((line: string) => console.error(`[image] ${line}`));
  for (const job of deps.store.interruptImageJobs()) log(`job ${job.jobId} failed kind=restarted`);
  const systemUnit = deps.service ?? createComfyService();
  const jobs = new Map<string, { controller: AbortController; ended: Promise<void>; committing: boolean }>();
  let status: ImageStatus = { state: "off", owner: "none" };
  let owned: { pid: number; baseUrl: string } | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let activeJob: string | undefined;
  const stuck = new Map<string, { promptId: string; pid?: number }>();
  // why: a window that vanished mid-job must not leave the job holding the GPU
  const emit: Push = (channel, payload, changes) => { try { deps.push(channel, payload, changes); } catch {} };
  let presetsFor: ImageStatus["state"] | undefined;
  const move = (writer: StatusWriter, seen: Seen, baseUrl?: string): ImageStatus => {
    if (!mayWrite(writer, jobs.size, activeJob)) return status;
    status = engineStatus(seen, baseUrl === undefined ? { startedByApp: owned !== undefined } : { baseUrl, startedByApp: owned?.baseUrl === baseUrl, ...marked(baseUrl), ...ownMark(baseUrl) });
    emit("image.status", status);
    if ((status.state === "ready" || status.state === "off") && status.state !== presetsFor) { presetsFor = status.state; republish(); }
    return status;
  };
  const republish = () => { void module.presets().catch((error: unknown) => log(`presets not read again: ${detail(error)}`)); };
  const config = () => {
    const settings = deps.settings();
    const own = settings.comfyUrl === undefined && deps.own?.installed() === true ? deps.own.address() : undefined;
    const url = new URL(settings.comfyUrl ?? own ?? deps.defaultUrl ?? DEFAULT_URL);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw imageError("image-config", "Set a ComfyUI HTTP address without credentials or query parameters in Settings.");
    const baseUrl = url.href.replace(/\/$/, "");
    return { enabled: settings.imageGen, baseUrl, managed: settings.comfyUrl === undefined && (own !== undefined || (deps.defaultUrl === undefined && baseUrl === DEFAULT_URL)), hostname: url.hostname, addressSet: settings.comfyUrl !== undefined };
  };
  const missingWords = (baseUrl: string, asStatus = false) => {
    let set = false;
    // why: a bad address already reports its own config error, so this check stays quiet
    try { set = config().addressSet; } catch {}
    return !set ? IMAGES_UNSET : asStatus ? `No ComfyUI answers at ${baseUrl}.` : notRunning(baseUrl);
  };
  const marked = (baseUrl: string): { addressSet?: true } => {
    try { return config().addressSet && config().baseUrl === baseUrl ? { addressSet: true } : {}; } catch { return {}; }
  };
  const serviceAt = (baseUrl: string): ComfyService =>
    deps.own !== undefined && deps.own.installed() && deps.own.address().replace(/\/$/, "") === baseUrl ? deps.own : systemUnit;
  const ownMark = (baseUrl: string): { own?: true } => deps.own !== undefined && serviceAt(baseUrl) === deps.own ? { own: true } : {};
  const onProcessor = (baseUrl: string) => ownMark(baseUrl).own === true && deps.own?.build?.()?.cpu === true;
  const client = (baseUrl: string) => createComfyClient(baseUrl, deps);
  const filesPath = path.join(deps.dataDir, FILES_NAME);
  let known: KnownFiles | undefined;
  try { known = S.decodeUnknownSync(KnownFiles)(JSON.parse(readFileSync(filesPath, "utf8"))); }
  catch { known = undefined; }
  const remember = (baseUrl: string, lists: ComfyLists, read: { templates?: readonly KnownWorkflow[]; saved?: readonly KnownWorkflow[]; installed?: readonly KnownWorkflow[]; folders?: Record<string, string[]> } = {}) => {
    const before = known?.baseUrl === baseUrl ? known.workflows ?? [] : [];
    const kept = (prefix: string, fresh: readonly KnownWorkflow[] | undefined) => fresh ?? before.filter((w) => w.id.startsWith(prefix));
    const workflows = [...kept("template:", read.templates), ...kept("saved:", read.saved), ...kept("file:", read.installed)];
    const folders = read.folders ?? (known?.baseUrl === baseUrl ? known.folders : undefined);
    known = { baseUrl, readAt: Date.now(), files: lists.files, ...lists.classes === undefined ? {} : { classes: lists.classes }, ...workflows.length > 0 ? { workflows } : {}, ...folders === undefined ? {} : { folders } };
    try {
      const tmp = `${filesPath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(known));
      renameSync(tmp, filesPath);
    } catch (error) { log(`ComfyUI file list not kept: ${detail(error)}`); }
  };
  const knownFiles = (): KnownFiles | undefined => {
    try { return known?.baseUrl === config().baseUrl ? known : undefined; }
    catch { return undefined; }
  };
  let extraFor: { record: KnownFiles; presets: readonly Preset[] } | undefined;
  // why: worked out once per read record, so each presets call does not convert them again
  const extras = (): readonly Preset[] => {
    const record = knownFiles();
    if (record === undefined) return [];
    if (extraFor?.record !== record) extraFor = { record, presets: (record.workflows ?? []).map(workflowPreset) };
    return extraFor.presets;
  };
  const clearIdle = () => { clearTimeout(idleTimer); idleTimer = undefined; };
  const armIdle = () => {
    clearIdle();
    if (!owned || closed) return;
    idleTimer = setTimeout(() => { void module.stopIdle().catch((error: unknown) => {
      move({ kind: "fact" }, { state: "error", answering: status.owner !== "none", detail: `ComfyUI idle stop failed: ${detail(error)}` }, status.baseUrl);
      if (owned) armIdle();
    }); }, deps.idleMs ?? 300_000);
    idleTimer.unref();
  };
  const nowhere = async (cfg: ReturnType<typeof config>): Promise<boolean> => {
    if (cfg.addressSet || deps.own?.installed() === true) return false;
    try {
      if (cfg.managed && (await serviceAt(cfg.baseUrl).inspect()).present) return false;
      return !await client(cfg.baseUrl).healthy();
    } catch { return false; }
  };
  const discover = async (): Promise<ImageStatus> => {
    const cfg = config();
    if (!cfg.enabled) return move({ kind: "fact" }, { state: "off", nowhere: await nowhere(cfg) });
    if (await client(cfg.baseUrl).healthy()) {
      if (owned && cfg.managed) {
        const unit = await serviceAt(cfg.baseUrl).inspect();
        if (unit.pid !== owned.pid || !unit.active) owned = undefined;
      }
      return move(READ, { state: "ready" }, cfg.baseUrl);
    }
    const unit = cfg.managed ? await serviceAt(cfg.baseUrl).inspect() : { present: false, active: false, activeState: "unknown", pid: 0 };
    const starting =unit.present && !["inactive", "failed"].includes(unit.activeState);
    if (owned?.baseUrl === cfg.baseUrl && (!unit.active || unit.pid !== owned.pid)) owned = undefined;
    return move(READ, starting ? { state: "starting", answering: true, detail: "Couldn't reach ComfyUI because it is still starting; try again in a moment." }
      : unit.present ? { state: "stopped", detail: "ComfyUI will start when you make an image." } : { state: "missing", detail: missingWords(cfg.baseUrl, true) }, cfg.baseUrl);
  };
  const measure = deps.readGpu ?? (async () => {
    const gpu = await readGpu(deps.runNvidiaSmi);
    // external: ComfyUI runs a job on one card, so free memory on several cards does not add up
    return { freeBytes: gpu.cards?.[0]?.freeBytes ?? gpu.freeBytes, tenants: gpu.tenants, holders: holdersSummary(gpu.tenants, gib) };
  });
  const fit = async (cfg: ReturnType<typeof config>, needBytes: number, want: Want, signal: AbortSignal, freeing: (on: boolean) => void): Promise<Want | undefined> => {
    if (!await isLocalHost(cfg.hostname, deps.localAddresses?.() ?? localAddresses(), deps.lookupHost ?? lookupHost, signal)) return undefined;
    signal.throwIfAborted();
    if (onProcessor(cfg.baseUrl)) return undefined;
    const stats = await client(cfg.baseUrl).stats(signal).catch(() => undefined);
    signal.throwIfAborted();
    if (stats && stats.devices.length > 0 && stats.devices.every((device) => device.type === "cpu")) return undefined;
    const estimate = deps.requiredBytes ?? needBytes;
    const decide = async () => {
      let asked = false;
      const handoff = await deps.memory?.handoff(want, signal, { onLeave: (on) => { if (on) { asked = true; freeing(true); } } });
      const fits = () => { if (asked) freeing(false); };
      if (handoff?.engine === "kept") return fits();
      const gpu = await measure();
      signal.throwIfAborted();
      if (!Number.isFinite(gpu.freeBytes) || gpu.freeBytes < 0) throw new Error(asked ? "GPU free memory could not be measured after unloading what held it. Retry when the GPU status is available." : "GPU free memory could not be measured. Retry when the GPU status is available.");
      if (imageFitVerdict({ estimateBytes: estimate, freeBytes: gpu.freeBytes, creditedBytes: 0 }).verdict === "fits") return fits();
      const others = (gpu.tenants ?? []).filter((tenant) => !(owned !== undefined && tenant.pid === owned.pid));
      const smaller = smallerFit(knownFiles(), estimate, gpu.freeBytes, extras());
      const said = fitSentence(estimate, gpu.freeBytes, others, handoff === undefined ? [] : handoff.stayed, smaller);
      throw imageFitError(estimate, gpu.freeBytes, gpu.holders, handoff?.engine === "busy" ? `${said} ${ENGINE_BUSY_NOTE}` : said);
    };
    const memory = deps.memory;
    if (memory === undefined) {
      await decide();
      return want;
    }
    return memory.gate(async () => {
      try {
        await decide();
      } catch (error) {
        memory.ended();
        throw error;
      }
      memory.stage(want, "loading");
      return want;
    });
  };
  const ensure = async (writer: StatusWriter, baseUrl: string, managed: boolean, signal: AbortSignal) => {
    const comfy = client(baseUrl);
    const service = serviceAt(baseUrl);
    if (await comfy.healthy()) {
      if (owned && managed) { const unit = await service.inspect(); if (owned.pid !== unit.pid || !unit.active) owned = undefined; }
      return comfy;
    }
    const before = managed ? await service.inspect() : { present: false, active: false, activeState: "unknown", pid: 0 };
    if (!before.present) throw imageError("image-missing", missingWords(baseUrl));
    const canStart = ["inactive", "failed"].includes(before.activeState);
    move(writer, { state: "starting", answering: !canStart }, baseUrl);
    signal.throwIfAborted();
    const up = async () => {
      if (canStart) {
        await service.start();
        const after = await service.inspect();
        if (!after.active || after.pid <= 0) throw new Error("ComfyUI started but is not running. Check its log, then try again.");
        owned = { pid: after.pid, baseUrl };
      }
      const deadline = Date.now() + (deps.startupTimeoutMs ?? 60_000);
      while (!await comfy.healthy()) {
        signal.throwIfAborted();
        if (Date.now() >= deadline) throw new Error("ComfyUI did not become ready within the startup timeout. Check its log, then try again.");
        if (service === deps.own && !(await service.inspect()).active) { owned = undefined; throw new Error("ComfyUI stopped while it was starting. Check its log, then try again."); }
        await delay(250, undefined, { signal });
      }
    };
    const mine = canStart && service === deps.own ? deps.own : undefined;
    try { await up(); }
    catch (error) {
      if (mine === undefined || signal.aborted || (await mine.inspect().catch(() => undefined))?.active !== false) throw error;
      const passed = mine.failed?.();
      if (passed === undefined) throw error;
      owned = undefined;
      log(`the image engine's card build ${passed} was not there after its start (${detail(error)}); the processor's build runs in its place`);
      await up();
      await readRoom(signal).catch(() => undefined);
    }
    mine?.answered?.();
    signal.throwIfAborted();
    return comfy;
  };
  const pinsPath = path.join(deps.dataDir, "image-pins.json");
  const readPins = (): Record<string, string> => {
    try { return S.decodeUnknownSync(S.Record(S.String, S.String))(JSON.parse(readFileSync(pinsPath, "utf8"))); }
    catch { return {}; }
  };
  const writePins = (pins: Record<string, string>) => {
    try { const tmp = `${pinsPath}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(pins)); renameSync(tmp, pinsPath); }
    catch (error) { log(`image download pins not kept: ${detail(error)}`); }
  };
  let downloading: Promise<void> | undefined, downloads: AbortController | undefined;
  let downloadOf: string | undefined, lastDownload: ImageDownload | undefined;
  const say = (p: ImageDownload) => { lastDownload = p; emit("image.download", p); };
  const learned = new Map<string, number>();
  type Cfg = ReturnType<typeof config>;
  const downloadPlace = (cfg: Cfg): { root?: string; picked: boolean; dirOf?: (kind: string) => string | undefined } | undefined => {
    if (!isLocalComfy(cfg.baseUrl)) return undefined;
    const picked = deps.settings().imageFolder;
    if (picked !== undefined) return { root: picked, picked: true, dirOf: (kind) => path.join(picked, kind, "gates-local") };
    const own = serviceAt(cfg.baseUrl) === deps.own ? deps.own?.modelsDir?.() : undefined;
    if (own !== undefined) return { root: own, picked: false, dirOf: (kind) => path.join(own, kind, "gates-local") };
    const folders = knownFiles()?.folders;
    const firsts = (folders === undefined ? [] : MODEL_KINDS.map((k) => folders[k]?.[0])).filter((f): f is string => f !== undefined);
    if (folders === undefined || firsts.length === 0) return { picked: false };
    return { root: sharedFolder(firsts), picked: false, dirOf: (kind) => { const first = folders[kind]?.[0]; return first === undefined ? undefined : path.join(first, "gates-local"); } };
  };
  const freeAt = (dir: string) => (deps.download?.freeBytes ?? volumeFree)(dir).then((b) => Math.floor(b));
  const diskRow = async (cfg: Cfg): Promise<NonNullable<ImagePresets["disk"]> | undefined> => {
    const place = downloadPlace(cfg);
    if (place === undefined) return undefined;
    if (place.root === undefined) return { picked: place.picked };
    const free = await freeAt(place.root).catch(() => undefined);
    const line = place.picked && serviceAt(cfg.baseUrl) !== deps.own ? { line: extraModelPathsLine(place.root) } : {};
    return { folder: place.root, ...free === undefined ? {} : { freeBytes: free }, picked: place.picked, ...line };
  };
  interface Planned { readonly name: string; readonly url: string; readonly dir: string; readonly sha256?: string; readonly bytes?: number }
  const leftOf = (files: readonly Planned[], sizes: readonly (number | undefined)[]) => Promise.all(files.map(async (f, i) => {
    const size = sizes[i];
    if (await haveFile(f.dir, f.name, size)) return 0;
    return size === undefined ? undefined : Math.max(0, size - await partBytes(f.dir, f.name, f.url));
  }));
  const knownSize = (f: Planned) => (deps.download?.records === false ? undefined : f.bytes) ?? learned.get(f.url);
  const plannedFiles = (id: string, names: readonly string[], cfg: Cfg): Planned[] => {
    const preset = appPreset(id) ?? extras().find((p) => p.id === id);
    const place = downloadPlace(cfg);
    return names.flatMap((name) => {
      const source = preset?.sources?.[name];
      const dir = source?.directory === undefined ? undefined : place?.dirOf?.(source.directory);
      return source?.url === undefined || dir === undefined ? [] : [{ name: path.basename(name), url: source.url, dir, ...source.sha256 === undefined ? {} : { sha256: source.sha256 }, ...source.bytes === undefined ? {} : { bytes: source.bytes } }];
    });
  };
  const leftToFetch = async (id: string, names: readonly string[], cfg: Cfg): Promise<number | undefined> => {
    const files = plannedFiles(id, names, cfg);
    if (files.length !== names.length) return undefined;
    const left = await leftOf(files, files.map(knownSize));
    return left.every((b) => b !== undefined) ? left.reduce((a, b) => a + b, 0) : undefined;
  };
  const setupLeft = async (id: string): Promise<number | undefined> => {
    const preset = appPreset(id);
    const root = deps.settings().imageFolder ?? deps.own?.modelsDir?.();
    if (preset === undefined || root === undefined) return undefined;
    const left = await Promise.all([...new Set(presetFiles(preset))].map(async (name) => {
      const source = preset.sources?.[name];
      if (source?.url === undefined || source.directory === undefined) return undefined;
      const file: Planned = { name: path.basename(name), url: source.url, dir: path.join(root, source.directory, "gates-local"), ...source.bytes === undefined ? {} : { bytes: source.bytes } };
      if (await haveFile(file.dir, file.name, knownSize(file))) return 0;
      return knownSize(file);
    }));
    return left.every((b) => b !== undefined) ? left.reduce((a, b) => a + b, 0) : undefined;
  };
  const roomFor = async (files: readonly Planned[], sizes: readonly (number | undefined)[]) => {
    const left = await leftOf(files, sizes);
    const volumes = new Map<number, { dirs: string[]; need: number }>();
    for (const [i, f] of files.entries()) {
      const bytes = left[i];
      if (bytes === undefined || bytes === 0) continue;
      const volume = await volumeOf(f.dir);
      const at = volumes.get(volume) ?? { dirs: [], need: 0 };
      at.dirs.push(path.dirname(path.dirname(f.dir))); at.need += bytes;
      volumes.set(volume, at);
    }
    for (const { dirs, need } of volumes.values()) {
      const folder = sharedFolder(dirs);
      const free = await freeAt(folder);
      if (free < need) throw imageError("image-disk", `Not enough disk space in ${folder}: ${gib(need)} is left to fetch and ${gib(free)} is free.`);
    }
  };
  let lastRoom: number | undefined;
  let lastRam: number | undefined;
  const readRoom = async (signal?: AbortSignal): Promise<number | undefined> => {
    const unknown = () => { lastRam = undefined; return lastRoom = undefined; };
    if (deps.gpuStatus === undefined) return unknown();
    let cfg: ReturnType<typeof config>;
    try { cfg = config(); } catch { return unknown(); }
    if (!await isLocalHost(cfg.hostname, deps.localAddresses?.() ?? localAddresses(), deps.lookupHost ?? lookupHost, signal)) return unknown();
    const stats = await client(cfg.baseUrl).stats(signal).catch(() => undefined);
    signal?.throwIfAborted();
    const gpu = await deps.gpuStatus().catch(() => undefined);
    signal?.throwIfAborted();
    lastRam = await deps.memTotal?.().catch(() => undefined);
    signal?.throwIfAborted();
    const cpuOnly = onProcessor(cfg.baseUrl) || (stats === undefined || stats.devices.length === 0 ? undefined : stats.devices.every((d) => d.type === "cpu"));
    return lastRoom = imageRoom(gpu, cpuOnly);
  };
  const cancelWaitMs = () => lastRoom === 0 ? CANCEL_WAIT.cpu : CANCEL_WAIT.card;
  const closing = new AbortController();
  const heldWhileStuck = async (writer: StatusWriter, onCard: () => boolean, at: () => string, job: () => Promise<void>): Promise<void> => {
    try { await job(); }
    catch (error) {
      const promptId = error instanceof Error && "stuckPromptId" in error && typeof error.stuckPromptId === "string" ? error.stuckPromptId : undefined;
      if (promptId === undefined || !onCard() || deps.faultForTest === "stuck-picture-gives-the-card-back") throw error;
      const baseUrl = at(), comfy = client(baseUrl);
      move(writer, { state: "busy", answering: true, detail: STUCK_HOLD_NOTE }, baseUrl);
      const until = Date.now() + (deps.stuckHoldMs ?? STUCK_HOLD_MS);
      let ended: "left" | "gone" | "limit" | "closing" | undefined;
      let unanswered = 0;
      while (ended === undefined) {
        try { await comfy.cancelPrompt(promptId, Math.max(0, until - Date.now()), closing.signal); ended = "left"; }
        catch {
          if (closing.signal.aborted) ended = "closing";
          else if (Date.now() >= until) ended = "limit";
          else if (await comfy.healthy()) unanswered = 0;
          else if (++unanswered >= 2) ended = "gone";
          if (ended === undefined) await new Promise<void>((resolve) => {
            const done = () => { clearTimeout(timer); closing.signal.removeEventListener("abort", done); resolve(); };
            const timer = setTimeout(done, 1_000);
            closing.signal.addEventListener("abort", done, { once: true });
          });
        }
      }
      if (ended === "limit") {
        const service = serviceAt(baseUrl);
        const unit = await service.inspect().catch(() => undefined);
        if (unit?.active === true && ((owned?.baseUrl === baseUrl && unit.pid === owned.pid) || deps.faultForTest === "stop-an-engine-the-app-did-not-start")) {
          await service.stop();
          forgetGpuReadings();
          owned = undefined;
          deps.memory?.engineGone();
          log(`ComfyUI kept a stopped picture for ${minutes(deps.stuckHoldMs ?? STUCK_HOLD_MS)} more minutes; the app started it, so the app stopped it`);
          ended = "gone";
        }
      }
      if (ended === "limit" || ended === "closing") throw error;
      const stopped = error as { stuckPromptId?: string; cancelDetail?: string };
      delete stopped.stuckPromptId; delete stopped.cancelDetail;
      throw error;
    }
  };
  const claimed = (signal: AbortSignal, job: () => Promise<void>): Promise<void> =>
    deps.faultForTest === "picture-without-lease" ? job() : deps.lease.run("image", signal, job);
  const chooseDefault = () => defaultChoice(knownFiles(), extras(), lastRoom, lastRam) ?? DEFAULT_CHOICE;
  const currentChoice = () => describeChoice(deps.settings().imageChoice ?? chooseDefault(), chooseDefault(), extras());
  deps.own?.onExit((pid) => {
    if (owned?.pid !== pid) return;
    const baseUrl = owned.baseUrl;
    owned = undefined;
    clearIdle();
    deps.memory?.engineGone();
    move(READ, { state: "stopped", detail: "ComfyUI stopped on its own. It starts again when you make an image; its log says why." }, baseUrl);
  });
  let presetsBegun = 0, presetsSent = 0;
  const readPresets = async (): Promise<ImagePresets> => {
    const cfg = config();
    if (!cfg.enabled) return { presets: [], current: currentChoice() };
    const comfy = client(cfg.baseUrl);
    if (await comfy.healthy()) {
      try {
        const [{ lists, ...read }, folders] = await Promise.all([comfy.catalog(), comfy.folders()]);
        remember(cfg.baseUrl, lists, { ...read, ...folders === undefined ? {} : { folders } });
      } catch (error) { log(`ComfyUI file list not read: ${detail(error)}`); }
    }
    const room = await readRoom();
    const last = knownFiles();
    const disk = await diskRow(cfg);
    const onDisk = disk === undefined ? {} : { disk };
    if (last === undefined) return { presets: [], current: currentChoice(), ...roomWords(room), ...onDisk };
    const { ready, others } = listPresets(last, extras(), room, lastRam);
    const tiers = tiersFor(room);
    const tag = <T extends { id: string }>(p: T): T => { const t = tiers.find((x) => sameRow(x.preset, p.id)); return t === undefined ? p : { ...p, tier: t.tier }; };
    const counted = await Promise.all(others.map(async (p) => {
      if (p.needs?.download !== true) return p;
      const left = await leftToFetch(p.id, p.needs.files, cfg);
      return left === undefined ? p : { ...p, needs: { ...p.needs, leftBytes: left } };
    }));
    // why: it is read after the last await, so a push made during the reads above is not missed
    const download = lastDownload?.ended === true ? undefined : lastDownload;
    const chosen = currentChoice();
    const row = ready.find((p) => p.id !== chosen.preset.id && sameRow(p.id, chosen.preset.id) && p.sizes.some((z) => z.width === chosen.width && z.height === chosen.height));
    const current = row === undefined ? chosen : { ...chosen, preset: row };
    return { presets: ready.map(tag), ...counted.length > 0 ? { others: counted.map(tag) } : {}, readAt: last.readAt, current,...roomWords(room), ...download === undefined ? {} : { download }, ...onDisk };
  };
  const module: ImageModule = {
    current: () => status,
    engine: () => {
      const files = knownFiles();
      return {
        ...status.baseUrl === undefined ? {} : { address: status.baseUrl },
        owner: status.owner === "app" ? "app" : status.owner === "external" ? "outside" : "none",
        state: status.state,
        ...owned === undefined ? {} : { pid: owned.pid },
        ...lastRoom === undefined ? {} : { room: lastRoom },
        ...files === undefined ? {} : { files },
      };
    },
    activeJobs: () => jobs.size,
    status: async () => {
      const read = await discover();
      await readRoom().catch(() => undefined);
      return read;
    },
    defaultChoice: chooseDefault,
    runnable() {
      const files = knownFiles();
      return files !== undefined && roomWords(lastRoom).noGpu === undefined && listPresets(files, extras(), lastRoom, lastRam).ready.length > 0;
    },
    async presets() {
      const begun = ++presetsBegun;
      const value = await readPresets();
      if (begun > presetsSent) { presetsSent = begun; emit("image.presets", value); }
      return value;
    },
    async start() {
      if (closed) throw imageError("shutting-down", "Image generation is shutting down.");
      const cfg = config();
      if (!cfg.enabled) throw imageError("image-off", "Image generation is off. Turn it on in Settings first.");
      if (jobs.size === 0) {
        await ensure(READ, cfg.baseUrl, cfg.managed, AbortSignal.timeout((deps.startupTimeoutMs ?? 60_000) + 5_000));
        move(READ, { state: "ready" }, cfg.baseUrl);
        armIdle();
      }
      return module.presets();
    },
    async generate(params) {
      if (closed) throw imageError("shutting-down", "Image generation is shutting down.");
      deps.admit?.();
      let cfg = { enabled: false, baseUrl: "", managed: false, hostname: "", addressSet: false };
      const kept = liveChoice(params.threadId ? deps.store.imageChoiceOf(params.threadId) : undefined);
      const jobId = randomUUID();
      const writer: StatusWriter = { kind: "job", jobId };
      let prompt = params.prompt;
      const saved = kept ?? liveChoice(deps.settings().imageChoice);
      let choice = params.choice ?? saved ?? chooseDefault();
      let unset = saved === undefined && isDefaultChoice(params.choice);
      if (params.retryOf !== undefined) {
        if (!params.threadId) throw imageError("bad-params", "An image retry must name its thread.");
        const retry = deps.store.claimImageRetry(params.threadId, params.retryOf, jobId, choice);
        if (!retry.created) return { jobId: retry.jobId };
        prompt = retry.prompt;
        choice = retry.choice;
        unset = saved === undefined && isDefaultChoice(retry.choice);
      } else resolveChoice(choice, extras());
      if (!prompt.trim()) throw imageError("bad-params", "Describe the image you want to make.");
      const sent = choice;
      const group = params.retryOf === undefined ? params.group : undefined;
      const pinIn = params.retryOf === undefined ? params.threadId : undefined;
      if (pinIn !== undefined && !unset && (kept === undefined || !same(choice, kept))) {
        try {
          deps.store.setImageChoice(pinIn, choice);
          emit(...threadChanged(deps.store, pinIn));
        } catch {}
      }
      clearIdle();
      const controller = new AbortController();
      const deadline = new AbortController();
      const signal = AbortSignal.any([controller.signal, deadline.signal]);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let timedOut: "queue" | "run" | undefined;
      let runFrom = 0, runLimit = 0;
      const runLimitMs = () => deps.jobTimeoutMs ?? (lastRoom === 0 ? RUN_LIMIT_MS.cpu : RUN_LIMIT_MS.card);
      let shown = 0;
      const armRun = (ms: number) => {
        clearTimeout(timeout);
        runLimit = ms;
        timeout = setTimeout(() => { timedOut = "run"; deadline.abort(new Error("Image run timed out.")); }, Math.max(0, runFrom + ms - Date.now()));
        timeout.unref();
      };
      let stage = "image-config";
      let staged: Want | undefined;
      let sampled = false;
      const event = (state: ImageEvent["state"], rest: Partial<ImageEvent> = {}, picture?: PictureFacts) => {
        if (rest.stage === "sampling" || rest.stage === "decoding") sampled = true;
        const payload: ImageEvent = { jobId, ...params.threadId ? { threadId: params.threadId } : {}, state, choice, ...same(choice, sent) ? {} : { sent }, ...group ? { group } : {}, ...sampled ? { sampled: true } : {}, ...rest };
        deps.store.saveImageJob(payload, prompt, picture);
        emit("image.event", payload);
      };
      event("queued");
      timeout = setTimeout(() => { timedOut = "queue"; deadline.abort(new Error("Image queue timed out.")); }, deps.queueTimeoutMs ?? QUEUE_LIMIT_MS);
      timeout.unref();
      // why: the work waits a tick, so the job is in jobs before it runs and generate returns first
      const ended = Promise.resolve().then(async () => {
        try {
          await claimed(signal, () => heldWhileStuck(writer, () => staged !== undefined, () => cfg.baseUrl, async () => {
            runFrom = Date.now();
            armRun(runLimitMs());
            const latest = config();
            if (!latest.enabled) throw imageError("image-off", "Image generation was turned off while this job waited.");
            cfg = latest;
            activeJob = jobId;
            event("running", { progress: 0 });
            move(writer, { state: "busy", answering: false }, cfg.baseUrl);
            let { size } = resolveChoice(choice, extras());
            const freeing = (on: boolean) => event("running", on ? { progress: 0, phase: "freeing" } : { progress: 0 });
            const read = async (from: Awaited<ReturnType<typeof ensure>>) => {
              try { remember(cfg.baseUrl, await from.files(signal)); }
              catch (error) { signal.throwIfAborted(); log(`ComfyUI file list not read: ${detail(error)}`); }
            };
            const settle = async () => {
              const settled = defaultChoice(knownFiles(), extras(), await readRoom(signal), lastRam);
              if (settled === undefined) throw Object.assign(imageError("wont-fit", NO_GPU), { said: NO_GPU });
              if (same(settled, choice)) return;
              choice = settled;
              republish();
              ({ size } = resolveChoice(choice, extras()));
              event("running", { progress: 0 });
            };
            stage = "image-missing";
            const early = unset && knownFiles() === undefined ? await ensure(writer, cfg.baseUrl, cfg.managed, signal) : undefined;
            if (early) await read(early);
            if (unset) await settle();
            stage = "image-fit";
            staged = await fit(cfg, size.bytes, { kind: "image", setup: imageSetup(choice) }, signal, freeing);
            stage = "image-missing";
            const comfy = early ?? await ensure(writer, cfg.baseUrl, cfg.managed, signal);
            if (unset && !early) {
              await read(comfy);
              const was = choice;
              await settle();
              if (!same(was, choice)) {
                stage = "image-fit";
                staged = await fit(cfg, size.bytes, { kind: "image", setup: imageSetup(choice) }, signal, freeing);
              }
            }
            stage = "image-render";
            if (lastRoom === undefined && deps.jobTimeoutMs === undefined) await readRoom(signal).catch(() => signal.throwIfAborted());
            const earlier = stuck.get(cfg.baseUrl);
            if (earlier && (await comfy.running(signal)).includes(earlier.promptId)) {
              const busy = imageError("image-busy", "ComfyUI is still running an earlier image from this app that did not stop when cancelled. Wait for it to finish, then retry.");
              if (lastRoom !== 0) throw busy;
              clearTimeout(timeout);
              await comfy.cancelPrompt(earlier.promptId, cancelWaitMs(), signal).catch((error: unknown) => { signal.throwIfAborted(); throw Object.assign(busy, { cause: error }); });
              runFrom = Date.now();
              armRun(runLimitMs());
            }
            if (earlier) stuck.delete(cfg.baseUrl);
            if (runLimitMs() !== runLimit) armRun(runLimitMs());
            move(writer, { state: "busy", answering: true }, cfg.baseUrl);
            const started = performance.now();
            const { bytes, seed, steps } = await comfy.render(prompt, jobId, signal, (progress, said) => { shown = progress; event("running", { progress, ...said }); }, () => {
              const job = jobs.get(jobId);
              if (job) job.committing = true;
              clearTimeout(timeout);
            }, choice, extras(), params.seed, {
              waitMs: cancelWaitMs(),
              stopping: () => event("running", { progress: shown, phase: "stopping" }),
            });
            const runMs = Math.round(performance.now() - started);
            const imagePath = `images/${jobId}.png`;
            stage = "image-save";
            await mkdir(path.join(deps.dataDir, "images"), { recursive: true });
            const pendingPath = path.join(deps.dataDir, "images", `${jobId}.pending`);
            await writeFile(pendingPath, bytes, { flag: "wx" });
            await rename(pendingPath, path.join(deps.dataDir, imagePath));
            await deps.thumbnail?.(jobId, bytes).catch((error: unknown) => log(`thumbnail for ${jobId} not made: ${detail(error)}`));
            if (unset && pinIn !== undefined) deps.store.fillImageChoice(pinIn, choice);
            const made = await pngFacts(bytes) ?? size;
            if (staged !== undefined) deps.memory?.settled(staged);
            staged = undefined;
            event("done", { progress: 1, imagePath, runMs }, { width: made.width, height: made.height, seed, ...steps === undefined ? {} : { steps }, runMs, bytes: bytes.length });
            if (params.threadId) emit(...threadChanged(deps.store, params.threadId));
            move(writer, { state: "ready" }, cfg.baseUrl);
          }));
        } catch (error) {
          if (staged !== undefined) deps.memory?.ended();
          staged = undefined;
          const cancelDetail = error instanceof Error && "cancelDetail" in error && typeof error.cancelDetail === "string" ? error.cancelDetail : undefined;
          const stuckPromptId = error instanceof Error && "stuckPromptId" in error && typeof error.stuckPromptId === "string" ? error.stuckPromptId : undefined;
          const late = controller.signal.aborted ? undefined
            : timedOut === "run" ? ranLong(minutes(runLimit), stuckPromptId === undefined) : timedOut === "queue" ? waitedLong(minutes(deps.queueTimeoutMs ?? QUEUE_LIMIT_MS)) : undefined;
          const message = late ?? detail(error);
          if (stuckPromptId) stuck.set(cfg.baseUrl, { promptId: stuckPromptId, ...owned?.baseUrl === cfg.baseUrl ? { pid: owned.pid } : {} });
          const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : stage;
          const missingFile = error instanceof Error && "file" in error && typeof error.file === "string" ? error.file : undefined;
          const noComfy = error instanceof Error && "code" in error && error.code === "image-missing";
          const reasons: Record<string, string> = {
            "image-config": "Check the ComfyUI address in Settings, then try again.",
            "image-off": "Turn on image generation in Settings, then try again.",
            "image-fit": "GPU memory could not be checked; check the GPU status and try again.",
            "wont-fit": "There is not enough GPU memory for this image.",
            "image-missing": noComfy ? missingWords(cfg.baseUrl) : "ComfyUI did not start. Check its log, then try again.",
            "image-model": missingFile === undefined ? "Pick an image model ComfyUI has, then try again." : `Install ${missingFile} in ComfyUI, then try again.`,
            "image-busy": "ComfyUI is busy; wait for its other job to finish and try again.",
            "image-disconnected": "ComfyUI disconnected; wait until it is ready and try again.",
            "image-workflow": "ComfyUI did not make an image; check its workflow and try again.",
            "image-result": "ComfyUI returned an invalid image; check its workflow and try again.",
            "image-render": "The image did not finish; check ComfyUI and try again.",
            "image-save": "The image could not be saved; check free disk space and try again.",
          };
          const errorKind = controller.signal.aborted ? "cancelled" : timedOut ? "timeout" : Object.hasOwn(reasons, code) ? code : stage;
          const reason = controller.signal.aborted ? "The image was cancelled; try again when you are ready." : late !== undefined ? late
            : errorKind === "wont-fit" && error instanceof Error && "said" in error && typeof error.said === "string" ? error.said : reasons[errorKind];
          log(`job ${jobId} failed kind=${errorKind}`);
          event(controller.signal.aborted ? "cancelled" : "error", { message: reason, errorKind });
          const ran = activeJob === jobId;
          if (cancelDetail && ran) {
            move(writer, { state: "error", answering: stuckPromptId !== undefined, detail: `${message} ${cancelDetail}` }, cfg.baseUrl);
          } else if ((controller.signal.aborted || timedOut === "run") && ran) {
            const healthy = await client(cfg.baseUrl).healthy();
            move(writer, healthy ? { state: "ready" } : { state: "stopped" }, cfg.baseUrl);
          } else if (!controller.signal.aborted && noComfy) {
            move(writer, { state: "missing", detail: missingWords(cfg.baseUrl, true) }, cfg.baseUrl);
          } else if (!controller.signal.aborted) {
            move(writer, { state: "error", answering: false, detail: message }, cfg.baseUrl);
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
      if (!job || job.committing) return { cancelled: false };
      if (!job.controller.signal.aborted) job.controller.abort(new Error("Image cancelled."));
      return { cancelled: true };
    },
    async wait(jobId) { await jobs.get(jobId)?.ended; },
    async stopIdle(signal) {
      clearIdle();
      if (!owned || jobs.size > 0) return;
      await deps.lease.run("image", signal, async () => {
        if (!owned || jobs.size > 0) return;
        const service = serviceAt(owned.baseUrl);
        const unit = await untilAborted(service.inspect(), signal);
        const mine = stuck.get(owned.baseUrl);
        if (!unit.active || unit.pid !== owned.pid) { owned = undefined; return; }
        // external: other clients can queue prompts on the same ComfyUI at any time
        signal?.throwIfAborted();
        if (!await untilAborted(client(owned.baseUrl).idle(mine?.pid === owned.pid ? mine.promptId : undefined), signal)) { armIdle(); return; }
        signal?.throwIfAborted();
        const latest = await untilAborted(service.inspect(), signal);
        if (!latest.active || latest.pid !== owned.pid) { owned = undefined; return; }
        if (jobs.size > 0) return;
        signal?.throwIfAborted();
        await service.stop();
        forgetGpuReadings();
        const baseUrl = owned.baseUrl; owned = undefined;
        stuck.delete(baseUrl);
        deps.memory?.engineGone();
        move({ kind: "fact" }, { state: "stopped" }, baseUrl);
      }).catch((error: unknown) => {
        if (signal?.aborted) armIdle();
        throw error;
      });
    },
    reclaimable: () => (owned && jobs.size === 0 && !closed ? owned.pid : undefined),
    // external: ComfyUI's POST /free with unload_models and free_memory unloads every model
    async leave(signal) {
      let cfg: ReturnType<typeof config>;
      try { cfg = config(); }
      catch { return "absent"; }
      if (!cfg.enabled) return "absent";
      if (!await isLocalHost(cfg.hostname, deps.localAddresses?.() ?? localAddresses(), deps.lookupHost ?? lookupHost, signal)) return "absent";
      const comfy = client(cfg.baseUrl);
      if (!await comfy.healthy()) return "absent";
      signal.throwIfAborted();
      const answer: EngineLeave = await comfy.free(signal);
      return answer;
    },
    ours() {
      let cfg: ReturnType<typeof config>;
      try { cfg = config(); }
      catch { return true; }
      return !cfg.enabled || owned?.baseUrl === cfg.baseUrl;
    },
    // external: ComfyUI's /system_stats gives what torch holds on each card as torch_vram_total
    async holds(signal) {
      let cfg: ReturnType<typeof config>;
      try { cfg = config(); }
      catch { return undefined; }
      if (!cfg.enabled) return undefined;
      if (!await isLocalHost(cfg.hostname, deps.localAddresses?.() ?? localAddresses(), deps.lookupHost ?? lookupHost, signal)) return undefined;
      const stats = await client(cfg.baseUrl).stats(signal).catch(() => undefined);
      return stats?.devices.filter((d) => d.type !== "cpu").reduce((sum, d) => sum + (d.torch_vram_total ?? 0), 0);
    },
    killRuntimeNow() {
      if (!owned) return;
      const { pid, baseUrl } = owned;
      owned = undefined;
      serviceAt(baseUrl).killRuntimeNow?.(pid);
    },
    async download(id) {
      const cfg = config();
      if (!cfg.enabled) throw imageError("image-off", "Image generation is off. Turn it on in Settings first.");
      if (downloads !== undefined) throw imageError("image-download", "A model download is already running; it finishes first.");
      const controller = new AbortController();
      downloads = controller; downloadOf = id; lastDownload = undefined;
      try { return await startDownload(id, cfg, controller); }
      catch (error) { if (downloading === undefined) { downloads = undefined; downloadOf = undefined; } throw error; }
    },
    setupLeft,
    stopDownload(id) {
      if (downloads === undefined || downloadOf !== id || downloads.signal.aborted) return { stopped: false };
      downloads.abort(new Error("Download stopped.")); return { stopped: true };
    },
    async close() {
      closed = true; clearIdle();
      closing.abort(new Error("Image generation is shutting down."));
      downloads?.abort(new Error("Image generation is shutting down."));
      await downloading;
      const pending = [...jobs.values()];
      for (const job of pending) if (!job.committing) job.controller.abort(new Error("Image generation is shutting down."));
      await Promise.all(pending.map((job) => job.ended));
      await module.stopIdle();
    },
  };
  deps.onSettings?.((next, previous) => {
    if (closed) return;
    if (next.imageGen !== previous.imageGen || next.comfyUrl !== previous.comfyUrl) {
      void module.status().catch((error: unknown) => log(`ComfyUI not asked again: ${detail(error)}`)).then(republish);
    } else if (next.imageFolder !== previous.imageFolder || JSON.stringify(next.imageChoice) !== JSON.stringify(previous.imageChoice)) republish();
  });
  async function startDownload(id: string, cfg: Cfg, controller: AbortController): Promise<{ files: string[] }> {
    if (!isLocalComfy(cfg.baseUrl)) throw imageError("image-download", "Start ComfyUI on this computer first: downloads go into its model folders.");
    await module.presets();
    const last = knownFiles();
    const preset = appPreset(id) ?? extras().find((p) => p.id === id);
    if (preset === undefined) throw imageError("image-model", `There is no image setup ${id}.`);
    const listed = last && listPresets(last, extras(), lastRoom, lastRam);
    const row = last && listed && ([...listed.ready, ...listed.others].find((p) => p.id === id) ?? (appPreset(id) === undefined ? undefined : judgeRow(last, preset)));
    if (row?.why !== undefined) throw imageError("image-model", `${preset.name}: ${row.why}`);
    const names = last === undefined ? [...new Set(presetFiles(preset))] : row?.needs?.files ?? [];
    for (const name of names) {
      if (preset.sources?.[name]?.url === undefined) throw imageError("image-download", `${preset.name}: ${name} has no download address. Install it in ComfyUI's model folders yourself.`);
    }
    if (names.length > 0 && downloadPlace(cfg)?.dirOf === undefined) throw imageError("image-folder", "ComfyUI has not said where its models go. Pick a folder for the image files first.");
    const planned = plannedFiles(id, names, cfg);
    const lost = names.find((name) => !planned.some((f) => f.name === path.basename(name)));
    if (lost !== undefined) throw imageError("image-download", `${preset.name}: ComfyUI did not say which folder ${lost} goes in.`);
    const plan = (await Promise.all(planned.map(async (f) => await haveFile(f.dir, f.name, knownSize(f)) ? undefined : f))).filter((f): f is Planned => f !== undefined);
    if (plan.length === 0) { downloads = undefined; downloadOf = undefined; return { files: [] }; }
    const { records, ...fetching } = deps.download ?? {};
    const sizes: (number | undefined)[] = await Promise.all(plan.map(async (f) => knownSize(f) ?? (controller.signal.aborted ? undefined
      : await sizeOf({ ...fetching, url: f.url, name: f.name, signal: controller.signal }).then((b) => { learned.set(f.url, b); return b; }, () => undefined))));
    if (!controller.signal.aborted) await roomFor(plan, sizes);
    const run: Promise<void> = (async () => {
      const pins = readPins();
      for (const [i, file] of plan.entries()) {
        const place = { preset: id, file: i + 1, files: plan.length };
        try {
          const pinned = (records === false ? undefined : file.sha256) ?? pins[file.url];
          if (i > 0) await roomFor(plan.slice(i), sizes.slice(i));
          const progress = (p: PullProgress) => {
            if (p.totalBytes !== undefined) { sizes[i] = p.totalBytes; learned.set(file.url, p.totalBytes); }
            const all = sizes.every((b) => b !== undefined) ? sizes as number[] : undefined;
            const setup = all === undefined ? {} : { setupCompletedBytes: all.slice(0, i).reduce((a, b) => a + b, 0) + p.completedBytes, setupTotalBytes: all.reduce((a, b) => a + b, 0) };
            say({ ...p, ...place, ...setup, ...p.state === "done" && i === plan.length - 1 ? { ended: true } : {} });
          };
          controller.signal.throwIfAborted();
          const got = await downloadFile({ ...fetching, name: file.name, url: file.url, dir: file.dir, ...pinned === undefined ? {} : { sha256: pinned }, signal: controller.signal, progress });
          if (pinned === undefined) { pins[file.url] = got.sha256; writePins(pins); }
          if (got.replaced !== undefined) log(`image download ${file.name}: a file of that name was already there; kept as ${got.replaced}`);
        } catch (error) {
          const cancelled = controller.signal.aborted;
          // why: TypeScript keeps the pre-loop undefined though say() has set it since
          const said = lastDownload as ImageDownload | undefined;
          const completedBytes = said?.file === place.file ? said.completedBytes : 0;
          const totalBytes = said?.file === place.file ? said.totalBytes : undefined;
          const setup = said?.file === place.file && said.setupTotalBytes !== undefined && said.setupCompletedBytes !== undefined ? { setupCompletedBytes: said.setupCompletedBytes, setupTotalBytes: said.setupTotalBytes } : {};
          say({ name: file.name, ...place, state: cancelled ? "cancelled" : "error", completedBytes, ...totalBytes === undefined ? {} : { totalBytes }, ...setup, ...cancelled ? {} : { message: detail(error) }, ended: true });
          log(`image download ${file.name}: ${detail(error)}`);
          break;
        }
      }
      unlock();
      await module.presets().catch(() => undefined);
    })().finally(() => { unlock(); if (downloading === run) downloading = undefined; });
    function unlock() { if (downloads === controller) { downloads = undefined; downloadOf = undefined; } }
    downloading = run;
    return { files: plan.map((f) => f.name) };
  }
  return module;
}
