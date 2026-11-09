// The user's settings: one JSON file in the data dir, decoded with the
// contracts Settings Schema on load and written atomically (temp file, then
// rename). A file that does not decode, or that a newer build wrote, is kept
// aside as `settings.json.bad-<time>` and defaults load; the user's file is
// never lost silently. Other modules read settings through SettingsReader.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ModelSettings, ModelSettingsPatch, Settings, SettingsPatch, type SyncChange } from "@gates-local/contracts";
import * as Result from "effect/Result";
import * as S from "effect/Schema";
import { canonicalTag } from "../runtime/recommended.ts";
import { boundedModelSettings } from "./turn.ts";

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
  /** The revision captured with this immutable value, never the latest revision at serialization. */
  stamp(value: Settings): SyncChange;
  /** Apply a patch (`null` clears defaultModel and comfyUrl), persist, notify. */
  update(patch: SettingsPatch): Settings;
  /** Merge fields for one model; null fields inherit again, a null patch resets the model. */
  updateModel(model: string, patch: ModelSettingsPatch | null): Settings;
  /** Set when the load fell back to defaults: says why and where the old file went. */
  readonly loadNote: string | undefined;
}

export interface SettingsStoreOptions {
  dataDir: string;
  /** First run only: true picks runtimeMode "system", false "app". */
  systemOllamaAnswers: () => Promise<boolean>;
  now?: () => number;
  /** The atomic write's rename (tests inject one that throws). Default fs.renameSync. */
  rename?: (from: string, to: string) => void;
}

/** Defaults for a first run. runtimeMode comes from whether a system Ollama answers. */
export function defaultSettings(runtimeMode: Settings["runtimeMode"]): Settings {
  return { defaultNumCtx: 16384, thinking: true, theme: "dark", runtimeMode, tools: true, imageGen: false };
}

const SettingsFile = S.Struct({ version: S.Number, settings: S.Unknown });
// File compatibility only: accept finite legacy numeric values, normalize them,
// then decode the strict wire schema. New writes always use the strict schemas.
const StoredSettings = S.Struct({
  ...Settings.fields,
  modelSettings: S.optional(S.Record(S.String, S.Struct({
    systemPrompt: S.optional(S.String),
    temperature: S.optional(S.Finite), top_p: S.optional(S.Finite), top_k: S.optional(S.Finite),
    repeat_penalty: S.optional(S.Finite), seed: S.optional(S.Finite), num_predict: S.optional(S.Finite), keep_alive: S.optional(S.Finite),
  }))),
});

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
  const stored = S.decodeUnknownResult(StoredSettings)(settings);
  if (Result.isFailure(stored)) return { kind: "bad", why: `does not match the settings shape (${stored.failure.message})` };
  const models = stored.success.modelSettings;
  const decoded = S.decodeUnknownResult(Settings)({ ...stored.success, ...(models === undefined ? {} : { modelSettings: Object.fromEntries(Object.entries(models).map(([model, value]) => [model, boundedModelSettings(value)])) }) });
  if (Result.isFailure(decoded)) return { kind: "bad", why: `does not match the settings shape (${decoded.failure.message})` };
  return { kind: "ok", settings: decoded.success };
}

function writeAtomic(file: string, settings: Settings, rename: (from: string, to: string) => void = renameSync): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: SETTINGS_FILE_VERSION, settings }, null, 2)}\n`);
  try {
    rename(tmp, file);
  } catch (e) {
    // The old file is untouched; do not leave the half-done write behind.
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** A filename-safe UTC stamp: 2026-11-07T21-04-05-123Z. */
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[:.]/g, "-");

export function applyPatch(current: Settings, patch: SettingsPatch): Settings {
  const { defaultModel, comfyUrl, whisperUrl, systemPrompt, modelSettings, ...rest } = { ...current };
  const next: Settings = { ...rest };
  const model = patch.defaultModel === undefined ? defaultModel : (patch.defaultModel ?? undefined);
  const comfy = patch.comfyUrl === undefined ? comfyUrl : (patch.comfyUrl ?? undefined);
  const whisper = patch.whisperUrl === undefined ? whisperUrl : (patch.whisperUrl ?? undefined);
  const prompt = patch.systemPrompt === undefined ? systemPrompt : (patch.systemPrompt ?? undefined);
  return {
    ...next,
    ...(model === undefined ? {} : { defaultModel: model }),
    ...(comfy === undefined ? {} : { comfyUrl: comfy }),
    ...(whisper === undefined ? {} : { whisperUrl: whisper }),
    ...(prompt === undefined ? {} : { systemPrompt: prompt }),
    ...(patch.modelSettings === null || modelSettings === undefined ? {} : { modelSettings }),
    ...(patch.defaultNumCtx === undefined ? {} : { defaultNumCtx: patch.defaultNumCtx }),
    ...(patch.thinking === undefined ? {} : { thinking: patch.thinking }),
    ...(patch.theme === undefined ? {} : { theme: patch.theme }),
    ...(patch.runtimeMode === undefined ? {} : { runtimeMode: patch.runtimeMode }),
    ...(patch.tools === undefined ? {} : { tools: patch.tools }),
    ...(patch.imageGen === undefined ? {} : { imageGen: patch.imageGen }),
    ...(patch.updateEveryChange === undefined ? {} : { updateEveryChange: patch.updateEveryChange }),
    ...(patch.updateAutomatic === undefined ? {} : { updateAutomatic: patch.updateAutomatic }),
    ...(patch.textSize === undefined ? {} : { textSize: patch.textSize }),
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
    writeAtomic(file, current, options.rename);
  }

  const listeners = new Set<SettingsListener>();
  let revision = 0;
  const revisions = new WeakMap<Settings, number>([[current, revision]]);
  const persist = (next: Settings): Settings => {
    if (sameSettings(next, current)) return current;
    writeAtomic(file, next, options.rename);
    const previous = current;
    current = next;
    revisions.set(next, ++revision);
    for (const l of listeners) l(next, previous);
    return next;
  };
  return {
    loadNote,
    get: () => current,
    stamp(value) {
      const rev = revisions.get(value);
      if (rev === undefined) throw new Error("Settings value was not captured by this store");
      return { scope: "settings", kind: "snapshot", rev };
    },
    update(patch) {
      return persist(S.decodeUnknownSync(Settings)(applyPatch(current, S.decodeUnknownSync(SettingsPatch)(patch))));
    },
    updateModel(model, patch) {
      const key = canonicalTag(model);
      if (!model.trim()) throw new Error("Choose a model before saving its settings.");
      const decoded = patch === null ? null : S.decodeUnknownSync(ModelSettingsPatch)(patch);
      const entries = new Map(Object.entries(current.modelSettings ?? {}));
      // Accept an old unqualified tag, but write one canonical key from now on.
      const previous = entries.get(key) ?? entries.get(model) ?? {};
      if (model !== key) entries.delete(model);
      if (decoded === null) entries.delete(key);
      else {
        const fields = Object.fromEntries(Object.entries({ ...previous, ...decoded }).filter(([, value]) => value !== null && value !== undefined));
        if (Object.keys(fields).length) entries.set(key, S.decodeUnknownSync(ModelSettings)(fields));
        else entries.delete(key);
      }
      const { modelSettings: _old, ...rest } = current;
      return persist(S.decodeUnknownSync(Settings)({ ...rest, ...(entries.size ? { modelSettings: Object.fromEntries(entries) } : {}) }));
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
