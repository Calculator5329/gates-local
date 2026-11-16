// why: a free port other than 8188, so it never collides with or adopts the person's own ComfyUI
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import path from "node:path";
import { runtimeDir } from "@gates-local/runtime-files/paths";
import { engineDir, engineFiles, engineRoot, isProcessorBuild, type EngineLayout } from "./engine.ts";
import type { ComfyService } from "./service.ts";

export interface OwnComfy extends ComfyService {
  installed(): boolean;
  address(): string;
  onExit(listener: (pid: number) => void): void;
  modelsDir?(): string;
  build?(): { version: string; cpu: boolean } | undefined;
  holdCard?(version: string): void;
  heldCard?(): string | undefined;
  failedCard?(): string | undefined;
  tryCard?(): void;
  answered?(): void;
  failed?(): string | undefined;
  onHeld?(listener: (version: string) => void): void;
}

export type OwnComfyOptions = {
  appDataDir: string;
  port: number;
  // why: only for tests, so the e2e stack's fake engine can stand in at its own address
  address?: string;
  platform?: NodeJS.Platform;
  stopTimeoutMs?: number;
  extraModels?: () => string | undefined;
};

export const MODEL_KINDS = ["checkpoints", "loras", "diffusion_models", "text_encoders", "vae"] as const;

// external: YAML single-quoted strings keep backslashes as they are, so Windows paths survive
export function extraModelPaths(folder: string): string {
  const quoted = `'${folder.replaceAll("'", "''")}'`;
  return ["gates_local:", `  base_path: ${quoted}`, ...MODEL_KINDS.map((k) => `  ${k}: ${k}`), ""].join("\n");
}

export function extraModelPathsLine(folder: string): string {
  const quoted = `'${folder.replaceAll("'", "''")}'`;
  return `gates_local: { base_path: ${quoted}, ${MODEL_KINDS.map((k) => `${k}: ${k}`).join(", ")} }`;
}

// external: CUDA and Triton cache to ~/.nv/ComputeCache and ~/.triton/cache unless told otherwise
export function engineChildEnv(env: NodeJS.ProcessEnv, appDataDir: string): NodeJS.ProcessEnv {
  return {
    ...env,
    CUDA_CACHE_PATH: path.join(runtimeDir(appDataDir), "cuda-cache"),
    TRITON_CACHE_DIR: path.join(runtimeDir(appDataDir), "triton-cache"),
  };
}

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

// external: ComfyUI keeps models, inputs, outputs and user files under its --base-directory
export function engineDataDir(appDataDir: string): string {
  return path.join(appDataDir, "image");
}

export function engineLogFile(appDataDir: string): string {
  return path.join(runtimeDir(appDataDir), "comfyui.log");
}

const pidFile = (appDataDir: string) => path.join(runtimeDir(appDataDir), "comfyui.pid");
// why: kept outside the pinned engine tree so the tree's checksum stays whole
const deviceFile = (appDataDir: string) => path.join(runtimeDir(appDataDir), "comfyui-device");

export function writeDevice(appDataDir: string, device: "gpu" | "cpu"): void {
  mkdirSync(runtimeDir(appDataDir), { recursive: true });
  writeFileSync(deviceFile(appDataDir), device);
}

const onCpu = (appDataDir: string) => {
  try { return readFileSync(deviceFile(appDataDir), "utf8").trim() === "cpu"; } catch { return false; }
};

const heldFile = (appDataDir: string) => path.join(runtimeDir(appDataDir), "comfyui-card-held");
const failedFile = (appDataDir: string) => path.join(runtimeDir(appDataDir), "comfyui-card-failed");

const readLines = (file: string): string[] => {
  try { return readFileSync(file, "utf8").split("\n").map((line) => line.trim()).filter((line) => line !== ""); } catch { return []; }
};
const readHeld = (appDataDir: string): string[] => readLines(heldFile(appDataDir));

function writeLines(appDataDir: string, file: string, versions: readonly string[]): void {
  mkdirSync(runtimeDir(appDataDir), { recursive: true });
  writeFileSync(file, versions.join("\n"));
}
const writeHeld = (appDataDir: string, versions: readonly string[]) => writeLines(appDataDir, heldFile(appDataDir), versions);

