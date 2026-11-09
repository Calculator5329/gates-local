// The client's one state tree and a tiny external store over it. Components
// read slices with useStore(selector); a slice that did not change keeps its
// identity, so a token arriving re-renders the live turn and nothing else.
import { useSyncExternalStore } from "react";
import type {
  BlockingTurn,
  CatalogEntry,
  ContextSize,
  FitReport,
  GpuStatus,
  ImageStatus,
  Message,
  ModelInfo,
  ModelLoad,
  PullProgress,
  RuntimeStatus,
  Settings,
  Source,
  Thread,
  ToolStep,
  UpdateStatus,
} from "@gates-local/contracts";

/** A v2 surface the server answers "not-implemented" for: the client hides it or says so. */
export const NA = "na" as const;
export type Maybe<T> = T | undefined | typeof NA;

export type Conn =
  | { readonly kind: "connecting" }
  | { readonly kind: "open" }
  | { readonly kind: "down"; readonly since: number }
  | { readonly kind: "no-server" };

export type View = "thread" | "new" | "settings" | "firstrun";
export type Section = "general" | "models" | "instructions" | "library" | "tools" | "images" | "runtime" | "advanced" | "shortcuts";

/** The reply being written now, or the last one that stopped before it finished. */
export interface LiveTurn {
  readonly contextNotice?: string;
  /** The client's own count of turns started this session; a response or event for an older one never touches this turn. */
  readonly gen: number;
  readonly threadId: string;
  readonly turnId: string | null;
  /** The saved user message, once chat.send answered: reconnect drops this turn when the server saved its reply. */
  readonly userMessageId?: string;
  readonly model: string;
  readonly startedAt: number;
  readonly firstTokenAt?: number;
  readonly thinking: string;
  readonly thinkingSecs?: number;
  readonly text: string;
  readonly tools: readonly ToolStep[];
  /** The user's text, shown until chat.send returns the saved message. */
  readonly pendingUser: string | null;
  readonly pendingImages?: readonly string[];
  /** Set once the turn ended without a saved message. */
  readonly end?: { readonly kind: "stopped"; readonly secs: number } | { readonly kind: "error"; readonly code: string; readonly message: string };
  /** Stopped here, but the server has not ended the turn yet (no terminal event, or chat.send still unanswered); Retry waits. */
  readonly ending?: true;
}

/** A message typed during setup, the first download or a reply being written; it sends when that is over. */
export interface Queued {
  readonly messageId?: string;
  readonly images?: readonly string[];
  readonly id: string;
  readonly threadId: string;
  readonly text: string;
  readonly at: number;
  readonly waitFor: "setup" | "download" | "reply";
  /** The model it was typed for; a queue from before any model was installed has none and takes the one chosen then. */
  readonly model?: string;
  /** Its reply was stopped or failed: it waits for Send now, like a queue after an interrupt in T3 Code. */
  readonly held?: true;
  /** Send now: it goes as soon as the reply in its way has ended. */
  readonly now?: true;
}

/** A send waiting for a yes, because the load it needs would stop these chats' replies. */
export interface StopAsk {
  readonly messageId?: string;
  readonly images?: readonly string[];
  readonly blocking: readonly BlockingTurn[];
  readonly content: string;
  readonly model: string;
  /** null: it starts a new chat. */
  readonly threadId: string | null;
  /** Regenerate or Send now: what is in the composer is not this message. */
  readonly keepDraft: boolean;
  /** Send now: the queued message this is, which leaves the queue only when it goes. */
  readonly queuedId?: string;
  /** Retry or Regenerate: this answer replaces a stopped reply instead of following it. */
  readonly regenerate?: true;
}

