// Ollama discovery and the app-owned server.
//
// Order: a healthy Ollama on the system port is reused (owner "external").
// Otherwise the app's own loopback port is checked: an Ollama there that
// matches the ownership record is ours, any other Ollama there is reused as
// external, and a non-Ollama there blocks starting. Only when nothing answers
// does the app start a server, from its own install, then PATH, then a fresh
// pinned install. A non-Ollama on the system port never gets a second server
// on that port; the app-owned server lives on its own port.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { PINNED_OLLAMA } from "./manifest.ts";
import { InstallError, findAnyInstalled, installPinned, isInstalled } from "./install.ts";
import { checkOwnership, readProc, stopOwned, writeRecord, type StopResult } from "./ownership.ts";
import {
  type Env,
  defaultAppDataDir,
  detectModelsDir,
  findModelsDirs,
  findOnPath,
  installedBinary,
  ownedStateFile,
  runtimeDir,
  serveLogFile,
} from "./paths.ts";
import { DEFAULT_PROBE_TIMEOUT_MS, type ProbeResult, probe } from "./probe.ts";
import type { InstallManifest } from "./schemas.ts";
import type { InstallProgress, Listener, RuntimeStatus } from "./types.ts";

export const DEFAULT_EXTERNAL_BASE_URL = "http://127.0.0.1:11434";
export const DEFAULT_APP_PORT = 11435;

export type RuntimeOptions = {
  appDataDir?: string;
  /** Where a system Ollama would answer. */
  externalBaseUrl?: string;
  /** Loopback port for the app-owned server. */
  appPort?: number;
  probeTimeoutMs?: number;
  startTimeoutMs?: number;
  /** Environment for PATH lookup, models-dir detection and the child. */
  env?: Env;
  home?: string;
  /** System-service model stores to look in; default SYSTEM_MODELS_DIRS. */
  systemModelsDirs?: readonly string[];
  manifest?: InstallManifest;
  /** Install the pinned version when no binary is found. Default true. */
  allowInstall?: boolean;
};

export type OllamaRuntime = {
  status(): RuntimeStatus;
  /** Base URL to talk to, only while ready. */
  baseUrl(): string | undefined;
  /** Read-only: classify what is there; never starts or installs. */
  discover(): Promise<RuntimeStatus>;
  /** Discover, then install and start an app-owned server when none answers. */
  ensure(): Promise<RuntimeStatus>;
  /** Stop the app-owned server, only if it still matches its record. */
  stop(): Promise<StopResult>;
  onChange(listener: Listener<RuntimeStatus>): () => void;
  onInstallProgress(listener: Listener<InstallProgress>): () => void;
};

type Binary = { path: string; origin: "app-install" | "path" };

type Classified =
  | { kind: "ready"; status: RuntimeStatus }
  | { kind: "blocked"; status: RuntimeStatus }
  | { kind: "startable"; binary: Binary | undefined; note: string | undefined };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const withNote = (detail: string, note: string | undefined) => (note ? `${note} ${detail}` : detail);

function tail(file: string, chars = 2000): string {
  try {
    return readFileSync(file, "utf8").slice(-chars).trim();
  } catch {
    return "";
  }
}

