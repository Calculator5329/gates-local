// Hash routing, deferred Settings and first-run navigation share one intent generation.
import { type Section, type State, getState, setState } from "../store.ts";
import { settingsScreen } from "../screen-loaders.ts";

/** The open thread lives in the URL hash: #thread=<id>. */
export function threadFromHash(): string | null {
  const m = /^#thread=(.+)$/.exec(location.hash);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

function setHash(threadId: string | null): void {
  const next = threadId === null ? " " : `#thread=${encodeURIComponent(threadId)}`;
  if (location.hash !== next.trim()) history.replaceState(null, "", threadId === null ? location.pathname + location.search : next);
}

interface NavigationEffects {
  readonly flushQueued: () => void;
  readonly catchUp: (threadId: string) => void;
  readonly chooseModel: () => void;
  readonly newChatModel: (s: State) => Partial<State>;
  readonly loadThread: (threadId: string) => Promise<void>;
  readonly loading: (threadId: string) => boolean;
}

/** What belongs to the chat being left: its notice, its warning, and a queued message open for editing. */
function leavingChat(s: State): Partial<State> {
  return { notice: null, stopAsk: null, ...(s.editingQueued === null ? {} : { editingQueued: null, draft: "", draftImages: [] }) };
}

/** Navigation keeps its own intent; chat and history operations are wired by session.ts. */
export function createNavigation({ flushQueued, catchUp, chooseModel, newChatModel, loadThread, loading }: NavigationEffects) {
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
    wakeAfterEdit();
    setState((s) => {
      // Back on the model last used in this thread; a thread not yet loaded takes its saved one in loadThread.
      const model = s.threadModels[threadId] ?? s.model;
      return { view: "thread", threadId, addPage: false, ownerConfirm: false, ...leavingChat(s), ...(model === undefined ? {} : { model }) };
    });
    catchUp(threadId);
    chooseModel();
    setHash(threadId);
    void loadThread(threadId);
  }

  function newThread(): void {
    beginNavigation();
    wakeAfterEdit();
    // A new chat is the app's choice again: it starts on the pick and follows it if the pick lands later (MP-05).
    setState((s) => ({ view: "new", threadId: null, chosen: undefined, ...leavingChat(s), ...newChatModel(s) }));
    setHash(null);
  }

  function openSettings(section?: Section, addPage = false): void {
    const nav = beginNavigation();
    const show = () => {
      if (nav !== navGen) return;
      pendingSettings = null;
      setState((s) => ({ view: "settings", section: section ?? s.section, addPage, ownerConfirm: false }));
    };
    // The visible composer must still send into its visible thread while a chunk
    // loads. Commit the navigation only when the screen (or its error) can render.
    if (settingsScreen.get().kind === "pending") {
      pendingSettings = nav;
      void settingsScreen.load().then(show);
    } else show();
  }

  function leaveSettings(): void {
    beginNavigation();
    const s = getState();
    setState({ view: s.threadId !== null ? "thread" : "new" });
    // back to a thread with nothing on screen whose load failed meanwhile: try again
    const id = s.threadId;
    if (id !== null && !loading(id)) void loadThread(id);
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
    openThread, newThread, openSettings, leaveSettings, cancelPendingSettings, initialView, finishFirstRun, firstRunDone,
    get generation() { return navGen; },
    get pendingSettings() { return pendingSettings; },
  };
}
