// Where the app keeps its own files, and where Ollama keeps models.
// Functions that differ on Windows take the platform so tests can inject it;
// they then use path.win32 rules whatever machine the test runs on.
import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type Env = Readonly<Record<string, string | undefined>>;

const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? path.win32 : path.posix);

/** %LOCALAPPDATA% (falling back to <home>\AppData\Local) on Windows. */
function localAppData(env: Env, home: string): string {
  const local = env.LOCALAPPDATA;
  return local && path.win32.isAbsolute(local) ? local : path.win32.join(home, "AppData", "Local");
}

/**
 * Windows: %LOCALAPPDATA%\GatesLocal. Elsewhere $XDG_DATA_HOME/gates-local,
 * default ~/.local/share/gates-local.
 */
export function defaultAppDataDir(env: Env = process.env, home = os.homedir(), platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return path.win32.join(localAppData(env, home), "GatesLocal");
  const xdg = env.XDG_DATA_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".local", "share");
  return path.join(base, "gates-local");
}

export const ollamaBinaryName = (platform: NodeJS.Platform = process.platform) => (platform === "win32" ? "ollama.exe" : "ollama");

/** Where the official Windows installer puts Ollama for the current user. */
export function windowsInstalledOllama(env: Env = process.env, home = os.homedir()): string {
  return path.win32.join(localAppData(env, home), "Programs", "Ollama", "ollama.exe");
}

/** The models folder of the app's own Ollama in `app` runtime mode, kept apart from any system install. */
export function appModelsDir(appDataDir: string, platform: NodeJS.Platform = process.platform): string {
  return pathFor(platform).join(appDataDir, "models");
}

export function runtimeDir(appDataDir: string): string {
  return path.join(appDataDir, "runtime");
}

export function installRoot(appDataDir: string): string {
  return path.join(runtimeDir(appDataDir), "ollama");
}

export function installDir(appDataDir: string, version: string): string {
  return path.join(installRoot(appDataDir), version);
}

export function installedBinary(appDataDir: string, version: string): string {
  return path.join(installDir(appDataDir, version), "bin", "ollama");
}

export function ownedStateFile(appDataDir: string): string {
  return path.join(runtimeDir(appDataDir), "owned-ollama.json");
}

export function serveLogFile(appDataDir: string): string {
  return path.join(runtimeDir(appDataDir), "ollama-serve.log");
}

export type ModelsDir = {
  path: string;
  writable: boolean;
  /** `manifests/` holds at least one entry. */
  hasModels: boolean;
  source: "OLLAMA_MODELS" | "home-default" | "system";
};

/** Where distro and upstream installs keep a system service's models. */
export const SYSTEM_MODELS_DIRS = ["/var/lib/ollama", "/var/lib/ollama/models", "/usr/share/ollama/.ollama/models"];

function looksLikeModelsDir(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return existsSync(path.join(dir, "manifests")) || existsSync(path.join(dir, "blobs"));
}

function hasManifests(dir: string): boolean {
  try {
    return readdirSync(path.join(dir, "manifests")).length > 0;
  } catch {
    return false;
  }
}

function isWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every existing models directory, in preference order: OLLAMA_MODELS,
 * ~/.ollama/models, then system-service locations. A candidate counts only
 * when it already holds `manifests` or `blobs`.
 */
export function findModelsDirs(env: Env = process.env, home = os.homedir(), systemDirs: readonly string[] = SYSTEM_MODELS_DIRS): ModelsDir[] {
  const candidates: { path: string; source: ModelsDir["source"] }[] = [];
  if (env.OLLAMA_MODELS) candidates.push({ path: env.OLLAMA_MODELS, source: "OLLAMA_MODELS" });
  candidates.push({ path: path.join(home, ".ollama", "models"), source: "home-default" });
  for (const d of systemDirs) candidates.push({ path: d, source: "system" });
  const seen = new Set<string>();
  const found: ModelsDir[] = [];
  for (const c of candidates) {
    if (seen.has(c.path) || !looksLikeModelsDir(c.path)) continue;
    seen.add(c.path);
    found.push({ ...c, writable: isWritable(c.path), hasModels: hasManifests(c.path) });
  }
  return found;
}

/**
 * The models directory an app-owned server should use, so models are not
 * downloaded twice: the first writable one that already has models, else
 * the first writable one. A store this user cannot write (a system
 * service's) is never handed to the app-owned server, since pulls and blob
 * pruning there would fail; `findModelsDirs` still reports it. Undefined
 * means Ollama's own default applies.
 */
export function detectModelsDir(env: Env = process.env, home = os.homedir(), systemDirs: readonly string[] = SYSTEM_MODELS_DIRS): ModelsDir | undefined {
  const all = findModelsDirs(env, home, systemDirs);
  return all.find((d) => d.writable && d.hasModels) ?? all.find((d) => d.writable);
}

/**
 * First executable `ollama` on PATH, if any. On Windows PATH is
 * `;`-separated (and may be spelled `Path`), only `.exe` is tried (a
 * `.cmd` or `.bat` shim is not a binary the app can own and stop by
 * handle), and existence counts as executable.
 */
export function findOnPath(
  env: Env = process.env,
  name = "ollama",
  platform: NodeJS.Platform = process.platform,
  isExecutable: (file: string) => boolean = executableCheck(platform),
): string | undefined {
  const win = platform === "win32";
  const p = pathFor(platform);
  const search = (win ? (env.PATH ?? env.Path) : env.PATH) ?? "";
  const exts = win && p.extname(name) === "" ? [".exe"] : [""];
  for (const dir of search.split(win ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = p.join(dir, name + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/** A regular file this user may run; on Windows, any regular file. */
export function executableCheck(platform: NodeJS.Platform = process.platform): (file: string) => boolean {
  return (file) => {
    try {
      accessSync(file, platform === "win32" ? constants.F_OK : constants.X_OK);
      return statSync(file).isFile();
    } catch {
      return false;
    }
  };
}

/** A system Ollama binary: PATH first, then (Windows) the installer's per-user location. */
export function findSystemOllama(
  env: Env = process.env,
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
  isExecutable: (file: string) => boolean = executableCheck(platform),
): string | undefined {
  const onPath = findOnPath(env, "ollama", platform, isExecutable);
  if (onPath || platform !== "win32") return onPath;
  const installed = windowsInstalledOllama(env, home);
  return isExecutable(installed) ? installed : undefined;
}
