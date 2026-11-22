import { type Section, type State, chatReady, getState, overChat, setState } from "../lib/store/store.ts";
import { picturesScreen, settingsScreen } from "./screen-loaders.ts";
import { cancelQueuedDraft, renewDraft } from "../lib/store/drafts.ts";
import { afterCommit } from "../lib/ui/kit/focus.ts";

export function threadFromHash(): string | null {
  const m = /^#thread=(.+)$/.exec(location.hash);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

const SCREEN_ENTRY = "gl-screen";
export const onScreenEntry = () => (history.state as { [SCREEN_ENTRY]?: boolean } | null)?.[SCREEN_ENTRY] === true;
export function enterScreen(): void {
  if (!onScreenEntry()) history.pushState({ [SCREEN_ENTRY]: true }, "");
}
export function exitScreen(): void {
  if (onScreenEntry()) history.back();
}
export const spareScreenEntry = () => onScreenEntry() && !overChat(getState().view) && getState().panel === null;

function caretBack(): void {
  afterCommit(() => {
    const s = getState();
    if (overChat(s.view) || s.panel !== null || s.drawer || !chatReady(s) || matchMedia("(hover: none)").matches) return;
    const el = document.activeElement;
    if (el === null || el === document.body || (el.tagName === "BUTTON" && el.closest('[role="dialog"]') === null)) {
      const ta = document.querySelector<HTMLTextAreaElement>("#ta");
      if (ta === null) return false;
      ta.focus({ preventScroll: true });
    }
  });
}

function setHash(threadId: string | null): void {
  const next = threadId === null ? " " : `#thread=${encodeURIComponent(threadId)}`;
  if (location.hash !== next.trim()) history.replaceState(null, "", threadId === null ? location.pathname + location.search : next);
  else if (onScreenEntry()) history.back();
}

interface NavigationEffects {
  readonly editEnded: (id: string) => void;
  readonly catchUp: (threadId: string) => void;
  readonly chooseModel: () => void;
  readonly newChatModel: (s: State) => Partial<State>;
  readonly loadThread: (threadId: string) => Promise<void>;
  readonly loading: (threadId: string) => boolean;
  readonly settingsData?: () => Promise<void> | null;
  readonly dropPendingPanel: () => void;
  readonly picturesData?: () => Promise<void>;
  readonly sectionShown?: (section: Section) => void;
}

function leavingChat(s: State): Partial<State> {
  if (s.editingQueued !== null) cancelQueuedDraft(s.threadId);
  return { notice: null, stopAsk: null, editingQueued: null };
}

export function createNavigation({ editEnded, catchUp, chooseModel, newChatModel, loadThread, loading, settingsData = () => null, dropPendingPanel, picturesData = () => Promise.resolve(), sectionShown = () => {} }: NavigationEffects) {
  let navGen = 0;
  // why: pending only while still the current navigation, so a new navigation needs no clear
  let opening: number | null = null;

  const beginNavigation = (): number => ++navGen;

  // why: the stale-navigation check and the end of pending are one call, so neither is left out
  function arrive(nav: number): boolean {
    if (nav !== navGen) return false;
    opening = null;
    return true;
  }

  function cancelPendingSettings(): boolean {
    if (opening !== navGen) return false;
    beginNavigation();
    return true;
  }

  function wakeAfterEdit(): void {
    const id = getState().editingQueued;
    if (id !== null) editEnded(id);
  }

  function openThread(threadId: string): void {
    beginNavigation();
    dropPendingPanel();
    wakeAfterEdit();
    if (overChat(getState().view)) caretBack();
    setState((s) => {
      const model = s.threadModels[threadId] ?? s.model;
      return { view: "thread", threadId, addPage: false, ownerConfirm: false, panel: null, measureShown: null, ...leavingChat(s), ...(model === undefined ? {} : { model }) };
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
    if (overChat(getState().view)) caretBack();
    setState((s) => ({ view: "new", threadId: null, panel: null, measureShown: null, ...leavingChat(s), ...newChatModel(s) }));
    renewDraft(null);
    setHash(null);
  }

  function openSettings(section?: Section, addPage = false, ownerConfirm = false): void {
    const nav = beginNavigation();
    dropPendingPanel();
    const show = () => {
      if (!arrive(nav)) return;
      setState((s) => ({ view: "settings", section: section ?? (s.section === "models" ? "general" : s.section), addPage, ownerConfirm, panel: null }));
      enterScreen();
      sectionShown(getState().section);
    };
    const data = settingsData();
    if (settingsScreen.get().kind === "pending" || data !== null) {
      opening = nav;
      void Promise.all([settingsScreen.load(), data]).then(show);
    } else show();
  }

  function leaveSettings(): void {
    closeSettings();
    exitScreen();
  }

  function closeSettings(): void {
    beginNavigation();
    const s = getState();
    if (overChat(s.view)) caretBack();
    setState({ view: s.threadId !== null ? "thread" : "new" });
    const id = s.threadId;
    if (id !== null && !loading(id)) void loadThread(id);
  }

  function toggleSettings(): void {
    if (getState().view === "settings") leaveSettings();
    else openSettings();
  }

  function openPictures(): void {
    const nav = beginNavigation();
    dropPendingPanel();
    opening = nav;
    void Promise.all([picturesScreen.load(), picturesData()]).then(() => {
      if (!arrive(nav)) return;
      setState({ view: "pictures", ownerConfirm: false, panel: null });
      enterScreen();
    });
  }

  function leavePictures(): void {
    closeSettings();
    exitScreen();
  }

  function togglePictures(): void {
    if (getState().view === "pictures") leavePictures();
    else openPictures();
  }

  function toggleModels(addPage = false): void {
    const s = getState();
    if (s.view === "settings" && s.section === "models") leaveSettings();
    else openSettings("models", addPage);
  }

  const FIRST_RUN_KEY = "gates-local.first-run-done";

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
      // external: a browser's private window may refuse storage
    }
    if (next === "chat") newThread();
    else openSettings(next);
  }

  return {
    openThread, newThread, openSettings, leaveSettings, closeSettings, toggleSettings, toggleModels, cancelPendingSettings, initialView, finishFirstRun, firstRunDone,
    openPictures, leavePictures, togglePictures,
    get generation() { return navGen; },
    get pendingSettings() { return opening === navGen ? opening : null; },
  };
}
