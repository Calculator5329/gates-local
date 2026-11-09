// Saved settings, initial choices and speech-save ownership.
import type { ContextSize, MethodName, Params, Payload, ResultOf, Settings, SettingsPatch, ModelSettingsPatch } from "@gates-local/contracts";
import { noGpu } from "../format.ts";
import { NA, type State, getState, setState } from "../store.ts";

type Act = <M extends MethodName>(method: M, params: Params<M>, what: string, todo?: string) => Promise<{ readonly ok: true; readonly value: ResultOf<M> } | { readonly ok: false; readonly message: string }>;

interface SettingsEffects {
  readonly applyServerEvent: typeof setState;
  readonly act: Act;
  readonly applyTheme: (theme: Settings["theme"]) => void;
  readonly applyTextSize: (size: Settings["textSize"]) => void;
  readonly refreshImageStatus: () => void;
}

export function createSettings({ applyServerEvent, act, applyTheme, applyTextSize, refreshImageStatus }: SettingsEffects) {
  /** Thinking is set from settings and the GPU once per page load; after that a reconnect leaves the person's choice alone. */
  let thinkSeeded = false;
  /** A context choice belongs to this page session, including reconnects. */
  let contextSeeded = false;

  // Match local saves at receipt; compare foreign speech against the received
  // stream, which can be ahead of displayed settings during hydration. Snapshots
  // reset that baseline and replay restores the newer buffered settings.
  const voiceWrites = new Set<string>();
  let receivedVoiceUrl: string | undefined;
  // Full-settings pushes are authoritative even while hydration buffers them.
  // A response to an earlier request must not replace a newer received snapshot.
  let settingsReceipt = 0;

  const SETTING_WORDS: Record<keyof SettingsPatch, string> = {
    defaultModel: "save the default model",
    defaultNumCtx: "save the default context window",
    thinking: "save the thinking setting",
    theme: "save the theme",
    runtimeMode: "save the Ollama choice",
    tools: "save the tools setting",
    imageGen: "save image generation",
    comfyUrl: "save the ComfyUI address",
    whisperUrl: "save voice to text",
    updateEveryChange: "save the update setting",
    textSize: "save the text size",
    systemPrompt: "save the system prompt",
    modelSettings: "reset model settings",
  };

  /** What a new install starts with. Who runs Ollama stays as it is: switching it stops models and can download. */
  const RESET_SETTINGS = {
    defaultModel: null,
    defaultNumCtx: 16384,
    thinking: true,
    theme: "dark",
    tools: true,
    imageGen: false,
    comfyUrl: null,
    whisperUrl: null,
    updateEveryChange: false,
    textSize: "default",
    systemPrompt: null,
    modelSettings: null,
  } as const satisfies SettingsPatch;

  // The default model is not applied here: the server's pick (pick.ts) already honours it when it can chat.
  function settingsPatch(_s: State, settings: Settings, first: boolean): Partial<State> {
    return {
      settings,
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
    applyTextSize(settings.textSize);
  }

  function setContext(numCtx: ContextSize): void {
    contextSeeded = true;
    setState({ numCtx });
  }

  /** Save settings; null on success, else the sentence to show beside the control. Nothing changes locally until the server agrees. */
  async function updateSettings(patch: SettingsPatch, options: { voiceActionStarted?: boolean } = {}): Promise<string | null> {
    const keys = Object.keys(patch) as Array<keyof SettingsPatch>;
    const what = keys.length === 1 && keys[0] !== undefined ? SETTING_WORDS[keys[0]] : "save these settings";
    const voiceChange = "whisperUrl" in patch ? crypto.randomUUID() : undefined;
    if (voiceChange !== undefined) {
      if (!options.voiceActionStarted) setState((s) => ({ voiceConnectionVersion: s.voiceConnectionVersion + 1 }));
      voiceWrites.add(voiceChange);
    }
    let saved = false;
    const received = settingsReceipt;
    try {
      const r = await act("settings.update", { ...patch, ...(voiceChange === undefined ? {} : { voiceChange }) }, what);
      if (!r.ok) return r.message;
      saved = true;
      if (received === settingsReceipt) applySettings(r.value, false, voiceChange !== undefined);
      // the server reads ComfyUI only when asked: after these two, ask, so Settings says what it found
      if ("imageGen" in patch || "comfyUrl" in patch) {
        refreshImageStatus();
      }
      return null;
    } finally { if (!saved && voiceChange !== undefined) voiceWrites.delete(voiceChange); }
  }

  /** Save or reset one model; apply only the settings the server accepted. */
  async function updateModelSettings(model: string, patch: ModelSettingsPatch | null): Promise<string | null> {
    const received = settingsReceipt;
    const r = await act("settings.model.update", { model, patch }, "save model settings");
    if (!r.ok) return r.message;
    if (received === settingsReceipt) applySettings(r.value);
    return null;
  }

  async function resetSettings(): Promise<string | null> {
    const failed = await updateSettings(RESET_SETTINGS);
    if (failed !== null) return failed;
    setContext(RESET_SETTINGS.defaultNumCtx);
    setState({ think: RESET_SETTINGS.thinking });
    return null;
  }

  function receiveSettings({ voiceChange, ...settings }: Payload<"settings.changed">, dispatch: (apply: () => void) => void): void {
    settingsReceipt++;
    // Apply intent ordering at receipt, before a pending health check can
    // finish. Only the settings themselves wait behind hydration snapshots.
    const own = voiceChange !== undefined && voiceWrites.delete(voiceChange);
    const changed = receivedVoiceUrl !== settings.whisperUrl;
    receivedVoiceUrl = settings.whisperUrl;
    if (!own && changed) {
      applyServerEvent((s) => ({ voiceConnectionVersion: s.voiceConnectionVersion + 1 }));
    }
    dispatch(() => {
      receivedVoiceUrl = settings.whisperUrl;
      applySettings(settings, false, true);
    });
  }

  return {
    settingsPatch, setContext, updateSettings, updateModelSettings, resetSettings, receiveSettings,
    beginHydration() {
      const current = getState().settings;
      receivedVoiceUrl = current === NA ? undefined : current?.whisperUrl;
    },
    noteVoiceSnapshot(settings: State["settings"]) {
      receivedVoiceUrl = settings === NA ? undefined : settings?.whisperUrl;
    },
    disconnected() { voiceWrites.clear(); receivedVoiceUrl = undefined; },
    seedContext() { contextSeeded = true; },
    seedThinking() {
      const startsOff = !thinkSeeded && noGpu(getState().gpu);
      thinkSeeded = true;
      if (startsOff) setState({ think: false });
    },
  };
}