export interface State {
  readonly draftSendId: string | null;
  readonly draftSendThreadId: string | null;
  readonly conn: Conn;
  /** The initial read attempt ended, including failure, for this connection. */
  readonly hydrationSettled: boolean;
  readonly serverOrigin: string | null;
  readonly fileToken: string | null;
  readonly runtime: RuntimeStatus | undefined;
  readonly models: readonly ModelInfo[] | undefined;
  readonly threads: readonly Thread[];
  readonly messages: Readonly<Record<string, readonly Message[]>>;
  /** First-token times measured this session, by message id, for the meta line. */
  readonly firstToken: Readonly<Record<string, number>>;
  readonly live: LiveTurn | null;
  /** Active server turn IDs by thread; token updates leave this record unchanged. */
  readonly runningTurns: Readonly<Record<string, string>>;
  readonly queued: readonly Queued[];
  /** The queued message being changed in the composer; the next Send updates it instead of sending. */
  readonly editingQueued: string | null;
  /** The warning before a send stops another chat's reply. */
  readonly stopAsk: StopAsk | null;
  /** Why a reply stopped, by the message it hangs on: the saved partial, or the question when no word came. This session only: the server saves the words, not the reason. */
  readonly stopNotes: Readonly<Record<string, string>>;

  readonly view: View;
  readonly threadId: string | null;
  readonly section: Section;
  /** Settings › Models › Download a model. */
  readonly addPage: boolean;
  readonly ownerConfirm: boolean;
  readonly fitPanel: { readonly model: string | null };
  /** The open popover. A thread menu belongs to its row and opens at its button or a right-click point. */
  readonly pop:
    | { readonly id: "picker"; readonly kb: boolean; readonly ready?: true }
    | { readonly id: "plus" | "opts"; readonly kb: boolean }
    | { readonly id: "thread"; readonly kb: boolean; readonly thread: string; readonly at?: { readonly x: number; readonly y: number } }
    | null;
  /** Below 1024 px the sidebar is a drawer over the page; this is whether it is open. */
  readonly drawer: boolean;
  /** On a phone, Settings shows its section list as its own screen instead of a section. */
  readonly setList: boolean;
  readonly draft: string;
  readonly draftImages: readonly string[];
  readonly pasting: number;
  /** Changes on replacement or clear, not ordinary typing within this draft. */
  readonly draftVersion: number;
  /** Tracks new speech actions; older local save completions do not supersede them. */
  readonly voiceConnectionVersion: number;
  /** The header title is an input (thread menu › Rename). */
  readonly renaming: boolean;
  readonly searchOpen: boolean;
  readonly search: string;

  readonly model: string | undefined;
  /** The model the user picked in this chat; `model` returns to it when the list has it again (pick.ts). */
  readonly chosen: string | undefined;
  /** The model each thread opened this session was last on; the composer's model is one value, so leaving a thread would lose it. */
  readonly threadModels: Readonly<Record<string, string>>;
  readonly numCtx: ContextSize;
  readonly think: boolean;
  readonly image: boolean;
  readonly fits: Readonly<Record<string, FitReport | "error">>;
  /** Freshness is separate so historical numbers and expanded Details can stay mounted. */
  readonly fitHistory: Readonly<Record<string, FitReport>>;
  readonly fitStatus: Readonly<Record<string, "stale" | "checking" | "fresh" | "error">>;
  /** Retained reports awaiting a check against the latest memory reading. */
  readonly staleFits: Readonly<Record<string, true>>;
  /** By fitKey: refused only because another chat's reply holds the memory, so a send may stop it. */
  readonly stopFrees: Readonly<Record<string, true>>;
  readonly loads: Readonly<Record<string, ModelLoad>>;

  readonly settings: Maybe<Settings>;
  readonly gpu: Maybe<GpuStatus>;
  readonly catalog: Maybe<readonly CatalogEntry[]>;
  readonly pulls: Readonly<Record<string, PullProgress>>;
  readonly sources: Maybe<readonly Source[]>;
  readonly imageStatus: Maybe<ImageStatus>;
  /** Settings › Updates: the version, the last check and the last update's result. Read at hydrate; no git runs for it. */
  readonly update: Maybe<UpdateStatus>;
  /** A "Check for updates" click waiting for its answer. */
  readonly updateChecking: boolean;
  readonly updateInstalling: boolean;
  readonly updateError: string | null;
  /** Action methods that answered not-implemented once (models.load, models.pull, …). */
  readonly unavailable: Readonly<Record<string, true>>;
  /** A one-line note the client shows under the composer after a refused send. */
  readonly notice: string | null;
  /** Per thread, why its newest load failed; the timeline shows it with Retry while that thread is open (WF-03). */
  readonly loadErrors: Readonly<Record<string, string>>;
}

