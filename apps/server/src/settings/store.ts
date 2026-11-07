// The user's settings: one JSON file in the data dir, decoded with the
// contracts Settings Schema on load and written atomically (temp file, then
// rename). A file that does not decode, or that a newer build wrote, is kept
// aside as `settings.json.bad-<time>` and defaults load; the user's file is
// never lost silently. Other modules read settings through SettingsReader.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Settings, type SettingsPatch } from "@gates-local/contracts";
import { Result, Schema as S } from "effect";

/** The file format version this build writes. A higher one is a newer build's file. */
export const SETTINGS_FILE_VERSION = 1;
export const SETTINGS_FILE_NAME = "settings.json";

export type SettingsListener = (next: Settings, previous: Settings) => void;

/** What other modules see: the current settings and a change feed. */
export interface SettingsReader {
  get(): Settings;
  /** Called after every update that changed something. Returns the unsubscribe. */
  onChange(listener: SettingsListener): () => void;
}

export interface SettingsStore extends SettingsReader {
  /** Apply a patch (`null` clears defaultModel and comfyUrl), persist, notify. */
  update(patch: SettingsPatch): Settings;
  /** Set when the load fell back to defaults: says why and where the old file went. */
  readonly loadNote: string | undefined;
}

export interface SettingsStoreOptions {
  dataDir: string;
  /** First run only: true picks runtimeMode "system", false "app". */
  systemOllamaAnswers: () => Promise<boolean>;
  now?: () => number;
}

/** Defaults for a first run. runtimeMode comes from whether a system Ollama answers. */
export function defaultSettings(runtimeMode: Settings["runtimeMode"]): Settings {
  return { defaultNumCtx: 16384, thinking: true, theme: "system", runtimeMode, tools: true, imageGen: false };
}

const SettingsFile = S.Struct({ version: S.Number, settings: S.Unknown });

type Loaded = { kind: "ok"; settings: Settings } | { kind: "absent" } | { kind: "bad"; why: string };

function readFile(file: string): Loaded {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "bad", why: `could not be read (${(e as Error).message})` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "bad", why: "is not valid JSON" };
  }
  const envelope = S.decodeUnknownResult(SettingsFile)(json);
  if (Result.isFailure(envelope)) return { kind: "bad", why: "has no version and settings fields" };
  const { version, settings } = envelope.success;
  if (version > SETTINGS_FILE_VERSION) return { kind: "bad", why: `was written by a newer Gates Local (format ${version}; this build reads ${SETTINGS_FILE_VERSION})` };
  if (version !== SETTINGS_FILE_VERSION) return { kind: "bad", why: `has an unknown format version ${version}` };
  const decoded = S.decodeUnknownResult(Settings)(settings);
  if (Result.isFailure(decoded)) return { kind: "bad", why: `does not match the settings shape (${decoded.failure.message})` };
  return { kind: "ok", settings: decoded.success };
}

function writeAtomic(file: string, settings: Settings): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: SETTINGS_FILE_VERSION, settings }, null, 2)}\n`);
  renameSync(tmp, file);
}

/** A filename-safe UTC stamp: 2026-11-07T21-04-05-123Z. */
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[:.]/g, "-");

export function applyPatch(current: Settings, patch: SettingsPatch): Settings {
  const { defaultModel, comfyUrl, ...rest } = { ...current };
  const next: Settings = { ...rest };
  const model = patch.defaultModel === undefined ? defaultModel : (patch.defaultModel ?? undefined);
  const comfy = patch.comfyUrl === undefined ? comfyUrl : (patch.comfyUrl ?? undefined);
  return {
    ...next,
    ...(model === undefined ? {} : { defaultModel: model }),
    ...(comfy === undefined ? {} : { comfyUrl: comfy }),
    ...(patch.defaultNumCtx === undefined ? {} : { defaultNumCtx: patch.defaultNumCtx }),
    ...(patch.thinking === undefined ? {} : { thinking: patch.thinking }),
    ...(patch.theme === undefined ? {} : { theme: patch.theme }),
    ...(patch.runtimeMode === undefined ? {} : { runtimeMode: patch.runtimeMode }),
    ...(patch.tools === undefined ? {} : { tools: patch.tools }),
    ...(patch.imageGen === undefined ? {} : { imageGen: patch.imageGen }),
  };
}

const sameSettings = (a: Settings, b: Settings) => JSON.stringify(Object.entries(a).toSorted()) === JSON.stringify(Object.entries(b).toSorted());

export async function openSettingsStore(options: SettingsStoreOptions): Promise<SettingsStore> {
  const now = options.now ?? Date.now;
  const file = path.join(options.dataDir, SETTINGS_FILE_NAME);
  const loaded = readFile(file);
  let current: Settings;
  let loadNote: string | undefined;
  if (loaded.kind === "ok") {
    current = loaded.settings;
  } else {
    if (loaded.kind === "bad") {
      const aside = `${file}.bad-${stamp(now())}`;
      renameSync(file, aside);
      loadNote = `${file} ${loaded.why}; kept it as ${aside} and loaded the defaults.`;
    }
    current = defaultSettings((await options.systemOllamaAnswers()) ? "system" : "app");
    writeAtomic(file, current);
  }

  const listeners = new Set<SettingsListener>();
  return {
    loadNote,
    get: () => current,
    update(patch) {
      const next = applyPatch(current, patch);
      if (sameSettings(next, current)) return current;
      writeAtomic(file, next);
      const previous = current;
      current = next;
      for (const l of listeners) l(next, previous);
      return next;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
