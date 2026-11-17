import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RuntimeMode } from "@gates-local/contracts";
import { forgetGpuReadings } from "../fit/gpu.ts";
import { PINNED_OLLAMA, pinnedOllamaFor } from "./manifest.ts";
import { InstallError, findAnyInstalled, installPinned, isInstalled } from "./install.ts";
import { listLoaded } from "./models.ts";
import { checkOwnership, clearRecord, listenerPid, readProc, stopOwned, writeRecord, type ProcPlatform, type StopResult, type SyncRunner } from "@gates-local/runtime-files/ownership";
import {
  type Env,
  appModelsDir,
  defaultAppDataDir,
  detectModelsDir,
  findModelsDirs,
  findSystemOllama,
  installedBinary,
  ownedStateFile,
  runtimeDir,
  serveLogFile,
} from "@gates-local/runtime-files/paths";
import { DEFAULT_PROBE_TIMEOUT_MS, type ProbeResult, portOf, probe } from "./probe.ts";
import type { OwnedRecord } from "@gates-local/runtime-files/ownership";
import type { InstallManifest } from "./schemas.ts";
import type { InstallProgress, Listener, RuntimeStatus } from "./types.ts";

export const DEFAULT_EXTERNAL_BASE_URL = "http://127.0.0.1:11434";
export const DEFAULT_APP_PORT = 11435;
export const APP_PORT_SPAN = 10;
const UNLOAD_WAIT_MS = 10_000;
const STOP_GRACE_MS = 5000;

export const ADOPTED_WINDOWS_DETAIL = "The app's Ollama from an earlier run keeps running; quit it from the tray icon or Task Manager.";

export type RuntimeOptions = {
  appDataDir?: string;
  stateDir?: string;
  externalBaseUrl?: string;
  appPort?: number;
  probeTimeoutMs?: number;
  startTimeoutMs?: number;
  env?: Env;
  home?: string;
  systemModelsDirs?: readonly string[];
  manifest?: InstallManifest;
  allowInstall?: boolean;
  searchBinary?: boolean;
  allowStart?: boolean;
  mode?: RuntimeMode;
  platform?: NodeJS.Platform;
  arch?: string;
  procRun?: SyncRunner;
  isExecutable?: (file: string) => boolean;
  stallMs?: number;
};

export const WINDOWS_APP_MODE_DETAIL =
  "The app's own Ollama is not available on Windows yet. Run Ollama and choose Automatic or System in Settings › Runtime.";
export const windowsAutomaticDetail = (externalBaseUrl: string) =>
  `No Ollama answers at ${externalBaseUrl}, and the app's own Ollama is not available on Windows yet. Run Ollama, then check again.`;

export type OllamaRuntime = {
  status(): RuntimeStatus;
  baseUrl(): string | undefined;
  discover(): Promise<RuntimeStatus>;
  ensure(): Promise<RuntimeStatus>;
  stop(): Promise<StopResult>;
  startedByThisProcess(): boolean;
  killNow(): void;
  readonly mode: RuntimeMode | undefined;
  onChange(listener: Listener<RuntimeStatus>): () => void;
  onInstallProgress(listener: Listener<InstallProgress>): () => void;
};

type Binary = { path: string; origin: "app-install" | "path" };

type Classified =
  | { kind: "ready"; status: RuntimeStatus }
  | { kind: "blocked"; status: RuntimeStatus }
  | { kind: "startable"; binary: Binary | undefined; note: Note | undefined };

type Note = { text: string; busy: readonly string[] };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const INSTALL_PUSH_MS = 1000;

const STALL_MS = 5000;

class Restart extends Error {}

function noted(status: RuntimeStatus, note: Note | undefined): RuntimeStatus {
  if (!note) return status;
  return { ...status, detail: status.detail ? `${note.text} ${status.detail}` : note.text, ...withBusy(note.busy) };
}

const withBusy = (busy: readonly string[]): { busyPorts?: readonly string[] } => (busy.length > 0 ? { busyPorts: [...new Set(busy)] } : {});