export const fitKey = (model: string, numCtx: number) => `${model}@${numCtx}`;

const initial: State = {
  draftSendId: null,
  draftSendThreadId: null,
  conn: { kind: "connecting" },
  hydrationSettled: false,
  serverOrigin: null,
  fileToken: null,
  runtime: undefined,
  models: undefined,
  threads: [],
  messages: {},
  firstToken: {},
  live: null,
  runningTurns: {},
  queued: [],
  editingQueued: null,
  stopAsk: null,
  stopNotes: {},
  view: "new",
  threadId: null,
  section: "general",
  addPage: false,
  ownerConfirm: false,
  fitPanel: { model: null },
  pop: null,
  drawer: false,
  setList: false,
  draft: "",
  draftImages: [],
  pasting: 0,
  draftVersion: 0,
  voiceConnectionVersion: 0,
  renaming: false,
  searchOpen: false,
  search: "",
  model: undefined,
  chosen: undefined,
  threadModels: {},
  numCtx: 16384,
  think: true,
  image: false,
  fits: {},
  fitHistory: {},
  fitStatus: {},
  staleFits: {},
  stopFrees: {},
  loads: {},
  settings: undefined,
  gpu: undefined,
  catalog: undefined,
  pulls: {},
  sources: undefined,
  imageStatus: undefined,
  update: undefined,
  updateChecking: false,
  updateInstalling: false,
  updateError: null,
  unavailable: {},
  notice: null,
  loadErrors: {},
};

let state: State = initial;
const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}

/** Merge a patch (or the result of a function of the current state) and notify readers. */
export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  publish(patch, false);
}

/** Native textarea input edits the current draft. Clearing it starts a new one. */
export function editDraft(draft: string): void {
  publish({ draft, notice: null, stopAsk: null }, true);
}

const voiceUrl = (settings: State["settings"]) => settings === NA ? undefined : settings?.whisperUrl;

function publish(patch: Partial<State> | ((s: State) => Partial<State>), typing: boolean): void {
  const p = typeof patch === "function" ? patch(state) : patch;
  const next = { ...state, ...p };
  const edited = (p.draft !== undefined && p.draft !== state.draft) ||
    (p.draftImages !== undefined && p.draftImages !== state.draftImages) ||
    (p.editingQueued !== undefined && p.editingQueued !== state.editingQueued);
  const draftSendId = p.draftSendId !== undefined ? p.draftSendId : edited ? null : state.draftSendId;
  // Programmatic draft writes are replacements, including a failed send's
  // restored text. All callers pass this boundary, so no async producer has
  // to enumerate Send, Queue, Edit, Clear and navigation separately.
  const replaced = (p.draft !== undefined && (!typing || p.draft === "")) ||
    (p.editingQueued !== undefined && p.editingQueued !== state.editingQueued) ||
    (p.threadId !== undefined && p.threadId !== state.threadId) ||
    (p.view !== undefined && (p.view === "new" || p.view !== state.view));
  state = { ...next,
    draftSendId,
    draftSendThreadId: draftSendId === null ? null : p.draftSendThreadId !== undefined ? p.draftSendThreadId : state.draftSendThreadId,
    draftVersion: state.draftVersion + Number(replaced),
    voiceConnectionVersion: p.voiceConnectionVersion ?? state.voiceConnectionVersion + Number(voiceUrl(next.settings) !== voiceUrl(state.settings)),
  };
  for (const l of listeners) l();
}

/** Called after every setState; the session tests use it to see each published state. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

/** True when chat can send now: the server is connected and Ollama is ready. */
export function chatReady(s: State): boolean {
  return s.conn.kind === "open" && s.runtime?.state === "ready";
}

/** True while a reply is being written (a stopped or failed turn no longer counts). */
export function streaming(s: State): boolean {
  return s.live !== null && s.live.end === undefined;
}

/** True while a reply is being written in the chat on screen: Stop and queueing belong to that chat, not to one running behind it. */
export function streamingHere(s: State): boolean {
  return streaming(s) && s.live?.threadId === s.threadId;
}
