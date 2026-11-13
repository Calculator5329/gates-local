// Component event/effect probes, without a DOM or microphone. Native undo is
// deliberately tested in the browser journey, not simulated by this harness.
import { type ReactNode, isValidElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const settings = { whisperUrl: "http://127.0.0.1:18078" as string | undefined };
  return {
    cursor: 0, slots: [] as unknown[], refs: new Map<number, { current: unknown }>(),
    effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
    pending: [] as (() => void)[],
    state: { settings, unavailable: {}, conn: { kind: "open" }, editingQueued: null as string | null, draft: "original draft", draftVersion: 0, voiceConnectionVersion: 0, notice: null as string | null, view: "thread", panel: null as string | null },
    call: vi.fn(), update: vi.fn(), capture: vi.fn(), discard: vi.fn(), insert: vi.fn(), audioLoaded: false,
  };
});
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState(initial: unknown) {
    const at = h.cursor++;
    if (!(at in h.slots)) h.slots[at] = initial;
    return [h.slots[at], (next: unknown) => { h.slots[at] = next; }];
  },
  useRef(initial: unknown) {
    const at = h.cursor++;
    if (!h.refs.has(at)) h.refs.set(at, { current: initial });
    return h.refs.get(at);
  },
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]) {
    const at = h.cursor++, previous = h.effects.get(at);
    if (deps && previous?.deps && deps.length === previous.deps.length && deps.every((d, i) => Object.is(d, previous.deps?.[i]))) return;
    h.pending.push(() => {
      previous?.cleanup?.();
      const cleanup = effect();
      h.effects.set(at, { deps, ...(cleanup ? { cleanup } : {}) });
    });
  },
}));
vi.mock("../src/store.ts", () => ({
  NA: "na", getState: () => h.state,
  overChat: (view: string) => view === "settings" || view === "pictures",
  useStore: (select: (state: typeof h.state) => unknown) => select(h.state),
  setState: (patch: Partial<typeof h.state> | ((state: typeof h.state) => Partial<typeof h.state>)) => Object.assign(h.state, typeof patch === "function" ? patch(h.state) : patch),
}));
vi.mock("../src/drafts.ts", () => ({
  getDraft: () => ({ text: h.state.draft, images: [], sendId: null, version: h.state.draftVersion }),
  useDraft: (select: (draft: { text: string; images: readonly string[]; sendId: string | null; version: number }) => unknown) => select({ text: h.state.draft, images: [], sendId: null, version: h.state.draftVersion }),
}));
vi.mock("../src/session.ts", () => ({ call: h.call, updateSettings: h.update, openSettings: vi.fn() }));
vi.mock("../src/draft-insertion.ts", () => ({ insertAtCursor: h.insert }));
vi.mock("../src/voice-audio.ts", () => {
  h.audioLoaded = true;
  return {
    captureAudio: h.capture,
    insertTranscript: (draft: string, cursor: number, text: string) => ({ draft: draft.slice(0, cursor) + text + draft.slice(cursor), cursor: cursor + text.length }),
  };
});
import { Voice } from "../src/Voice.tsx";
import { VoiceSettings } from "../src/VoiceSettings.tsx";

function render(component: () => ReactNode) {
  h.cursor = 0;
  const tree = component();
  h.pending.splice(0).forEach((effect) => effect());
  return tree;
}
function props(node: ReactNode, label: string): { onClick(): unknown } {
  if (Array.isArray(node)) {
    for (const child of node) { try { return props(child, label); } catch { /* try the next element */ } }
  } else if (isValidElement<{ children?: ReactNode; "aria-label"?: string; onClick(): unknown }>(node)) {
    if (node.props["aria-label"] === label || node.props.children === label) return node.props;
    if (node.props.children) return props(node.props.children, label);
  }
  throw new Error(`Missing control: ${label}`);
}
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
/** The microphone with no composer behind it. */
const bare = () => render(() => Voice({ textarea: { current: null } }));
async function settle() { for (let i = 0; i < 2; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0)); }
beforeEach(() => {
  h.cursor = 0; h.slots.length = 0; h.refs.clear(); h.effects.clear(); h.pending.length = 0;
  Object.assign(h.state, { settings: { whisperUrl: "http://127.0.0.1:18078" }, conn: { kind: "open" }, editingQueued: null, draft: "original draft", draftVersion: 0, voiceConnectionVersion: 0, notice: null, view: "thread", panel: null });
  h.insert.mockReset().mockImplementation((_textarea: unknown, text: string) => { h.state.draft = text + h.state.draft; return true; });
  h.call.mockReset().mockResolvedValue({}); h.update.mockReset(); h.discard.mockReset();
  h.update.mockImplementation(async (patch: { whisperUrl: string | null }) => {
    h.state.settings = { whisperUrl: patch.whisperUrl ?? undefined }; return null;
  });
  h.capture.mockResolvedValue({ finish: () => "fake-wav", discard: h.discard });
  vi.stubGlobal("window", { isSecureContext: true, AudioContext: function () {}, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } });
  vi.stubGlobal("requestAnimationFrame", () => 0);
});

