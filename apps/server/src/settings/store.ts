import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ModelSettings, ModelSettingsPatch, Settings, SettingsPatch, type SyncChange } from "@gates-local/contracts";
import * as Result from "effect/Result";
import * as S from "effect/Schema";
import { canonicalTag } from "../runtime/recommended.ts";
import { createRevisions } from "../ws/revisions.ts";
import { boundedModelSettings } from "./turn.ts";

export const SETTINGS_FILE_VERSION = 1;
export const SETTINGS_FILE_NAME = "settings.json";

export type SettingsListener = (next: Settings, previous: Settings) => void;

export interface SettingsReader {
  get(): Settings;
  onChange(listener: SettingsListener): () => void;
}

export interface SettingsStore extends SettingsReader {
  stamp(value: Settings): SyncChange;
  update(patch: SettingsPatch): Settings;
  updateModel(model: string, patch: ModelSettingsPatch | null): Settings;
  readonly loadNote: string | undefined;
}

export interface SettingsStoreOptions {
  dataDir: string;
  systemOllamaAnswers: () => Promise<boolean>;
  now?: () => number;
  rename?: (from: string, to: string) => void;
}

export function defaultSettings(runtimeMode: Settings["runtimeMode"]): Settings {
  return { defaultNumCtx: 16384, thinking: true, theme: "dark", runtimeMode, tools: true, imageGen: false };
}

const SettingsFile = S.Struct({ version: S.Number, settings: S.Unknown });
// why: a file from before the limits holds any finite number; it is clamped, then decoded strictly.
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
    rmSync(tmp, { force: true });
    throw e;
  }
}

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[:.]/g, "-");

export function applyPatch(current: Settings, patch: SettingsPatch): Settings {
  const { defaultModel, comfyUrl, imageFolder, whisperUrl, systemPrompt, modelSettings, imageChoice, imageTool, ...rest } = { ...current };
  const next: Settings = { ...rest };
  const model = patch.defaultModel === undefined ? defaultModel : (patch.defaultModel ?? undefined);
  const tool = patch.imageTool === undefined ? imageTool : (patch.imageTool ?? undefined);
  const choice = patch.imageChoice === undefined ? imageChoice : (patch.imageChoice ?? undefined);
  const comfy = patch.comfyUrl === undefined ? comfyUrl : (patch.comfyUrl ?? undefined);
  const folder = patch.imageFolder === undefined ? imageFolder : (patch.imageFolder ?? undefined);
  const whisper = patch.whisperUrl === undefined ? whisperUrl : (patch.whisperUrl ?? undefined);
  const prompt = patch.systemPrompt === undefined ? systemPrompt : (patch.systemPrompt ?? undefined);
  return {
    ...next,
    ...(model === undefined ? {} : { defaultModel: model }),
    ...(comfy === undefined ? {} : { comfyUrl: comfy }),
    ...(folder === undefined ? {} : { imageFolder: folder }),
    ...(whisper === undefined ? {} : { whisperUrl: whisper }),
    ...(prompt === undefined ? {} : { systemPrompt: prompt }),
    ...(choice === undefined ? {} : { imageChoice: choice }),
    ...(patch.modelSettings === null || modelSettings === undefined ? {} : { modelSettings }),
    ...(patch.defaultNumCtx === undefined ? {} : { defaultNumCtx: patch.defaultNumCtx }),
    ...(patch.thinking === undefined ? {} : { thinking: patch.thinking }),
    ...(patch.theme === undefined ? {} : { theme: patch.theme }),
    ...(patch.runtimeMode === undefined ? {} : { runtimeMode: patch.runtimeMode }),
    ...(patch.tools === undefined ? {} : { tools: patch.tools }),
    ...(patch.imageGen === undefined ? {} : { imageGen: patch.imageGen }),
    ...(tool === undefined ? {} : { imageTool: tool }),
    ...(patch.updateEveryChange === undefined ? {} : { updateEveryChange: patch.updateEveryChange }),
    ...(patch.updateAutomatic === undefined ? {} : { updateAutomatic: patch.updateAutomatic }),
    ...(patch.accent === undefined ? {} : { accent: patch.accent }),
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
  const revisions = createRevisions<Settings>("settings", current);
  const persist = (next: Settings): Settings => {
    if (sameSettings(next, current)) return current;
    writeAtomic(file, next, options.rename);
    const previous = current;
    current = revisions.commit(next);
    for (const l of listeners) l(next, previous);
    return next;
  };
  return {
    loadNote,
    get: () => current,
    stamp: revisions.stamp,
    update(patch) {
      return persist(S.decodeUnknownSync(Settings)(applyPatch(current, S.decodeUnknownSync(SettingsPatch)(patch))));
    },
    updateModel(model, patch) {
      const key = canonicalTag(model);
      if (!model.trim()) throw new Error("Choose a model before saving its settings.");
      const decoded = patch === null ? null : S.decodeUnknownSync(ModelSettingsPatch)(patch);
      const entries = new Map(Object.entries(current.modelSettings ?? {}));
      // why: an old file may hold the unqualified tag; from here on one canonical key is written.
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
