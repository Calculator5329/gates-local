// Ollama discovery and the app-owned server.
//
// Order: a healthy Ollama on the system port is reused (owner "external").
// Otherwise the app's own loopback port is checked: an Ollama there that
// matches the ownership record is ours, any other Ollama there is reused as
// external, and a non-Ollama there blocks starting. Only when nothing answers
// does the app start a server, from its own install, then PATH, then a fresh
// pinned install. On Windows only the pinned app install is ever launched
// (its runners die with it); older installs and PATH binaries are skipped.
// A non-Ollama on the system port never gets a second server
// on that port; the app-owned server lives on its own port.
//
// With a runtime mode (Settings › Runtime) the order narrows:
// - "system" uses only the Ollama on the system port and never starts one.
// - "app" skips the system port and runs the app's own copy with its own
//   models folder (<app data dir>/models). A record that is still ours names
//   the port to adopt. Otherwise an Ollama it did not start is never reused:
//   it takes the first of ports 11435..11444 (appPort and the nine after it)
//   with no listener, and records that base URL.
// Without a mode the full order above applies.
//
// Files: the ownership record and the serve log are per instance and live
// under `stateDir`. The installed Ollama and the app's models folder live
// under `appDataDir` (default ~/.local/share/gates-local,
// %LOCALAPPDATA%\GatesLocal on Windows). services.ts sets both to the
// server's --data-dir, so two data dirs never share a mutable model store.
//
// Stopping: Linux and macOS signal the recorded process group after the
// PID, start time and command still match. Windows never kills by PID
// number: a child this object spawned is stopped through its retained
// handle after its models are unloaded; one adopted from an earlier run is
// left running ("adopted").
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import type { RuntimeMode } from "@gates-local/contracts";
import { PINNED_OLLAMA } from "./manifest.ts";
import { InstallError, findAnyInstalled, installPinned, isInstalled } from "./install.ts";
import { listLoaded } from "./models.ts";
import { checkOwnership, clearRecord, listenerPid, readProc, stopOwned, writeRecord, type ProcPlatform, type StopResult, type SyncRunner } from "./ownership.ts";
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
} from "./paths.ts";
import { DEFAULT_PROBE_TIMEOUT_MS, type ProbeResult, portOf, probe } from "./probe.ts";
import type { InstallManifest, OwnedRecord } from "./schemas.ts";
import type { InstallProgress, Listener, RuntimeStatus } from "./types.ts";

export const DEFAULT_EXTERNAL_BASE_URL = "http://127.0.0.1:11434";
export const DEFAULT_APP_PORT = 11435;
/** "app" mode looks for a free port in appPort .. appPort + APP_PORT_SPAN - 1 (11435..11444). */
export const APP_PORT_SPAN = 10;
/** Windows stop: how long to wait for /api/ps to empty after unloading, so the runners exit. */
const UNLOAD_WAIT_MS = 10_000;
/** Windows stop: the polite kill's grace before the hard one. */
const STOP_GRACE_MS = 5000;

export const ADOPTED_WINDOWS_DETAIL = "The app's Ollama from an earlier run keeps running; quit it from the tray icon or Task Manager.";

export type RuntimeOptions = {
  /** Shared, large files: the installed Ollama and the app's models folder. */
  appDataDir?: string;
  /** Per-instance state: the ownership record and the serve log. Default appDataDir. */
  stateDir?: string;
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
  /**
   * Install the pinned version when no binary is found. Default true on
   * Linux x64 only: the pinned asset is the Linux amd64 build.
   */
  allowInstall?: boolean;
  /**
   * false: never look for an Ollama binary (the app's install, PATH), as on a
   * machine with none, so tests do not depend on the host. Default true.
   */
  searchBinary?: boolean;
  /** Settings' runtimeMode; undefined uses the full discovery order. */
  mode?: RuntimeMode;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Runs Windows' process queries (tests inject a fake). */
  procRun?: SyncRunner;
  /** Whether a PATH candidate runs; default executableCheck(platform). Tests inject one so a Windows PATH resolves on Linux. */
  isExecutable?: (file: string) => boolean;
};

/**
 * Windows with no pinned app install, in "app" mode: there is no Windows
 * build of the app's own Ollama yet, so nothing can be installed or started.
 */
export const WINDOWS_APP_MODE_DETAIL =
  "The app's own Ollama is not available on Windows yet. Run Ollama and choose Automatic or System in Settings › Runtime.";