export function createOllamaRuntime(options: RuntimeOptions = {}): OllamaRuntime {
  const env = options.env ?? process.env;
  const appDataDir = options.appDataDir ?? defaultAppDataDir(env, options.home);
  const externalBaseUrl = options.externalBaseUrl ?? DEFAULT_EXTERNAL_BASE_URL;
  const appPort = options.appPort ?? DEFAULT_APP_PORT;
  const appBaseUrl = `http://127.0.0.1:${appPort}`;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const startTimeoutMs = options.startTimeoutMs ?? 30_000;
  const manifest = options.manifest ?? PINNED_OLLAMA;
  const allowInstall = options.allowInstall ?? true;
  const stateFile = ownedStateFile(appDataDir);

  let current: RuntimeStatus = { state: "stopped", owner: "none", baseUrl: externalBaseUrl, detail: "not checked yet" };
  const statusListeners = new Set<Listener<RuntimeStatus>>();
  const progressListeners = new Set<Listener<InstallProgress>>();
  let inFlight: Promise<RuntimeStatus> | undefined;

  const setStatus = (next: RuntimeStatus): RuntimeStatus => {
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      current = next;
      for (const l of statusListeners) l(next);
    }
    return current;
  };

  async function locateBinary(): Promise<Binary | undefined> {
    if (isInstalled(appDataDir, manifest.version)) return { path: installedBinary(appDataDir, manifest.version), origin: "app-install" };
    const any = await findAnyInstalled(appDataDir);
    if (any) return { path: any.binary, origin: "app-install" };
    const onPath = findOnPath(env);
    return onPath ? { path: onPath, origin: "path" } : undefined;
  }

  async function classify(): Promise<Classified> {
    const ext: ProbeResult = await probe(externalBaseUrl, probeTimeoutMs);
    if (ext.kind === "ollama") {
      return { kind: "ready", status: { state: "ready", owner: "external", baseUrl: externalBaseUrl, version: ext.version } };
    }
    const note =
      ext.kind === "wrong-service"
        ? `${ext.detail} The app runs its own Ollama on port ${appPort} instead.`
        : undefined;
    if (appBaseUrl !== externalBaseUrl) {
      const app = await probe(appBaseUrl, probeTimeoutMs);
      if (app.kind === "ollama") {
        const own = checkOwnership(stateFile);
        if (own.kind === "ours" && own.record.baseUrl === appBaseUrl) {
          return { kind: "ready", status: { state: "ready", owner: "app", baseUrl: appBaseUrl, version: app.version } };
        }
        return {
          kind: "ready",
          status: {
            state: "ready",
            owner: "external",
            baseUrl: appBaseUrl,
            version: app.version,
            detail: `An Ollama the app did not start answers on port ${appPort}; reusing it and never stopping it.`,
          },
        };
      }
      if (app.kind === "wrong-service") {
        const both = ext.kind === "wrong-service" ? `${ext.detail} ${app.detail}` : app.detail;
        return { kind: "blocked", status: { state: "wrong-service", owner: "none", baseUrl: appBaseUrl, detail: both } };
      }
    } else if (ext.kind === "wrong-service") {
      return { kind: "blocked", status: { state: "wrong-service", owner: "none", baseUrl: externalBaseUrl, detail: ext.detail } };
    }
    return { kind: "startable", binary: await locateBinary(), note };
  }

  function statusFor(c: Classified): RuntimeStatus {
    if (c.kind !== "startable") return c.status;
    if (c.binary) {
      const detail = `Ollama at ${c.binary.path} is installed but not running.`;
      return { state: "stopped", owner: "none", baseUrl: appBaseUrl, detail: withNote(detail, c.note) };
    }
    const detail = allowInstall
      ? `No Ollama found; the app will install Ollama ${manifest.version} into ${runtimeDir(appDataDir)}.`
      : "No Ollama found on this machine.";
    return { state: "missing", owner: "none", baseUrl: appBaseUrl, detail: withNote(detail, c.note) };
  }

  async function start(binary: Binary, note: string | undefined): Promise<RuntimeStatus> {
    setStatus({ state: "starting", owner: "app", baseUrl: appBaseUrl, detail: withNote(`Starting ${binary.path} on port ${appPort}.`, note) });
    mkdirSync(runtimeDir(appDataDir), { recursive: true });
    const logFile = serveLogFile(appDataDir);
    const log = openSync(logFile, "a");
    const childEnv: Record<string, string | undefined> = { ...env, OLLAMA_HOST: `127.0.0.1:${appPort}` };
    const models = detectModelsDir(env, options.home, options.systemModelsDirs);
    if (models) childEnv.OLLAMA_MODELS = models.path;
    const readOnly = findModelsDirs(env, options.home, options.systemModelsDirs).find((d) => d.hasModels && !d.writable && !models?.hasModels);
    let exited: string | undefined;
    const child = spawn(binary.path, ["serve"], { detached: true, stdio: ["ignore", log, log], env: childEnv });
    closeSync(log);
    child.on("error", (e) => {
      exited = e.message;
    });
    child.on("exit", (code, sig) => {
      exited = `exited with ${sig ?? `code ${code}`}`;
    });
    child.unref();

    const fail = (why: string) => {
      if (child.pid && exited === undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // gone
        }
      }
      const logTail = tail(logFile, 600);
      return setStatus({
        state: "error",
        owner: "none",
        baseUrl: appBaseUrl,
        detail: `${why}${logTail ? ` Last log lines: ${logTail}` : ""} Log: ${logFile}`,
      });
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
    // The answer must come from our child, not something that grabbed the port.
    const proc = child.pid ? readProc(child.pid) : undefined;
    if (exited !== undefined || !proc) return fail(`Ollama (${binary.path}) ${exited ?? "vanished"} while another process answered on port ${appPort}.`);
    writeRecord(stateFile, {
      pid: proc.pid,
      startTime: proc.startTime,
      command: proc.command,
      baseUrl: appBaseUrl,
      binary: binary.path,
      startedAt: Date.now(),
    });
    const modelsNote =
      (models ? ` Models from ${models.path}.` : "") +
      (readOnly ? ` Models in ${readOnly.path} belong to another user and are not writable here, so they are not shared.` : "");
    return setStatus({
      state: "ready",
      owner: "app",
      baseUrl: appBaseUrl,
      version,
      detail: withNote(`App-owned Ollama (pid ${proc.pid}, ${binary.origin === "path" ? "from PATH" : "app install"}).${modelsNote}`, note),
    });
  }

  async function ensureOnce(): Promise<RuntimeStatus> {
    const c = await classify();
    if (c.kind !== "startable") return setStatus(c.status);
    let binary = c.binary;
    if (!binary) {
      if (!allowInstall) return setStatus(statusFor(c));
      setStatus({ state: "installing", owner: "app", baseUrl: appBaseUrl, detail: withNote(`Installing Ollama ${manifest.version}.`, c.note) });
      try {
        const r = await installPinned({
          appDataDir,
          manifest,
          onProgress: (p) => {
            for (const l of progressListeners) l(p);
          },
        });
        binary = { path: r.binary, origin: "app-install" };
      } catch (e) {
        const message = e instanceof InstallError ? e.message : `Installing Ollama failed: ${(e as Error).message}`;
        return setStatus({ state: "error", owner: "none", baseUrl: appBaseUrl, detail: message });
      }
    }
    return start(binary, c.note);
  }

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
    discover: () => serial(async () => setStatus(statusFor(await classify()))),
    ensure: () => serial(ensureOnce),
    async stop() {
      const r = await stopOwned(stateFile);
      if (r.stopped) setStatus({ state: "stopped", owner: "none", baseUrl: appBaseUrl, detail: `Stopped the app-owned Ollama (pid ${r.pid}).` });
      return r;
    },
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