it("rendering the microphone leaves capture unloaded; the first press loads and starts it", async () => {
  expect(h.audioLoaded).toBe(false);
  const view = render(() => Voice({ textarea: { current: null } }));
  expect(h.audioLoaded).toBe(false);
  props(view, "Dictate").onClick();
  await vi.waitFor(() => expect(h.capture).toHaveBeenCalledTimes(1));
  expect(h.audioLoaded).toBe(true);
});

it("VC-01: sending or clearing a draft invalidates its pending transcript even if the edit id stays null", async () => {
  const response = held<{ text: string }>();
  h.call.mockImplementation((method: string) => method === "voice.transcribe" ? response.promise : Promise.resolve({}));
  const textarea = { current: { get value() { return h.state.draft; }, selectionStart: 0, focus() {}, setSelectionRange() {} } as unknown as HTMLTextAreaElement };
  const view = () => render(() => Voice({ textarea }));
  await props(view(), "Dictate").onClick(); await settle();
  props(view(), "Stop dictation").onClick();
  h.state.draftVersion++;
  h.state.draft = "the next message";
  // Resolve before React's next render/effect: the saved identity must still win.
  response.resolve({ text: "old speech" }); await settle();
  expect(h.state.draft).toBe("the next message");
  expect(h.insert).not.toHaveBeenCalled();
});

it("VC-02: an unusable composer retains the transcript as a plain line", async () => {
  h.insert.mockReturnValue(false);
  h.call.mockResolvedValue({ text: "words to keep" });
  const textarea = { current: { value: h.state.draft, selectionStart: 0 } as HTMLTextAreaElement };
  const view = () => render(() => Voice({ textarea }));
  await props(view(), "Dictate").onClick(); await settle();
  props(view(), "Stop dictation").onClick(); await settle();
  expect(h.state.draft).toBe("original draft");
  expect(h.state.notice).toContain("words to keep");
});

it("VC-03: a shared Disconnect in another window invalidates this window's pending Connect", async () => {
  const health = held<{ ready: boolean }>();
  h.call.mockReturnValue(health.promise);
  props(render(VoiceSettings), "Connect").onClick();
  // The shared settings push arrives, without this instance's Disconnect handler.
  h.state.settings = { whisperUrl: undefined }; h.state.voiceConnectionVersion++;
  // The shared push is authoritative even before this component renders it.
  health.resolve({ ready: true }); await settle();
  expect(h.state.settings.whisperUrl).toBeUndefined();
  expect(h.update).not.toHaveBeenCalled();
});

it("VD-01: an older Disconnect finishing does not cancel the newest Connect", async () => {
  const first = held<{ ready: boolean }>(), latest = held<{ ready: boolean }>();
  const saving = held<void>();
  h.call.mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise);
  h.update.mockImplementation(async (patch: { whisperUrl: string | null }) => {
    if (patch.whisperUrl === null) await saving.promise;
    h.state.settings = { whisperUrl: patch.whisperUrl ?? undefined };
    // The session recognizes this save's echoed provenance as its own;
    // only starting a new action changes the intent version.
    return null;
  });
  props(render(VoiceSettings), "Connect").onClick();
  props(render(VoiceSettings), "Disconnect").onClick();
  props(render(VoiceSettings), "Connect").onClick();
  expect(h.call).toHaveBeenCalledTimes(2);
  saving.resolve(); await settle();
  render(VoiceSettings); // Deliver the older save's shared push before the new health check.
  first.resolve({ ready: true }); latest.resolve({ ready: true }); await settle();
  expect(h.update).toHaveBeenNthCalledWith(2, { whisperUrl: "http://127.0.0.1:18078" }, { voiceActionStarted: true });
  expect(h.state.settings.whisperUrl).toBe("http://127.0.0.1:18078");
});
afterEach(() => {
  h.effects.forEach((effect) => effect.cleanup?.());
  vi.unstubAllGlobals();
});