const urlFor = (port: number) => `http://127.0.0.1:${port}`;

async function unloadAll(baseUrl: string): Promise<void> {
  // why: an unreadable /api/ps changes nothing, the kill that follows still ends the server
  try {
    const models = await listLoaded(baseUrl, 2000);
    await Promise.all(
      models.map((m) =>
        fetch(new URL("/api/generate", baseUrl), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: m.name, keep_alive: 0 }),
          signal: AbortSignal.timeout(UNLOAD_WAIT_MS),
        }).then(
          (res) => res.body?.cancel(),
          () => undefined,
        ),
      ),
    );
    forgetGpuReadings();
    const deadline = Date.now() + UNLOAD_WAIT_MS;
    while (Date.now() < deadline && (await listLoaded(baseUrl, 2000)).length > 0) await sleep(200);
  } catch {}
}

function tail(file: string, chars = 2000): string {
  try {
    return readFileSync(file, "utf8").slice(-chars).trim();
  } catch {
    return "";
  }
}

const inFolder = (modelsDir: string | undefined) => (modelsDir === undefined ? {} : { modelsDir });
const oneIn = (record: OwnedRecord) => (record.holdsOne === true ? { holdsOne: true } : {});

export const childHome = (appDataDir: string): string => path.join(runtimeDir(appDataDir), "home");

export function stoppedOn(e: unknown): string {
  const { path: file, code } = (typeof e === "object" && e !== null ? e : {}) as NodeJS.ErrnoException;
  if (typeof file === "string" && typeof code === "string") return `The app could not use ${file} (${code}). Check that it can be written to, then retry.`;
  return `The app stopped on an error: ${e instanceof Error ? e.message : String(e)}`;
}

export function failureOf(e: unknown): NonNullable<RuntimeStatus["failure"]> {
  if (!(e instanceof InstallError)) return "install";
  switch (e.code) {
    case "download-failed":
    case "interrupted":
      return "download";
    case "hash-mismatch":
      return "checksum";
    case "disk-full":
      return "disk";
    case "unverified-manifest":
    case "extract-failed":
    case "move-failed":
      return "install";
  }
}

export function ownedChildEnv(env: Env, appDataDir: string, appPort: number, platform: NodeJS.Platform, ownHome: boolean): Record<string, string | undefined> {
  const child: Record<string, string | undefined> = { ...env, OLLAMA_HOST: `127.0.0.1:${appPort}`, OLLAMA_MAX_LOADED_MODELS: "1" };
  // external: Ollama keeps its sign-in key under <home>/.ollama, so only the app's copy moves home
  if (ownHome) child[platform === "win32" ? "USERPROFILE" : "HOME"] = childHome(appDataDir);
  child.CUDA_CACHE_PATH ??= path.join(runtimeDir(appDataDir), "cuda-cache");
  return child;
}