export function createOwnComfy(opts: OwnComfyOptions): OwnComfy {
  const platform = opts.platform ?? process.platform;
  const layout: EngineLayout = platform === "win32" ? "windows-portable" : "uv-venv";
  const whole = (dir: string) => { const f = engineFiles(dir, layout); return existsSync(f.python) && existsSync(f.main); };
  const builds = (): string[] => {
    let entries: string[];
    try { entries = readdirSync(engineRoot(opts.appDataDir)); } catch { return []; }
    return entries.filter((e) => !e.startsWith(".")).toSorted((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .filter((v) => whole(engineDir(opts.appDataDir, v)));
  };
  const heldHere = new Set<string>();
  const heldNow = () => [...readHeld(opts.appDataDir), ...heldHere];
  let trying = false;
  let ran: string | undefined;
  const find = (): string | undefined => {
    const versions = builds();
    const processor = versions.find(isProcessorBuild);
    const held = processor === undefined || trying ? [] : heldNow();
    const card = onCpu(opts.appDataDir) ? undefined : versions.find((v) => !isProcessorBuild(v) && !held.includes(v));
    const version = card ?? processor ?? versions[0];
    return version === undefined ? undefined : engineDir(opts.appDataDir, version);
  };
  const hold = (version: string) => {
    heldHere.add(version);
    const onDisk = readHeld(opts.appDataDir);
    if (onDisk.includes(version)) return;
    try { writeHeld(opts.appDataDir, [...onDisk, version]); } catch {}
  };
  const failedHere = new Set<string>();
  const failedNow = () => [...readLines(failedFile(opts.appDataDir)), ...failedHere];
  const markFailed = (version: string) => {
    failedHere.add(version);
    const onDisk = readLines(failedFile(opts.appDataDir));
    if (onDisk.includes(version)) return;
    try { writeLines(opts.appDataDir, failedFile(opts.appDataDir), [...onDisk, version]); } catch {}
  };
  const release = (version: string) => {
    heldHere.delete(version);
    failedHere.delete(version);
    const failed = readLines(failedFile(opts.appDataDir));
    if (failed.includes(version)) {
      try { writeLines(opts.appDataDir, failedFile(opts.appDataDir), failed.filter((v) => v !== version)); } catch {}
    }
    const onDisk = readHeld(opts.appDataDir);
    if (!onDisk.includes(version)) return;
    try { writeHeld(opts.appDataDir, onDisk.filter((v) => v !== version)); } catch {}
  };
  const heldListeners: ((version: string) => void)[] = [];
  let child: ChildProcess | undefined;
  let exited: Promise<void> = Promise.resolve();
  let ending: ChildProcess | undefined;
  const listeners: ((pid: number) => void)[] = [];
  const signalRun = (run: ChildProcess, sig: NodeJS.Signals) => {
    try {
      if (platform === "win32" || run.pid === undefined) run.kill(sig);
      else process.kill(-run.pid, sig);
    // external: Node's process.kill throws ESRCH when the process is already gone
    } catch {}
  };
  const endLeftover = () => {
    if (platform !== "linux") return;
    try {
      const { pid, main } = JSON.parse(readFileSync(pidFile(opts.appDataDir), "utf8")) as { pid: number; main: string };
      if (readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(main)) process.kill(-pid, "SIGKILL");
    } catch {}
  };
  const buildOf = (dir: string) => ({ version: path.basename(dir), cpu: isProcessorBuild(path.basename(dir)) || onCpu(opts.appDataDir) });
  const own: OwnComfy = {
    installed: () => find() !== undefined,
    build: () => { const dir = find(); return dir === undefined ? undefined : buildOf(dir); },
    holdCard: hold,
    heldCard() {
      const versions = builds();
      if (!versions.some(isProcessorBuild)) return undefined;
      const held = heldNow();
      return versions.find((v) => !isProcessorBuild(v) && held.includes(v));
    },
    failedCard() {
      const held = own.heldCard?.();
      return held !== undefined && failedNow().includes(held) ? held : undefined;
    },
    tryCard: () => { trying = true; },
    answered() {
      trying = false;
      if (ran !== undefined) release(ran);
    },
    failed() {
      const version = ran;
      if (child !== undefined) return undefined;
      trying = false;
      if (version === undefined || isProcessorBuild(version) || !builds().some(isProcessorBuild)) return undefined;
      hold(version);
      markFailed(version);
      for (const listener of heldListeners) listener(version);
      return version;
    },
    onHeld: (listener) => { heldListeners.push(listener); },
    address: () => opts.address ?? `http://127.0.0.1:${opts.port}`,
    modelsDir: () => path.join(engineDataDir(opts.appDataDir), "models"),
    async inspect() {
      const active = child !== undefined;
      return { present: find() !== undefined, active, activeState: active ? "active" : "inactive", pid: child?.pid ?? 0 };
    },
    async start() {
      if (child !== undefined) return;
      const dir = find();
      if (dir === undefined) throw new Error("The image engine is not installed.");
      ran = path.basename(dir);
      const files = engineFiles(dir, layout);
      endLeftover();
      // external: ComfyUI 0.44 exits at start when <base>/custom_nodes is missing
      mkdirSync(path.join(engineDataDir(opts.appDataDir), "custom_nodes"), { recursive: true });
      mkdirSync(runtimeDir(opts.appDataDir), { recursive: true });
      const picked = opts.extraModels?.();
      const extra = path.join(runtimeDir(opts.appDataDir), "comfyui-extra-models.yaml");
      if (picked !== undefined) writeFileSync(extra, extraModelPaths(picked));
      const args = [
        ...layout === "windows-portable" ? ["-s"] : [],
        files.main,
        "--listen", "127.0.0.1",
        "--port", String(opts.port),
        "--disable-auto-launch",
        "--base-directory", engineDataDir(opts.appDataDir),
        ...picked === undefined ? [] : ["--extra-model-paths-config", extra],
        ...buildOf(dir).cpu ? ["--cpu"] : [],
        ...layout === "windows-portable" ? ["--windows-standalone-build"] : [],
      ];
      const log = openSync(engineLogFile(opts.appDataDir), "a");
      let run: ChildProcess;
      try {
        run = spawn(files.python, args, { cwd: files.cwd, env: engineChildEnv(process.env, opts.appDataDir), stdio: ["ignore", log, log], detached: platform !== "win32", windowsHide: true });
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
        // why: the pid file only feeds the best-effort leftover kill, so a failed write is ignored
        try { writeFileSync(pidFile(opts.appDataDir), JSON.stringify({ pid: run.pid, main: files.main })); } catch {}
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
