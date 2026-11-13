// Saved settings, initial choices and speech-save ownership.
import type { CallOptions, ClientSync, ContextSize, MethodName, Params, Payload, ResultOf, Settings, SettingsPatch, ModelSettingsPatch, SyncMetadata } from "@gates-local/contracts";
import type { ServerEvent, SettingsAuthority } from "./server-state.ts";
import { noGpu } from "../format.ts";
import { NA, type State, getState, setState } from "../store.ts";

type Act = <M extends MethodName>(method: M, params: Params<M>, what: string, todo?: string, options?: CallOptions<M>) => Promise<{ readonly ok: true; readonly value: ResultOf<M> } | { readonly ok: false; readonly message: string }>;

interface SettingsEffects {
  readonly applyServerEvent: (event: ServerEvent) => void;
  readonly authority: SettingsAuthority;
  readonly sync: () => ClientSync | undefined;
  readonly act: Act;
  readonly applyTheme: (theme: Settings["theme"]) => void;
  readonly applyAccent: (accent: Settings["accent"]) => void;
  readonly refreshImageStatus: () => void;
}

export function createSettings({ applyServerEvent, authority, sync, act, applyTheme, applyAccent, refreshImageStatus }: SettingsEffects) {
  let staging = false;
  // A close may clear transport state while the accepted bootstrap batch is
  // still finishing. Keep its confirmed mode until this hydration is cleaned up.
  let negotiated: ClientSync | undefined;
  const connectionSync = () => negotiated = sync() ?? negotiated;
  const ordered = () => { const current = connectionSync(); return current?.mode === "ordered" && current.domains.includes("settings"); };

  /** Accept authority now; only initial presentation waits for the coherent ready batch. */
  function acceptSettings(settings: Settings, metadata: SyncMetadata | undefined, own = false): void {
    applyServerEvent(() => {
      if (!ordered() || metadata === undefined) return;
      authority.begin(connectionSync());
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
    imageChoice: "save the image model",
    imageTool: "save the image tool setting",
    comfyUrl: "save the ComfyUI address",
    whisperUrl: "save voice to text",
    updateEveryChange: "save the update setting",
    updateAutomatic: "save automatic update checks",
    accent: "save the accent",
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
    imageChoice: null,
    imageTool: false,
    comfyUrl: null,
    whisperUrl: null,
    updateEveryChange: false,
    updateAutomatic: true,
    accent: "neutral",
    systemPrompt: null,
    modelSettings: null,
  } as const satisfies SettingsPatch;

  // The default model is not applied here: the server's pick (pick.ts) already honours it when it can chat.
  // A changed default is the person's latest choice for new chats, so an earlier pick in a thread stops leading them.
  function settingsPatch(_s: State, settings: Settings, first: boolean): Partial<State> {
    const before = _s.settings === NA ? undefined : _s.settings;
    return {
      settings,
      ...(before !== undefined && before.defaultModel !== settings.defaultModel ? { chosen: undefined } : {}),
      ...(ordered() ? { voiceConnectionVersion: _s.voiceConnectionVersion } : {}),
      ...(first && !contextSeeded ? { numCtx: settings.defaultNumCtx } : {}),
      ...(first && !thinkSeeded ? { think: settings.thinking } : {}),
      ...(!settings.imageGen ? { image: false } : {}),
    };
  }

  function applySettings(settings: Settings, first = false, preserveVoiceIntent = false): void {
    const shown = getState().settings;
    applyServerEvent((s) => ({ ...settingsPatch(s, settings, first),
      ...(preserveVoiceIntent ? { voiceConnectionVersion: s.voiceConnectionVersion } : {}),
    }));
    applyTheme(settings.theme);
    applyAccent(settings.accent);
    // The server reads ComfyUI only when asked: image generation or its address changing, from this
    // window or any other, asks, so Settings says what it finds now and not what it had before.
    if (shown !== NA && shown !== undefined && (shown.imageGen !== settings.imageGen || shown.comfyUrl !== settings.comfyUrl)) refreshImageStatus();
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
    const received = ordered() ? undefined : settingsReceipt;
    try {
      let orderedResponse = false;
      const r = await act("settings.update", { ...patch, ...(voiceChange === undefined ? {} : { voiceChange }) }, what, undefined, {
        onResult(value, metadata) {
          orderedResponse = ordered();
          if (orderedResponse) {
            const own = voiceChange !== undefined && voiceWrites.delete(voiceChange);
            acceptSettings(value, metadata, own);
          }
        },
      });
      if (!r.ok) return r.message;
      saved = true;
      // applying the saved settings asks ComfyUI again when imageGen or comfyUrl changed (applySettings)
      if (!orderedResponse && received !== undefined && received === settingsReceipt) applySettings(r.value, false, voiceChange !== undefined);
      return null;
    } finally { if (!saved && voiceChange !== undefined) voiceWrites.delete(voiceChange); }
  }

  /** Save or reset one model; apply only the settings the server accepted. */
  async function updateModelSettings(model: string, patch: ModelSettingsPatch | null): Promise<string | null> {
    const received = ordered() ? undefined : settingsReceipt;
    let orderedResponse = false;
    const r = await act("settings.model.update", { model, patch }, "save model settings", undefined, {
      onResult(value, metadata) { orderedResponse = ordered(); if (orderedResponse) acceptSettings(value, metadata); },
    });
    if (!r.ok) return r.message;
    if (!orderedResponse && received !== undefined && received === settingsReceipt) applySettings(r.value);
    return null;
  }

  async function resetSettings(): Promise<string | null> {
    const failed = await updateSettings(RESET_SETTINGS);
    if (failed !== null) return failed;
    setContext(RESET_SETTINGS.defaultNumCtx);
    setState({ think: RESET_SETTINGS.thinking });
    return null;
  }

  function receiveSettings({ voiceChange, ...settings }: Payload<"settings.changed">, dispatch: (apply: () => void) => void, metadata?: SyncMetadata): void {
    // Apply intent ordering at receipt, before a pending health check can
    // finish. Only the settings themselves wait behind hydration snapshots.
    const own = voiceChange !== undefined && voiceWrites.delete(voiceChange);
    if (ordered()) { acceptSettings(settings, metadata, own); return; }
    settingsReceipt++; // Legacy only; revisions replace this on ordered connections.
    const changed = receivedVoiceUrl !== settings.whisperUrl;
    receivedVoiceUrl = settings.whisperUrl;
    if (!own && changed) {
      applyServerEvent((s) => ({ voiceConnectionVersion: s.voiceConnectionVersion + 1 }));
    }
    dispatch(() => {
      if (ordered()) return; // A pre-negotiation legacy frame is covered by ordered reads.
      receivedVoiceUrl = settings.whisperUrl;
      applySettings(settings, false, true);
    });
  }

  return {
    settingsPatch, setContext, updateSettings, updateModelSettings, resetSettings, receiveSettings, acceptSettings,
    ready() { applyServerEvent(() => { authority.begin(connectionSync()); }); },
    endHydration(fallback: State["settings"]): State["settings"] {
      staging = false;
      return ordered() ? authority.current() ?? fallback : fallback;
    },
    releasePresentation() {
      const accepted = authority.current();
      if (staging && ordered() && accepted !== undefined) applySettings(accepted, false, true);
      staging = false;
    },
    beginHydration() {
      negotiated = undefined;
      staging = true;
      const current = getState().settings;
      receivedVoiceUrl = current === NA ? undefined : current?.whisperUrl;
    },
    noteVoiceSnapshot(settings: State["settings"]) {
      if (ordered()) return;
      receivedVoiceUrl = settings === NA ? undefined : settings?.whisperUrl;
    },
    disconnected() { voiceWrites.clear(); receivedVoiceUrl = undefined; negotiated = undefined; },
    seedContext() { contextSeeded = true; },
    seedThinking() {
      const startsOff = !thinkSeeded && noGpu(getState().gpu);
      thinkSeeded = true;
      if (startsOff) setState({ think: false });
    },
  };
}
