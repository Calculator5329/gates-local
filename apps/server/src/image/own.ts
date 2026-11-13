// The app's own ComfyUI (engine.ts) run as a child process on a free local
// port, never 8188, so it neither collides with nor adopts a ComfyUI the
// person runs. Its models, inputs, outputs and user files live under
// <appData>/image (--base-directory), and its log in
// <appData>/runtime/comfyui.log. It implements the same seam as the
// systemd unit (service.ts), so the module's start, idle stop and shutdown
// deadline are unchanged: only what starts and stops it differs.
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import path from "node:path";
import { runtimeDir } from "../runtime/paths.ts";
import { engineDir, engineFiles, engineRoot, type EngineLayout } from "./engine.ts";
import type { ComfyService } from "./service.ts";

export interface OwnComfy extends ComfyService {
  /** An engine tree is whole in the app's folder. */
  installed(): boolean;
  /** Where it answers once started: http://127.0.0.1:<port>. */
  address(): string;
  /** Told the pid of a run that ends without the app asking (a crash, a kill from outside); stop and killRuntimeNow are not told. */
  onExit(listener: (pid: number) => void): void;
}

export type OwnComfyOptions = {
  appDataDir: string;
  /** The free port main.ts picked at startup. */
  port: number;
  /** Tests only (the e2e stack's fake engine): read this address instead of 127.0.0.1:<port>. */
  address?: string;
  platform?: NodeJS.Platform;
  /** How long a stop waits for the engine to exit before it kills it. */
  stopTimeoutMs?: number;
};

/** A local TCP port free now, for the engine to listen on (picked once at startup). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** The folder ComfyUI keeps models, inputs, outputs and user files in. */
export function engineDataDir(appDataDir: string): string {
  return path.join(appDataDir, "image");
}

export function engineLogFile(appDataDir: string): string {
  return path.join(runtimeDir(appDataDir), "comfyui.log");
}

const pidFile = (appDataDir: string) => path.join(runtimeDir(appDataDir), "comfyui.pid");
/** What the setup chose the engine runs on: "cpu" where the card cannot run pictures. Outside the pinned tree, so its checksum stays whole. */
const deviceFile = (appDataDir: string) => path.join(runtimeDir(appDataDir), "comfyui-device");

export function writeDevice(appDataDir: string, device: "gpu" | "cpu"): void {
  mkdirSync(runtimeDir(appDataDir), { recursive: true });
  writeFileSync(deviceFile(appDataDir), device);
}

const onCpu = (appDataDir: string) => {
  try { return readFileSync(deviceFile(appDataDir), "utf8").trim() === "cpu"; } catch { return false; }
};

export function createOwnComfy(opts: OwnComfyOptions): OwnComfy {
  const platform = opts.platform ?? process.platform;
  const layout: EngineLayout = platform === "win32" ? "windows-portable" : "uv-venv";
  const whole = (dir: string) => { const f = engineFiles(dir, layout); return existsSync(f.python) && existsSync(f.main); };
  /** The newest whole version under runtime/comfyui/. */
  const find = (): string | undefined => {
    let entries: string[];
    try { entries = readdirSync(engineRoot(opts.appDataDir)); } catch { return undefined; }
    return entries.filter((e) => !e.startsWith(".")).toSorted((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((v) => engineDir(opts.appDataDir, v)).find(whole);
  };
  let child: ChildProcess | undefined;
  let exited: Promise<void> = Promise.resolve();
  /** The run the app asked to end (stop, killRuntimeNow): its exit is not news. */
  let ending: ChildProcess | undefined;
  const listeners: ((pid: number) => void)[] = [];
  /** Its process group on Linux (it runs detached), so the stop reaches whatever it started. */
  const signalRun = (run: ChildProcess, sig: NodeJS.Signals) => {
    try {
      if (platform === "win32" || run.pid === undefined) run.kill(sig);
      else process.kill(-run.pid, sig);
    } catch { /* already gone */ }
  };
  /** A run the app left behind when it was killed: ended before a new one starts, if it is still ours. */
  const endLeftover = () => {
    if (platform !== "linux") return;
    try {
      const { pid, main } = JSON.parse(readFileSync(pidFile(opts.appDataDir), "utf8")) as { pid: number; main: string };
      if (readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(main)) process.kill(-pid, "SIGKILL");
    } catch { /* none, gone, or not ours */ }
  };
  const own: OwnComfy = {
    installed: () => find() !== undefined,
    address: () => opts.address ?? `http://127.0.0.1:${opts.port}`,
    async inspect() {
      const active = child !== undefined;
      return { present: find() !== undefined, active, activeState: active ? "active" : "inactive", pid: child?.pid ?? 0 };
    },
    async start() {
      if (child !== undefined) return;
      const dir = find();
      if (dir === undefined) throw new Error("The image engine is not installed.");
      const files = engineFiles(dir, layout);
      endLeftover();
      mkdirSync(engineDataDir(opts.appDataDir), { recursive: true });
      mkdirSync(runtimeDir(opts.appDataDir), { recursive: true });
      const args = [
        ...layout === "windows-portable" ? ["-s"] : [],
        files.main,
        "--listen", "127.0.0.1",
        "--port", String(opts.port),
        "--disable-auto-launch",
        "--base-directory", engineDataDir(opts.appDataDir),
        ...onCpu(opts.appDataDir) ? ["--cpu"] : [],
        ...layout === "windows-portable" ? ["--windows-standalone-build"] : [],
      ];
      const log = openSync(engineLogFile(opts.appDataDir), "a");
      let run: ChildProcess;
      try {
        run = spawn(files.python, args, { cwd: files.cwd, stdio: ["ignore", log, log], detached: platform !== "win32", windowsHide: true });
      } finally { closeSync(log); }
      await new Promise<void>((resolve, reject) => {
        run.once("spawn", resolve);
        run.once("error", reject);
      });
      child = run;
      exited = new Promise((resolve) => run.once("exit", () => {
        if (child === run) child = undefined;
        if (ending !== run && run.pid !== undefined) for (const listener of listeners) listener(run.pid);
        resolve();
      }));
      if (run.pid !== undefined) {
        try { writeFileSync(pidFile(opts.appDataDir), JSON.stringify({ pid: run.pid, main: files.main })); } catch { /* the leftover check is best effort */ }
      }
    },
    async stop() {
      const run = child;
      if (run === undefined) return;
      ending = run;
      signalRun(run, "SIGTERM");
      const timer = setTimeout(() => signalRun(run, "SIGKILL"), opts.stopTimeoutMs ?? 10_000);
      await exited;
      clearTimeout(timer);
    },
    killRuntimeNow(ownedPid) {
      if (child !== undefined && child.pid === ownedPid) { ending = child; signalRun(child, "SIGKILL"); }
    },
    onExit: (listener) => { listeners.push(listener); },
  };
  return own;
}
