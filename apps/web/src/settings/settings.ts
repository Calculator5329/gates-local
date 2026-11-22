import type { CallOptions, ClientSync, ContextSize, MethodName, Params, Payload, ResultOf, Settings, SettingsPatch, ModelSettingsPatch, SyncMetadata } from "@gates-local/contracts";
import type { ServerEvent, SettingsAuthority } from "../lib/session/server-state.ts";
import { noGpu } from "../lib/words/format.ts";
import { NA, type State, getState, setState } from "../lib/store/store.ts";

type Act = <M extends MethodName>(method: M, params: Params<M>, what: string, todo?: string, options?: CallOptions<M>) => Promise<{ readonly ok: true; readonly value: ResultOf<M> } | { readonly ok: false; readonly message: string }>;

export const RESET_SETTINGS = {
  defaultModel: null,
  defaultNumCtx: 16384,
  thinking: true,
  theme: "dark",
  tools: true,
  imageGen: false,
  imageChoice: null,
  imageTool: null,
  comfyUrl: null,
  imageFolder: null,
  whisperUrl: null,
  updateEveryChange: false,
  updateAutomatic: true,
  freeOthers: false,
  accent: "neutral",
  systemPrompt: null,
  modelSettings: null,
} as const satisfies SettingsPatch;

interface SettingsEffects {
  readonly applyServerEvent: (event: ServerEvent) => void;
  readonly authority: SettingsAuthority;
  readonly sync: () => ClientSync | undefined;
  readonly act: Act;
  readonly applyTheme: (theme: Settings["theme"]) => void;
  readonly applyAccent: (accent: Settings["accent"]) => void;
}

export function createSettings({ applyServerEvent, authority, sync, act, applyTheme, applyAccent }: SettingsEffects) {
  let staging = false;
  // why: a close clears the connection's sync mode while the accepted batch still finishes
  let negotiated: ClientSync | undefined;
  const connectionSync = () => negotiated = sync() ?? negotiated;

  // why: authority takes settings at once; the screen waits for the whole ready batch
  function acceptSettings(settings: Settings, metadata: SyncMetadata | undefined, own = false): void {
    applyServerEvent(() => {
      const current = connectionSync();
      if (current === undefined || metadata === undefined) return;
      authority.begin(current);
      const accepted = authority.accept(settings, metadata);
      if (accepted === undefined) return;
      const visible = getState().settings;
      const previous = accepted.previous ?? (visible === NA ? undefined : visible);
      if (!own && previous?.whisperUrl !== settings.whisperUrl) {
        applyServerEvent(s => ({ voiceConnectionVersion: s.voiceConnectionVersion + 1 }));
      }
      if (!staging) applySettings(settings, false, true);
    });
  }
  let thinkSeeded = false;
  let contextSeeded = false;

  // why: a speech save this window made is matched at receipt, so its echo is not another window's
  const voiceWrites = new Set<string>();

  const SETTING_WORDS: Record<keyof SettingsPatch, string> = {
    defaultModel: "save the default model",
    defaultNumCtx: "save the default context window",
    thinking: "save the thinking setting",
    theme: "save the theme",
    runtimeMode: "save the Ollama choice",
    tools: "save the tools setting",
    imageGen: "save image generation",
    imageChoice: "save the image model",
    imageTool: "save the image tool setting",
    comfyUrl: "save the ComfyUI address",
    imageFolder: "save the image download folder",
    whisperUrl: "save voice to text",
    updateEveryChange: "save the update setting",
    updateAutomatic: "save automatic update checks",
    freeOthers: "save the memory choice",
    accent: "save the accent",
    systemPrompt: "save the system prompt",
    modelSettings: "reset model settings",
  };

  function settingsPatch(_s: State, settings: Settings, first: boolean): Partial<State> {
    const before = _s.settings === NA ? undefined : _s.settings;
    return {
      settings,
      ...(before !== undefined && before.defaultModel !== settings.defaultModel ? { chosen: undefined } : {}),
      voiceConnectionVersion: _s.voiceConnectionVersion,
      ...(first && !contextSeeded ? { numCtx: settings.defaultNumCtx } : {}),
      ...(first && !thinkSeeded ? { think: settings.thinking } : {}),
      ...(!settings.imageGen ? { image: false } : {}),
    };
  }

  function applySettings(settings: Settings, first = false, preserveVoiceIntent = false): void {
    applyServerEvent((s) => ({ ...settingsPatch(s, settings, first),
      ...(preserveVoiceIntent ? { voiceConnectionVersion: s.voiceConnectionVersion } : {}),
    }));
    applyTheme(settings.theme);
    applyAccent(settings.accent);
  }

  function setContext(numCtx: ContextSize): void {
    contextSeeded = true;
    setState({ numCtx });
  }

  async function updateSettings(patch: SettingsPatch, options: { voiceActionStarted?: boolean } = {}): Promise<string | null> {
    const keys = Object.keys(patch) as Array<keyof SettingsPatch>;
    const what = keys.length === 1 && keys[0] !== undefined ? SETTING_WORDS[keys[0]] : "save these settings";
    const voiceChange = "whisperUrl" in patch ? crypto.randomUUID() : undefined;
    if (voiceChange !== undefined) {
      if (!options.voiceActionStarted) setState((s) => ({ voiceConnectionVersion: s.voiceConnectionVersion + 1 }));
      voiceWrites.add(voiceChange);
    }
    let saved = false;
    try {
      const r = await act("settings.update", { ...patch, ...(voiceChange === undefined ? {} : { voiceChange }) }, what, undefined, {
        onResult(value, metadata) { acceptSettings(value, metadata, voiceChange !== undefined && voiceWrites.delete(voiceChange)); },
      });
      if (!r.ok) return r.message;
      saved = true;
      return null;
    } finally { if (!saved && voiceChange !== undefined) voiceWrites.delete(voiceChange); }
  }

  async function updateModelSettings(model: string, patch: ModelSettingsPatch | null): Promise<string | null> {
    const r = await act("settings.model.update", { model, patch }, "save model settings", undefined, {
      onResult: (value, metadata) => acceptSettings(value, metadata),
    });
    return r.ok ? null : r.message;
  }

  async function resetSettings(): Promise<string | null> {
    const failed = await updateSettings(RESET_SETTINGS);
    if (failed !== null) return failed;
    setContext(RESET_SETTINGS.defaultNumCtx);
    setState({ think: RESET_SETTINGS.thinking });
    return null;
  }

  function receiveSettings({ voiceChange, ...settings }: Payload<"settings.changed">, metadata?: SyncMetadata): void {
    acceptSettings(settings, metadata, voiceChange !== undefined && voiceWrites.delete(voiceChange));
  }

  return {
    settingsPatch, setContext, updateSettings, updateModelSettings, resetSettings, receiveSettings, acceptSettings,
    ready() { applyServerEvent(() => { const current = connectionSync(); if (current !== undefined) authority.begin(current); }); },
    endHydration(fallback: State["settings"]): State["settings"] {
      staging = false;
      return authority.current() ?? fallback;
    },
    releasePresentation() {
      const accepted = authority.current();
      if (staging && accepted !== undefined) applySettings(accepted, false, true);
      staging = false;
    },
    beginHydration() {
      negotiated = undefined;
      staging = true;
    },
    disconnected() { voiceWrites.clear(); negotiated = undefined; },
    seedContext() { contextSeeded = true; },
    seedThinking() {
      const startsOff = !thinkSeeded && noGpu(getState().gpu);
      thinkSeeded = true;
      if (startsOff) setState({ think: false });
    },
  };
}
