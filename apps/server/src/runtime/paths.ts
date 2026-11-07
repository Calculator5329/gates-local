// Where the app keeps its own files, and where Ollama keeps models.
import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type Env = Readonly<Record<string, string | undefined>>;

/** $XDG_DATA_HOME/gates-local, default ~/.local/share/gates-local. */
export function defaultAppDataDir(env: Env = process.env, home = os.homedir()): string {
  const xdg = env.XDG_DATA_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".local", "share");
  return path.join(base, "gates-local");
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

/** First executable `ollama` on PATH, if any. */
export function findOnPath(env: Env = process.env, name = "ollama"): string | undefined {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}
