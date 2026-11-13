// The client's one state tree and a tiny external store over it. Components
// read slices with useStore(selector); a slice that did not change keeps its
// identity, so a token arriving re-renders the live turn and nothing else.
import { useSyncExternalStore } from "react";
import { dropDraft } from "./drafts.ts";
import type { WorkClock } from "./session/turn.ts";
import type {
  BlockingTurn,
  CatalogEntry,
  ContextSize,
  FitTable,
  GpuStatus,
  ImageChoice,
  ImageDownload,
  ImagePresets,
  ImageStatus,
  Message,
  ModelInfo,
  ModelLoad,
  ModelSpeed,
  PullProgress,
  RuntimeStatus,
  Settings,
  ShellStatus,
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

/** A chat's reply being written now, or its last one that stopped before it finished. */
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
  /** How long it thought, kept as its events arrive; absent when this client did not see it start. */
  readonly clock?: WorkClock;
  readonly text: string;
  readonly tools: readonly ToolStep[];
  /** The user's text, shown until chat.send returns the saved message. */
  readonly pendingUser: string | null;
  readonly pendingImages?: readonly string[];
  /** Set once the turn ended without a saved message. */
  readonly end?: { readonly kind: "stopped"; readonly secs: number } | { readonly kind: "error"; readonly code: string; readonly message: string };
  /** Stopped here, but the server has not ended the turn yet (no terminal event, or chat.send still unanswered); Retry waits. */
  readonly ending?: true;
  /** A turn the server started in this chat while chat.send had not answered, and whether it has ended; whose it is is known at the answer. */
  readonly early?: { readonly turnId: string; readonly ended: boolean };
  /**
   * Known only from turns.active, with no event of its own yet: it shows as
   * running in the sidebar and nothing more. The server lists a turn before it
   * saves the question and may drop it with no event, so nothing waits for it.
   */
  readonly listed?: true;
  /** An Image turn: the words went to the image model and the reply is its picture card; nothing of a chat reply shows. */
  readonly image?: true;
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
  /** Held behind a failed reply the app is retrying once on its own ("running"), or whose retry failed too ("failed"). */
  readonly retry?: "running" | "failed";
  /** Send now: it goes as soon as the reply in its way has ended. */
  readonly now?: true;
  /** Typed with Image on: it goes to this image model and size, not to a chat model. */
  readonly draw?: ImageChoice;
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
  /** An Image send: the words go to this image model and size. */
  readonly draw?: ImageChoice;
}

/** Why a reply stopped: the person pressed Stop this many seconds in (a mark, no words), or a reason they did not cause, in its own words. */
export type StopNote = { readonly kind: "stopped"; readonly secs: number } | { readonly kind: "said"; readonly words: string };

export interface State {
  readonly conn: Conn;
  /** The initial read attempt ended, including failure, for this connection. */
  readonly hydrationSettled: boolean;
  /** Two seconds passed since the app opened without a first read: booting ends and the connection words show. */
  readonly bootWaited: boolean;
  readonly serverOrigin: string | null;
  readonly fileToken: string | null;
  readonly runtime: RuntimeStatus | undefined;
  readonly models: readonly ModelInfo[] | undefined;
  readonly threads: readonly Thread[];
  readonly messages: Readonly<Record<string, readonly Message[]>>;
  /** First-token times measured this session, by message id, for the meta line. */
  readonly firstToken: Readonly<Record<string, number>>;
  /** A finished reply's thinking clock, kept this session the way `firstToken` is, by message id. */
  readonly clocks: Readonly<Record<string, WorkClock>>;
  /** Each chat's reply, by thread id: being written, or ended here and still shown. The open chat shows `turns[threadId]`. */
  readonly turns: Readonly<Record<string, LiveTurn>>;
  readonly queued: readonly Queued[];
  /** The queued message being changed in the composer; the next Send updates it instead of sending. */
  readonly editingQueued: string | null;
  /** The warning before a send stops another chat's reply. */
  readonly stopAsk: StopAsk | null;
  /** Why a reply stopped, by the message it hangs on: the saved partial, or the question when no word came. This session only: the server saves the words, not the reason. */
  readonly stopNotes: Readonly<Record<string, StopNote>>;

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
    | { readonly id: "plus" | "opts" | "images"; readonly kb: boolean }
    | { readonly id: "thread"; readonly kb: boolean; readonly thread: string; readonly at?: { readonly x: number; readonly y: number } }
    | null;
  /** The pop-up over the chat area (the footer's Usage); the chat stays mounted under it. */
  readonly panel: "usage" | null;
  /** Below 1024 px the sidebar is a drawer over the page; this is whether it is open. */
  readonly drawer: boolean;
  /** On a phone, Settings shows its section list as its own screen instead of a section. */
  readonly setList: boolean;
  readonly pasting: number;
  /** Tracks new speech actions; older local save completions do not supersede them. */
  readonly voiceConnectionVersion: number;
  /** The header title is an input (thread menu › Rename). */
  readonly renaming: boolean;
  readonly search: string;