export function createOllamaRuntime(options: RuntimeOptions = {}): OllamaRuntime {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const on: ProcPlatform = { platform, ...(options.procRun ? { run: options.procRun } : {}) };
  const mode = options.mode;
  const appDataDir = options.appDataDir ?? defaultAppDataDir(env, options.home, platform);
  const externalBaseUrl = options.externalBaseUrl ?? DEFAULT_EXTERNAL_BASE_URL;
  const stateDir = options.stateDir ?? appDataDir;
  const firstAppPort = options.appPort ?? DEFAULT_APP_PORT;
  let appPort = firstAppPort;
  let appBaseUrl = urlFor(appPort);
  const useAppPort = (baseUrl: string) => {
    appBaseUrl = baseUrl;
    appPort = Number(new URL(baseUrl).port);
  };
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const startTimeoutMs = options.startTimeoutMs ?? 30_000;
  const pinned = pinnedOllamaFor(platform, options.arch ?? process.arch);
  const installable = options.manifest ?? pinned;
  const manifest = installable ?? PINNED_OLLAMA;
  const allowStart = options.allowStart ?? true;
  const allowInstall = installable !== undefined && allowStart && (options.allowInstall ?? pinned !== undefined);
  const stateFile = ownedStateFile(stateDir);
  let startedPid: number | undefined;
  let spawned: ChildProcess | undefined;

  let current: RuntimeStatus = { state: "starting", owner: "none", baseUrl: externalBaseUrl, detail: "Looking for Ollama." };
  const statusListeners = new Set<Listener<RuntimeStatus>>();
  const progressListeners = new Set<Listener<InstallProgress>>();
  let inFlight: Promise<RuntimeStatus> | undefined;
  const stallMs = options.stallMs ?? STALL_MS;
  let download: { abort: AbortController; lastBytesAt: number; fetching: boolean } | undefined;
  let noAppCopy = installable === undefined;

  const setStatus = (status: RuntimeStatus): RuntimeStatus => {
    const next = noAppCopy ? { ...status, noAppCopy: true } : status;
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      current = next;
      for (const l of statusListeners) l(next);
    }
    return current;
  };

  async function locateBinary(): Promise<Binary | undefined> {
    if (options.searchBinary === false) return undefined;
    // external: on Windows only the pinned Ollama puts its runners in a kill-on-close Job Object
    if (platform === "win32" && installable === undefined) return undefined;
    if (isInstalled(appDataDir, manifest.version)) return { path: installedBinary(appDataDir, manifest.version), origin: "app-install" };
    if (platform === "win32") return undefined;
    const any = await findAnyInstalled(appDataDir);
    if (any) return { path: any.binary, origin: "app-install" };
    const onPath = findSystemOllama(env, options.home, platform, options.isExecutable);
    return onPath ? { path: onPath, origin: "path" } : undefined;
  }

  function quitWindowsOllama(): string | undefined {
    if (platform !== "win32" || options.searchBinary === false) return undefined;
    return findSystemOllama(env, options.home, platform, options.isExecutable);
  }

  const holdsPort = async (baseUrl: string, pid: number) =>
    (await listenerPid(Number(portOf(baseUrl)), { ...on, pids: [pid], host: new URL(baseUrl).hostname })) === pid;

  async function adoptable(record: OwnedRecord): Promise<string | undefined> {
    if (!(await holdsPort(record.baseUrl, record.pid))) return undefined;
    const there = await probe(record.baseUrl, probeTimeoutMs);
    if (there.kind !== "ollama") return undefined;
    const again = checkOwnership(stateFile, on);
    if (again.kind !== "ours" || again.record.pid !== record.pid || again.record.startTime !== record.startTime) return undefined;
    if (!(await holdsPort(record.baseUrl, record.pid))) return undefined;
    return there.version;
  }

  async function classifyApp(): Promise<Classified> {
    const own = checkOwnership(stateFile, on);
    if (own.kind === "ours") {
      const version = await adoptable(own.record);
      if (version !== undefined) {
        useAppPort(own.record.baseUrl);
        return { kind: "ready", status: { state: "ready", owner: "app", baseUrl: appBaseUrl, version, ...inFolder(own.record.modelsDir), ...oneIn(own.record) } };
      }
    }
    const last = firstAppPort + APP_PORT_SPAN - 1;
    const taken: { port: number; result: ProbeResult }[] = [];
    for (let port = firstAppPort; port <= last; port++) {
      const result = await probe(urlFor(port), probeTimeoutMs);
      if (result.kind !== "none") {
        taken.push({ port, result });
        continue;
      }
      useAppPort(urlFor(port));
      const notes = taken.map(({ port: n, result: r }) =>
        r.kind === "ollama" ? `Another Ollama, not started by this app, is on port ${n}; the app uses port ${port}.` : `${r.kind === "wrong-service" ? r.detail : ""} The app uses port ${port}.`,
      );
      const busy = taken.flatMap(({ result: r }) => (r.kind === "wrong-service" ? [r.port] : []));
      return { kind: "startable", binary: await locateBinary(), note: notes.length > 0 ? { text: notes.join(" "), busy } : undefined };
    }
    useAppPort(urlFor(firstAppPort));
    return {
      kind: "blocked",
      status: {
        state: "wrong-service",
        owner: "none",
        baseUrl: appBaseUrl,
        detail: `Ports ${firstAppPort} to ${last} are all in use by other programs, so the app cannot start its own Ollama.`,
        ...withBusy(taken.flatMap(({ result: r }) => (r.kind === "wrong-service" ? [r.port] : []))),
      },
    };
  }

  async function classify(): Promise<Classified> {
    if (installable === undefined) noAppCopy = (await locateBinary()) === undefined;
    if (mode === "app") return classifyApp();
    const ext: ProbeResult = await probe(externalBaseUrl, probeTimeoutMs);
    if (ext.kind === "ollama") {
      return { kind: "ready", status: { state: "ready", owner: "external", baseUrl: externalBaseUrl, version: ext.version } };
    }
    if (mode === "system") {
      if (ext.kind === "wrong-service") {
        return { kind: "blocked", status: { state: "wrong-service", owner: "none", baseUrl: externalBaseUrl, detail: ext.detail, ...withBusy([ext.port]) } };
      }
      const orOwnCopy = noAppCopy ? "" : ", or choose the app's own copy in Settings › Runtime";
      const quit = quitWindowsOllama();
      if (quit !== undefined) {
        return {
          kind: "blocked",
          status: {
            state: "stopped",
            owner: "none",
            baseUrl: externalBaseUrl,
            detail: `Ollama is installed (${quit}) but nothing answers at ${externalBaseUrl}. Start Ollama from the Start menu${orOwnCopy}.`,
          },
        };
      }
      return {
        kind: "blocked",
        status: {
          state: "missing",
          owner: "none",
          baseUrl: externalBaseUrl,
          detail: `No Ollama answers at ${externalBaseUrl}. Start your Ollama${orOwnCopy}.`,
        },
      };
    }
    const note: Note | undefined =
      ext.kind === "wrong-service"
        ? { text: `${ext.detail} The app runs its own Ollama on port ${appPort} instead.`, busy: [ext.port] }
        : undefined;
    if (appBaseUrl !== externalBaseUrl) {
      const app = await probe(appBaseUrl, probeTimeoutMs);
      if (app.kind === "ollama") {
        const own = checkOwnership(stateFile, on);
        const version = own.kind === "ours" && own.record.baseUrl === appBaseUrl ? await adoptable(own.record) : undefined;
        const busy = withBusy(note?.busy ?? []);
        if (version !== undefined) {
          return { kind: "ready", status: { state: "ready", owner: "app", baseUrl: appBaseUrl, version, ...busy, ...(own.kind === "ours" ? { ...inFolder(own.record.modelsDir), ...oneIn(own.record) } : {}) } };
        }
        return {
          kind: "ready",
          status: {
            state: "ready",
            owner: "external",
            baseUrl: appBaseUrl,
            version: app.version,
            detail: `An Ollama the app did not start answers on port ${appPort}; reusing it and never stopping it.`,
            ...busy,
          },
        };
      }
      if (app.kind === "wrong-service") {
        const both = ext.kind === "wrong-service" ? `${ext.detail} ${app.detail}` : app.detail;
        const busy = ext.kind === "wrong-service" ? [ext.port, app.port] : [app.port];
        return { kind: "blocked", status: { state: "wrong-service", owner: "none", baseUrl: appBaseUrl, detail: both, ...withBusy(busy) } };
      }
    } else if (ext.kind === "wrong-service") {
      return { kind: "blocked", status: { state: "wrong-service", owner: "none", baseUrl: externalBaseUrl, detail: ext.detail, ...withBusy([ext.port]) } };
    }
    return { kind: "startable", binary: await locateBinary(), note };
  }

  function statusFor(c: Classified): RuntimeStatus {
    if (c.kind !== "startable") return c.status;
    if (c.binary) {
      const detail = `Ollama at ${c.binary.path} is installed but not running.`;
      return noted({ state: "stopped", owner: "none", baseUrl: appBaseUrl, detail }, c.note);
    }
    if (platform === "win32" && installable === undefined) {
      const detail = mode === "app" ? WINDOWS_APP_MODE_DETAIL : windowsAutomaticDetail(externalBaseUrl);
      return { state: "missing", owner: "none", baseUrl: appBaseUrl, detail, ...withBusy(c.note?.busy ?? []) };
    }
    const detail = allowInstall
      ? `No Ollama found; the app will install Ollama into ${runtimeDir(appDataDir)}.`
      : "No Ollama found on this machine.";
    return noted({ state: "missing", owner: "none", baseUrl: appBaseUrl, detail }, c.note);
  }

  async function start(binary: Binary, note: Note | undefined): Promise<RuntimeStatus> {
    setStatus(noted({ state: "starting", owner: "app", baseUrl: appBaseUrl, detail: `Starting ${binary.path} on port ${appPort}.` }, note));
    mkdirSync(runtimeDir(stateDir), { recursive: true });
    const logFile = serveLogFile(stateDir);
    const log = openSync(logFile, "a");
    const ownHome = mode === "app" && binary.origin === "app-install";
    const childEnv = ownedChildEnv(env, appDataDir, appPort, platform, ownHome);
    if (ownHome) mkdirSync(childHome(appDataDir), { recursive: true });
    let models: { path: string; hasModels?: boolean } | undefined;
    if (mode === "app") {
      models = { path: appModelsDir(appDataDir) };
      mkdirSync(models.path, { recursive: true });
    } else {
      models = detectModelsDir(env, options.home, options.systemModelsDirs);
    }
    if (models) childEnv.OLLAMA_MODELS = models.path;
    // why: the child's home need not be the person's, so Ollama's default store is named outright
    else childEnv.OLLAMA_MODELS ??= path.join(options.home ?? os.homedir(), ".ollama", "models");
    const readOnly =
      mode === "app" ? undefined : findModelsDirs(env, options.home, options.systemModelsDirs).find((d) => d.hasModels && !d.writable && !models?.hasModels);
    let exited: string | undefined;
    // external: a Windows process holds its working folder open, and an adopted copy outlives the app
    const cwd = platform === "win32" ? { cwd: path.dirname(binary.path) } : {};
    const child = spawn(binary.path, ["serve"], { detached: true, windowsHide: true, stdio: ["ignore", log, log], env: childEnv, ...cwd });
    closeSync(log);
    spawned = child;
    child.on("error", (e) => {
      exited = e.message;
    });
    child.on("exit", (code, sig) => {
      exited = `exited with ${sig ?? `code ${code}`}`;
      if (spawned === child) spawned = undefined;
    });
    child.unref();

    const fail = (why: string) => {
      if (child.pid && exited === undefined) {
        try {
          if (platform === "win32") child.kill();
          else process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
      const logTail = tail(logFile, 600);
      return setStatus(
        noted(
          {
            state: "error",
            owner: "none",
            baseUrl: appBaseUrl,
            failure: "start",
            detail: `${why}${logTail ? ` Last log lines: ${logTail}` : ""} Log: ${logFile}`,
          },
          note,
        ),
      );
    };

    const deadline = Date.now() + startTimeoutMs;
    let version: string | undefined;
    while (Date.now() < deadline) {
      if (exited !== undefined) return fail(`Ollama (${binary.path}) ${exited} before it answered.`);
      const p = await probe(appBaseUrl, Math.min(probeTimeoutMs, 1000));
      if (p.kind === "ollama") {
        version = p.version;
        break;
      }
      await sleep(100);
    }
    if (version === undefined) return fail(`Ollama (${binary.path}) did not answer on port ${appPort} within ${startTimeoutMs} ms.`);
    // why: the answer must come from our child, not something that grabbed the port
    const proc = child.pid ? readProc(child.pid, on) : undefined;
    if (exited !== undefined || !proc) return fail(`Ollama (${binary.path}) ${exited ?? "vanished"} while another process answered on port ${appPort}.`);
    if (!(await holdsPort(appBaseUrl, proc.pid)) || exited !== undefined) {
      return fail(`Another program answered on port ${appPort}, not the Ollama the app started (${binary.path}).`);
    }
    writeRecord(stateFile, {
      pid: proc.pid,
      startTime: proc.startTime,
      command: proc.command,
      baseUrl: appBaseUrl,
      binary: binary.path,
      startedAt: Date.now(),
      ...inFolder(models?.path),
      holdsOne: true,
    });
    startedPid = proc.pid;
    const modelsNote =
      (models ? ` Models from ${models.path}.` : "") +
      (readOnly ? ` Models in ${readOnly.path} belong to another user and are not writable here, so they are not shared.` : "");
    return setStatus(
      noted(
        {
          state: "ready",
          owner: "app",
          baseUrl: appBaseUrl,
          version,
          detail: `App-owned Ollama (pid ${proc.pid}, ${binary.origin === "path" ? "from PATH" : "app install"}).${modelsNote}`,
          ...inFolder(models?.path),
          holdsOne: true,
        },
        note,
      ),
    );
  }

  async function ensureOnce(): Promise<RuntimeStatus> {
    const c = await classify();
    if (c.kind !== "startable") return setStatus(c.status);
    if (!allowStart) return setStatus(statusFor(c));
    let binary = c.binary;
    if (!binary) {
      if (!allowInstall) return setStatus(statusFor(c));
      const installing = noted({ state: "installing", owner: "app", baseUrl: appBaseUrl, detail: "Installing Ollama." }, c.note);
      const disk = manifest.unpackedBytes === undefined ? {} : { diskBytes: manifest.unpackedBytes };
      setStatus({ ...installing, install: { receivedBytes: 0, totalBytes: manifest.sizeBytes, ...disk } });
      let said = { at: Date.now(), bytes: 0 };
      const mine = { abort: new AbortController(), lastBytesAt: Date.now(), bytes: 0, fetching: true };
      download = mine;
      const watch = setInterval(() => {
        const i = current.state === "installing" ? current.install : undefined;
        if (i === undefined || i.stalled === true || !mine.fetching || Date.now() - mine.lastBytesAt < stallMs) return;
        const { bytesPerSecond: _, ...still } = i;
        setStatus({ ...current, install: { ...still, stalled: true, quietMs: stallMs } });
      }, Math.max(50, Math.min(1000, stallMs / 4)));
      try {
        const r = await installPinned({
          appDataDir,
          manifest,
          signal: mine.abort.signal,
          onProgress: (p) => {
            for (const l of progressListeners) l(p);
            if (p.receivedBytes > mine.bytes || p.phase !== "download") mine.lastBytesAt = Date.now();
            mine.bytes = p.receivedBytes;
            mine.fetching = p.phase === "download";
            const now = Date.now();
            const whole = p.receivedBytes >= p.totalBytes;
            if (!whole && now - said.at < INSTALL_PUSH_MS) return;
            const rate = now > said.at ? ((p.receivedBytes - said.bytes) * 1000) / (now - said.at) : 0;
            said = { at: now, bytes: p.receivedBytes };
            setStatus({ ...installing, install: { receivedBytes: Math.min(p.receivedBytes, p.totalBytes), totalBytes: p.totalBytes, ...disk, ...(!whole && rate > 0 ? { bytesPerSecond: rate } : {}) } });
          },
        });
        binary = { path: r.binary, origin: "app-install" };
      } catch (e) {
        if (mine.abort.signal.reason instanceof Restart) {
          clearInterval(watch);
          return ensureOnce();
        }
        const message = e instanceof InstallError ? e.message : `Installing Ollama failed: ${(e as Error).message}`;
        return setStatus(noted({ state: "error", owner: "none", baseUrl: appBaseUrl, failure: failureOf(e), detail: message }, c.note));
      } finally {
        clearInterval(watch);
        if (download === mine) download = undefined;
      }
    }
    return start(binary, c.note);
  }

  async function stopSpawned(): Promise<StopResult> {
    const child = spawned;
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
      const check = checkOwnership(stateFile, on);
      if (check.kind === "no-record") return { stopped: false, reason: "no-record" };
      if (check.kind === "ours") {
        setStatus({ ...current, detail: ADOPTED_WINDOWS_DETAIL });
        return { stopped: false, reason: "adopted" };
      }
      clearRecord(stateFile);
      startedPid = undefined;
      return check.kind === "gone" ? { stopped: false, reason: "gone" } : { stopped: false, reason: "not-ours", detail: check.detail };
    }
    const pid = child.pid ?? 0;
    const kill = (signal: NodeJS.Signals) => {
      if (platform === "win32") child.kill(signal);
      else { try { process.kill(-pid, signal); } catch {} }
    };
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const exitWithin = (ms: number) => Promise.race([exited.then(() => true), sleep(ms).then(() => false)]);
    if (platform === "win32") await unloadAll(appBaseUrl);
    kill("SIGTERM");
    if (!(await exitWithin(STOP_GRACE_MS))) {
      kill("SIGKILL");
      await exitWithin(2000);
    }
    clearRecord(stateFile);
    startedPid = undefined;
    spawned = undefined;
    setStatus({ state: "stopped", owner: "none", baseUrl: appBaseUrl, detail: `Stopped the app-owned Ollama (pid ${pid}).` });
    return { stopped: true, pid };
  }

  const killSpawned = () => {
    const child = spawned;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (platform === "win32") child.kill("SIGKILL");
    else if (child.pid !== undefined) {
      try { process.kill(-child.pid, "SIGKILL"); }
      catch {}
    }
  };

  const ended = (fn: () => Promise<RuntimeStatus>, starting: boolean) => async (): Promise<RuntimeStatus> => {
    try {
      return await fn();
    } catch (e) {
      if (starting && spawned !== undefined && spawned.pid !== startedPid) killSpawned();
      return setStatus({ state: "error", owner: "none", baseUrl: appBaseUrl, ...(starting ? { failure: "start" as const } : {}), detail: stoppedOn(e) });
    }
  };

  const serial = (fn: () => Promise<RuntimeStatus>): Promise<RuntimeStatus> => {
    if (inFlight) return inFlight;
    inFlight = fn().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  return {
    status: () => current,
    baseUrl: () => (current.state === "ready" ? current.baseUrl : undefined),
    discover: () => serial(ended(async () => setStatus(statusFor(await classify())), false)),
    ensure: () => {
      if (inFlight !== undefined && download?.fetching === true && Date.now() - download.lastBytesAt >= stallMs) download.abort.abort(new Restart("Retry"));
      return serial(ended(ensureOnce, true));
    },
    async stop() {
      if (platform === "win32" || (spawned !== undefined && spawned.pid !== undefined && spawned.exitCode === null && spawned.signalCode === null)) return stopSpawned();
      const r = await stopOwned(stateFile, undefined, on);
      if (r.stopped || r.reason !== "no-record") startedPid = undefined;
      if (r.stopped) setStatus({ state: "stopped", owner: "none", baseUrl: appBaseUrl, detail: `Stopped the app-owned Ollama (pid ${r.pid}).` });
      return r;
    },
    killNow: killSpawned,
    startedByThisProcess() {
      if (startedPid === undefined) return false;
      return spawned !== undefined && spawned.pid === startedPid && spawned.exitCode === null && spawned.signalCode === null;
    },
    mode,
    onChange(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    onInstallProgress(listener) {
      progressListeners.add(listener);
      return () => progressListeners.delete(listener);
    },
  };
}
