// Hash routing, deferred Settings and first-run navigation share one intent generation.
import { type Section, type State, chatReady, getState, setState } from "../store.ts";
import { settingsScreen } from "../screen-loaders.ts";
import { cancelQueuedDraft, renewDraft } from "../drafts.ts";

/** The open thread lives in the URL hash: #thread=<id>. */
export function threadFromHash(): string | null {
  const m = /^#thread=(.+)$/.exec(location.hash);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

// A screen over the chat (Settings, Usage) opens on one history entry of its own, at the
// same address, so Back closes it. A plain close takes the entry away again. Going to
// a thread from a screen turns the entry into that thread's.
const SCREEN_ENTRY = "gl-screen";
export const onScreenEntry = () => (history.state as { [SCREEN_ENTRY]?: boolean } | null)?.[SCREEN_ENTRY] === true;
export function enterScreen(): void {
  if (!onScreenEntry()) history.pushState({ [SCREEN_ENTRY]: true }, "");
}
export function exitScreen(): void {
  if (onScreenEntry()) history.back();
}
/** The screen this entry was made for has closed without taking it away (the drawer reuses it). */
export const spareScreenEntry = () => onScreenEntry() && getState().view !== "settings" && getState().panel === null;

/**
 * Settings has closed onto the chat kept under it: the composer takes the caret back, where
 * it was, on the terms its mount used to (chat not blocked, not touch, nothing else holding
 * the focus; the button that closed Settings does not count). A frame later, so the chat is
 * no longer inert and a pop-up opened in the same step (Usage) keeps the focus it moves.
 */
function caretBack(): void {
  requestAnimationFrame(() => {
    const s = getState();
    if (s.view === "settings" || s.panel !== null || s.drawer || !chatReady(s) || matchMedia("(hover: none)").matches) return;
    const el = document.activeElement;
    if (el === null || el === document.body || (el.tagName === "BUTTON" && el.closest('[role="dialog"]') === null)) {
      document.querySelector<HTMLTextAreaElement>("#ta")?.focus({ preventScroll: true });
    }
  });
}

function setHash(threadId: string | null): void {
  const next = threadId === null ? " " : `#thread=${encodeURIComponent(threadId)}`;
  if (location.hash !== next.trim()) history.replaceState(null, "", threadId === null ? location.pathname + location.search : next);
  // back to the chat under the screen: its entry would be a dead one
  else if (onScreenEntry()) history.back();
}

interface NavigationEffects {
  readonly flushQueued: () => void;
  readonly catchUp: (threadId: string) => void;
  readonly chooseModel: () => void;
  readonly newChatModel: (s: State) => Partial<State>;
  readonly loadThread: (threadId: string) => Promise<void>;
  readonly loading: (threadId: string) => boolean;
  /** A pop-up still waiting to open is dropped by any destination picked meanwhile. */
  readonly dropPendingPanel: () => void;
}

/** What belongs to the chat being left: its notice, its warning, and a queued message open for editing. */
function leavingChat(s: State): Partial<State> {
  if (s.editingQueued !== null) cancelQueuedDraft(s.threadId);
  return { notice: null, stopAsk: null, editingQueued: null };
}

/** Navigation keeps its own intent; chat and history operations are wired by session.ts. */
export function createNavigation({ flushQueued, catchUp, chooseModel, newChatModel, loadThread, loading, dropPendingPanel }: NavigationEffects) {
  /** Bumped by each navigation, Settings in and out included: a thread load's failure moves the view only if none happened since it was sent (WF-03). */
  let navGen = 0;
  let pendingSettings: number | null = null;

  /** Every destination invalidates an older deferred request. */
  function beginNavigation(): number {
    pendingSettings = null;
    return ++navGen;
  }

  /** Escape and destinations outside the main view can dismiss a deferred request. */
  function cancelPendingSettings(): boolean {
    if (pendingSettings !== navGen) return false;
    beginNavigation();
    return true;
  }

  /** Leaving a chat ends an edit, which frees its message. After this task: flushQueued itself opens threads, and its own send starts first. */
  function wakeAfterEdit(): void {
    if (getState().editingQueued !== null) queueMicrotask(flushQueued);
  }

  function openThread(threadId: string): void {
    beginNavigation();
    dropPendingPanel();
    wakeAfterEdit();
    if (getState().view === "settings") caretBack();
    setState((s) => {
      // Back on the model last used in this thread; a thread not yet loaded takes its saved one in loadThread.
      const model = s.threadModels[threadId] ?? s.model;
      return { view: "thread", threadId, addPage: false, ownerConfirm: false, panel: null, ...leavingChat(s), ...(model === undefined ? {} : { model }) };
    });
    catchUp(threadId);
    chooseModel();
    setHash(threadId);
    void loadThread(threadId);
  }

  function newThread(): void {
    beginNavigation();
    dropPendingPanel();
    wakeAfterEdit();
    if (getState().view === "settings") caretBack();
    // A new chat starts on the model the person used last (store.ts `chosen`), loading or not, at the
    // app-wide context; with nothing used yet it follows the pick (MP-05).
    setState((s) => ({ view: "new", threadId: null, panel: null, ...leavingChat(s), ...newChatModel(s) }));
    // Asking for a new chat while already on one changes no slot, so nothing else would tell a late paste it is stale.
    renewDraft(null);
    setHash(null);
  }

  function openSettings(section?: Section, addPage = false): void {
    const nav = beginNavigation();
    dropPendingPanel();
    const show = () => {
      if (nav !== navGen) return;
      pendingSettings = null;
      setState((s) => ({ view: "settings", section: section ?? s.section, addPage, ownerConfirm: false, panel: null }));
      enterScreen();
    };
    // The visible composer must still send into its visible thread while a chunk
    // loads. Commit the navigation only when the screen (or its error) can render.
    if (settingsScreen.get().kind === "pending") {
      pendingSettings = nav;
      void settingsScreen.load().then(show);
    } else show();
  }

  /** Close Settings and take its history entry away: the icon, Esc, Done and Back to chat. */
  function leaveSettings(): void {
    closeSettings();
    exitScreen();
  }

  /** Close Settings onto the chat kept under it; the history entry is left to the caller (Back, or a switch to Usage). */
  function closeSettings(): void {
    beginNavigation();
    const s = getState();
    if (s.view === "settings") caretBack();
    setState({ view: s.threadId !== null ? "thread" : "new" });
    // back to a thread with nothing on screen whose load failed meanwhile: try again (a loaded one returns at once)
    const id = s.threadId;
    if (id !== null && !loading(id)) void loadThread(id);
  }

  /** The footer's Settings icon: open, or close when Settings is on show. */
  function toggleSettings(): void {
    if (getState().view === "settings") leaveSettings();
    else openSettings();
  }

  /** The footer's Models icon: Settings › Models, or close when that is on show; addPage opens the download page. */
  function toggleModels(addPage = false): void {
    const s = getState();
    if (s.view === "settings" && s.section === "models") leaveSettings();
    else openSettings("models", addPage);
  }

  const FIRST_RUN_KEY = "gates-local.first-run-done";

  /** First run is a covered screen before hydration or its UI chunk can arrive. */
  function initialView(threadId: string | null): Pick<State, "view" | "threadId"> {
    return { view: threadId !== null ? "thread" : firstRunDone() ? "new" : "firstrun", threadId };
  }

  function firstRunDone(): boolean {
    try {
      return localStorage.getItem(FIRST_RUN_KEY) === "1";
    } catch {
      return false;
    }
  }

  function finishFirstRun(next: "chat" | Section = "chat"): void {
    try {
      localStorage.setItem(FIRST_RUN_KEY, "1");
    } catch {
      // private windows may refuse storage; first run shows again next launch
    }
    if (next === "chat") newThread();
    else openSettings(next);
  }

  return {
    openThread, newThread, openSettings, leaveSettings, closeSettings, toggleSettings, toggleModels, cancelPendingSettings, initialView, finishFirstRun, firstRunDone,
    get generation() { return navGen; },
    get pendingSettings() { return pendingSettings; },
  };
}