it.each([[null, "queue-a"], ["queue-a", "queue-b"], ["queue-a", null]])("VO-01: late speech cannot land after queued edit changes from %s to %s", async (from, to) => {
  h.state.editingQueued = from;
  const response = held<{ text: string }>();
  h.call.mockImplementation((method: string) => method === "voice.transcribe" ? response.promise : Promise.resolve({}));
  // Only the textarea methods the pre-fix completion path used, not a DOM.
  const textarea = { current: { selectionStart: 0, focus() {}, setSelectionRange() {} } as unknown as HTMLTextAreaElement };
  const view = () => render(() => Voice({ textarea }));
  await props(view(), "Dictate").onClick();
  await settle();
  const pending = props(view(), "Stop dictation").onClick();
  expect(h.call).toHaveBeenCalledWith("voice.transcribe", expect.anything());
  h.state.editingQueued = to; h.state.draft = "different queued draft"; h.state.draftVersion++;
  view();
  response.resolve({ text: "wrong place" });
  await pending;
  await settle();
  expect(h.state.draft).toBe("different queued draft");
  expect(h.call).toHaveBeenCalledWith("voice.cancel", expect.objectContaining({ id: expect.any(String) }));
});

it("VO-03: Disconnect wins over a pending successful Connect", async () => {
  const health = held<{ ready: boolean }>();
  h.call.mockReturnValue(health.promise);
  const connecting = props(render(VoiceSettings), "Connect").onClick();
  await props(render(VoiceSettings), "Disconnect").onClick();
  health.resolve({ ready: true });
  await connecting;
  await settle();
  expect(h.state.settings.whisperUrl).toBeUndefined();
  expect(h.update).toHaveBeenCalledTimes(1);
  expect(h.update).toHaveBeenCalledWith({ whisperUrl: null }, { voiceActionStarted: true });
});

it.each([["Settings", { view: "settings" }], ["Usage", { panel: "usage" }]])("dictating, then %s opens over the chat: the dictation ends and the next Esc is not Voice's", async (_name, cover) => {
  let key: ((e: Partial<KeyboardEvent>) => void) | undefined;
  vi.stubGlobal("window", { isSecureContext: true, AudioContext: function () {}, addEventListener(type: string, fn: typeof key) { if (type === "keydown") key = fn; }, removeEventListener() {} });
  await props(bare(), "Dictate").onClick(); await settle();
  props(bare(), "Stop dictation");
  Object.assign(h.state, cover);
  bare();
  expect(h.discard).toHaveBeenCalledTimes(1);
  props(bare(), "Dictate");
  const esc = { key: "Escape", preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
  key?.(esc);
  expect(esc.stopImmediatePropagation).not.toHaveBeenCalled();
  expect(esc.preventDefault).not.toHaveBeenCalled();
});

it("the dictation shortcut leaves a chat hidden under Settings or the Usage pop-up alone", async () => {
  h.capture.mockClear();
  let key: ((e: Partial<KeyboardEvent>) => void) | undefined;
  vi.stubGlobal("window", { isSecureContext: true, AudioContext: function () {}, addEventListener(type: string, fn: typeof key) { if (type === "keydown") key = fn; }, removeEventListener() {} });
  render(() => Voice({ textarea: { current: null } }));
  const press = () => key?.({ code: "Space", ctrlKey: true, shiftKey: true, repeat: false, preventDefault() {}, stopImmediatePropagation() {} });
  h.state.view = "settings";
  press();
  h.state.view = "thread"; h.state.panel = "usage";
  press();
  await settle();
  expect(h.capture).not.toHaveBeenCalled();
  h.state.panel = null;
  press();
  await vi.waitFor(() => expect(h.capture).toHaveBeenCalledTimes(1));
});