  readonly model: string | undefined;
  /**
   * The model the person used last, for the whole app (not per thread): the last one picked, or that a
   * turn started on (send, Retry, Regenerate; not a send cancelled at the warning), in any chat, loaded or still loading. A new chat starts on it (with the one app-wide
   * `numCtx`), and `model` returns to it when the list has it again (pick.ts). A new saved default clears it.
   */
  readonly chosen: string | undefined;
  /** The model each thread opened this session was last on; the composer's model is one value, so leaving a thread would lose it. */
  readonly threadModels: Readonly<Record<string, string>>;
  readonly numCtx: ContextSize;
  readonly think: boolean;
  readonly image: boolean;
  /** The server's last fit table (fit-table.ts): every fit value on screen is read from it; undefined before the first. */
  readonly fitTable: FitTable | undefined;
  readonly loads: Readonly<Record<string, ModelLoad>>;

  readonly settings: Maybe<Settings>;
  readonly gpu: Maybe<GpuStatus>;
  readonly catalog: Maybe<readonly CatalogEntry[]>;
  /** Measured decode speed by model name without ":latest"; a model with no entry shows no number (model-speed.tsx). */
  readonly speeds: Maybe<Readonly<Record<string, ModelSpeed>>>;
  readonly pulls: Readonly<Record<string, PullProgress>>;
  readonly sources: Maybe<readonly Source[]>;
  readonly imageStatus: Maybe<ImageStatus>;
  /** The shell sandbox's probe (tools.shell), read when Settings › Tools opens. */
  readonly shellStatus: Maybe<ShellStatus>;
  /** The image models ComfyUI has every file for, and what an Image send runs now. */
  readonly imagePresets: Maybe<ImagePresets>;
  /** A setup's download: the last image.download push, kept after it ends so its row can say how. */
  readonly imageDownload: ImageDownload | undefined;
  /** A new thread's pick where Settings cannot be written (the phone): its first send carries it, the computer's Settings keep theirs. */
  readonly imagePick: ImageChoice | undefined;
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

const initial: State = {
  conn: { kind: "connecting" },
  hydrationSettled: false,
  bootWaited: false,
  serverOrigin: null,
  fileToken: null,
  runtime: undefined,
  models: undefined,
  threads: [],
  messages: {},
  firstToken: {},
  clocks: {},
  turns: {},
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
  panel: null,
  drawer: false,
  setList: false,
  pasting: 0,
  voiceConnectionVersion: 0,
  renaming: false,
  search: "",
  model: undefined,
  chosen: undefined,
  threadModels: {},
  numCtx: 16384,
  think: true,
  image: false,
  fitTable: undefined,
  loads: {},
  settings: undefined,
  gpu: undefined,
  catalog: undefined,
  speeds: undefined,
  pulls: {},
  sources: undefined,
  imageStatus: undefined,
  shellStatus: undefined,
  imagePresets: undefined,
  imageDownload: undefined,
  imagePick: undefined,
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
  const p = typeof patch === "function" ? patch(state) : patch;
  if (p.threads !== undefined) for (const thread of state.threads) if (!p.threads.some(t => t.id === thread.id)) dropDraft(thread.id);
  publish(p);
}

const voiceUrl = (settings: State["settings"]) => settings === NA ? undefined : settings?.whisperUrl;

function publish(p: Partial<State>): void {
  const next = { ...state, ...p };
  state = { ...next,
    voiceConnectionVersion: p.voiceConnectionVersion ?? state.voiceConnectionVersion + Number(voiceUrl(next.settings) !== voiceUrl(state.settings)),
  };
  for (const l of listeners) l();
}

/** Called after every setState; the session tests use it to see each published state. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test only: how many readers are subscribed now (apps/web/test/long-thread.test.ts counts them). */
export const listenerCount = (): number => listeners.size;

export function useStore<T>(selector: (s: State) => T): T {
  const snapshot = () => selector(getState());
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** True when chat can send now: the server is connected and Ollama is ready. */
export function chatReady(s: State): boolean {
  return s.conn.kind === "open" && s.runtime?.state === "ready";
}

/** The reply being written in this chat, if one is (a stopped or failed turn no longer counts). */
export function runningTurn(s: State, threadId: string | null): LiveTurn | undefined {
  const turn = turnOf(s, threadId);
  return turn?.end === undefined ? turn : undefined;
}

/** This chat's turn as its screen, Stop and Retry see it: one known only from turns.active is not there yet. */
export function turnOf(s: State, threadId: string | null): LiveTurn | undefined {
  const turn = threadId === null ? undefined : s.turns[threadId];
  return turn?.listed === true ? undefined : turn;
}

/** True while a reply is being written in the chat on screen: Stop and queueing belong to that chat, not to one running behind it. */
export function streamingHere(s: State): boolean {
  return runningTurn(s, s.threadId) !== undefined;
}

let running: ReadonlySet<string> = new Set();

/**
 * The chats where a reply is being written: the sidebar's dot. A send still
 * waiting for its id counts by what the server has said about a turn in its
 * chat meanwhile, since a Stop pressed then cannot reach that turn yet.
 * Same set object until that list changes, so a word arriving re-renders no reader of it.
 */
export function runningThreads(s: State): ReadonlySet<string> {
  const now = Object.values(s.turns).filter((t) => (t.early === undefined ? t.end === undefined : !t.early.ended)).map((t) => t.threadId);
  if (now.length !== running.size || now.some((id) => !running.has(id))) running = new Set(now);
  return running;
}