/** Windows, automatic mode, nothing answering at the system port and no pinned app install. */
export const windowsAutomaticDetail = (externalBaseUrl: string) =>
  `No Ollama answers at ${externalBaseUrl}, and the app's own Ollama is not available on Windows yet. Run Ollama, then check again.`;

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
  /** This runtime object started the app-owned server that is running now (not adopted from an earlier run). */
  startedByThisProcess(): boolean;
  readonly mode: RuntimeMode | undefined;
  onChange(listener: Listener<RuntimeStatus>): () => void;
  onInstallProgress(listener: Listener<InstallProgress>): () => void;
};

type Binary = { path: string; origin: "app-install" | "path" };

type Classified =
  | { kind: "ready"; status: RuntimeStatus }
  | { kind: "blocked"; status: RuntimeStatus }
  | { kind: "startable"; binary: Binary | undefined; note: Note | undefined };

/** Words about the ports the app routed around, and which of them a non-Ollama holds. */
type Note = { text: string; busy: readonly string[] };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The status with the note in front of its detail and the note's busy ports. */
function noted(status: RuntimeStatus, note: Note | undefined): RuntimeStatus {
  if (!note) return status;
  return { ...status, detail: status.detail ? `${note.text} ${status.detail}` : note.text, ...withBusy(note.busy) };
}

const withBusy = (busy: readonly string[]): { busyPorts?: readonly string[] } => (busy.length > 0 ? { busyPorts: [...new Set(busy)] } : {});

const urlFor = (port: number) => `http://127.0.0.1:${port}`;

/** Every model in the app's own Ollama is the app's: unload them all, then wait for /api/ps to empty. */
async function unloadAll(baseUrl: string): Promise<void> {
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
    const deadline = Date.now() + UNLOAD_WAIT_MS;
    while (Date.now() < deadline && (await listLoaded(baseUrl, 2000)).length > 0) await sleep(200);
  } catch {
    // Unreadable: the kill that follows still ends the server.
  }
}

function tail(file: string, chars = 2000): string {
  try {
    return readFileSync(file, "utf8").slice(-chars).trim();
  } catch {
    return "";
  }
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
  /** The app-owned server's port: firstAppPort, or in "app" mode the free one classify() picked. */
  let appPort = firstAppPort;
  let appBaseUrl = urlFor(appPort);
  const useAppPort = (baseUrl: string) => {
    appBaseUrl = baseUrl;
    appPort = Number(new URL(baseUrl).port);
  };
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const startTimeoutMs = options.startTimeoutMs ?? 30_000;
  const manifest = options.manifest ?? PINNED_OLLAMA;
  // Never on Windows, whatever the option says: the pinned asset is a Linux build.
  const allowInstall = platform !== "win32" && (options.allowInstall ?? (platform === "linux" && (options.arch ?? process.arch) === "x64"));
  const stateFile = ownedStateFile(stateDir);
  /** The pid this object spawned and recorded, while it runs. */
  let startedPid: number | undefined;
  /** The process this object spawned, kept so Windows stops it through its handle, never a PID number. */
  let spawned: ChildProcess | undefined;

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
    if (options.searchBinary === false) return undefined;
    if (isInstalled(appDataDir, manifest.version)) return { path: installedBinary(appDataDir, manifest.version), origin: "app-install" };
    // Windows: only the pinned build puts its runners in a kill-on-close Job Object, so stopping the
    // parent stops them (https://raw.githubusercontent.com/ollama/ollama/v0.40.15/llm/runner_job_windows.go).
    if (platform === "win32") return undefined;
    const any = await findAnyInstalled(appDataDir);
    if (any) return { path: any.binary, origin: "app-install" };
    const onPath = findSystemOllama(env, options.home, platform, options.isExecutable);
    return onPath ? { path: onPath, origin: "path" } : undefined;
  }

  /**
   * "app" mode: the recorded copy if it is still ours and answers; otherwise
   * the first port in the span with no listener. Never the system port, and
   * never an Ollama the app did not start.
   */
  /**
   * `pid` holds the listening socket that serves `baseUrl` (false when that
   * cannot be read): on its address or a wildcard, never another loopback
   * address with the same port.
   */
  const holdsPort = async (baseUrl: string, pid: number) =>
    (await listenerPid(Number(portOf(baseUrl)), { ...on, pids: [pid], host: new URL(baseUrl).hostname })) === pid;

  /**
   * The recorded copy's version when it is ours to adopt: identity matches,
   * it holds the recorded port, and an Ollama answers there; identity and
   * listener are checked again once the probe returns.
   */
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
        return { kind: "ready", status: { state: "ready", owner: "app", baseUrl: appBaseUrl, version } };
      }
      // Otherwise its port counts as another program's; the scan below moves past it.
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
    // "app" mode never looks at (or reuses) the system port.
    if (mode === "app") return classifyApp();
    const ext: ProbeResult = await probe(externalBaseUrl, probeTimeoutMs);
    if (ext.kind === "ollama") {
      return { kind: "ready", status: { state: "ready", owner: "external", baseUrl: externalBaseUrl, version: ext.version } };
    }
    if (mode === "system") {
      if (ext.kind === "wrong-service") {
        return { kind: "blocked", status: { state: "wrong-service", owner: "none", baseUrl: externalBaseUrl, detail: ext.detail, ...withBusy([ext.port]) } };
      }
      return {
        kind: "blocked",
        status: {
          state: "missing",
          owner: "none",
          baseUrl: externalBaseUrl,
          detail: `No Ollama answers at ${externalBaseUrl}. Start your Ollama, or choose the app's own copy in Settings › Runtime.`,
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
        if (version !== undefined) {
          return { kind: "ready", status: { state: "ready", owner: "app", baseUrl: appBaseUrl, version } };
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
    const detail =
      platform === "win32"
        ? mode === "app"
          ? WINDOWS_APP_MODE_DETAIL
          : windowsAutomaticDetail(externalBaseUrl)
        : allowInstall
          ? `No Ollama found; the app will install Ollama ${manifest.version} into ${runtimeDir(appDataDir)}.`
          : "No Ollama found on this machine.";
    return noted({ state: "missing", owner: "none", baseUrl: appBaseUrl, detail }, c.note);
  }

  async function start(binary: Binary, note: Note | undefined): Promise<RuntimeStatus> {
    setStatus(noted({ state: "starting", owner: "app", baseUrl: appBaseUrl, detail: `Starting ${binary.path} on port ${appPort}.` }, note));
    mkdirSync(runtimeDir(stateDir), { recursive: true });
    const logFile = serveLogFile(stateDir);
    const log = openSync(logFile, "a");
    const childEnv: Record<string, string | undefined> = { ...env, OLLAMA_HOST: `127.0.0.1:${appPort}` };
    let models: { path: string; hasModels?: boolean } | undefined;
    if (mode === "app") {
      // Its own models folder, so it never writes into a system install's store.
      models = { path: appModelsDir(appDataDir, platform) };
      mkdirSync(models.path, { recursive: true });
    } else {
      models = detectModelsDir(env, options.home, options.systemModelsDirs);
    }
    if (models) childEnv.OLLAMA_MODELS = models.path;
    const readOnly =
      mode === "app" ? undefined : findModelsDirs(env, options.home, options.systemModelsDirs).find((d) => d.hasModels && !d.writable && !models?.hasModels);
    let exited: string | undefined;
    const child = spawn(binary.path, ["serve"], { detached: true, windowsHide: true, stdio: ["ignore", log, log], env: childEnv });
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
          // Our own child, still running: its group on POSIX; on Windows there are no groups.
          if (platform === "win32") child.kill();
          else process.kill(-child.pid, "SIGKILL");
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
    });
    startedPid = proc.pid;
    spawned = child;
    child.once("exit", () => {
      if (spawned === child) spawned = undefined;
    });
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
        },
        note,
      ),
    );
  }

  async function ensureOnce(): Promise<RuntimeStatus> {
    const c = await classify();
    if (c.kind !== "startable") return setStatus(c.status);
    let binary = c.binary;
    if (!binary) {
      if (!allowInstall) return setStatus(statusFor(c));
      setStatus(noted({ state: "installing", owner: "app", baseUrl: appBaseUrl, detail: `Installing Ollama ${manifest.version}.` }, c.note));
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

  /** Windows: through the retained handle only; libuv terminates that process, so a reused PID is never hit. */
  async function stopWindows(): Promise<StopResult> {
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
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const exitWithin = (ms: number) => Promise.race([exited.then(() => true), sleep(ms).then(() => false)]);
    await unloadAll(appBaseUrl);
    child.kill();
    if (!(await exitWithin(STOP_GRACE_MS))) {
      child.kill("SIGKILL");
      await exitWithin(2000);
    }
    clearRecord(stateFile);
    startedPid = undefined;
    spawned = undefined;
    setStatus({ state: "stopped", owner: "none", baseUrl: appBaseUrl, detail: `Stopped the app-owned Ollama (pid ${pid}).` });
    return { stopped: true, pid };
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
      if (platform === "win32") return stopWindows();
      const r = await stopOwned(stateFile, undefined, on);
      if (r.stopped || r.reason !== "no-record") startedPid = undefined;
      if (r.stopped) setStatus({ state: "stopped", owner: "none", baseUrl: appBaseUrl, detail: `Stopped the app-owned Ollama (pid ${r.pid}).` });
      return r;
    },
    startedByThisProcess() {
      if (startedPid === undefined) return false;
      const own = checkOwnership(stateFile, on);
      return own.kind === "ours" && own.record.pid === startedPid;
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
