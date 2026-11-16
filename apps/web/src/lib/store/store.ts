// The client's one state tree and a tiny external store over it. Components
// read slices with useStore(selector); a slice that did not change keeps its
// identity, so a token arriving re-renders the live turn and nothing else.
import { useSyncExternalStore } from "react";
import { readLoadTimes } from "./load-times.ts";
import type {
  Reply,
  BlockingTurn,
  CatalogEntry,
  ContextSize,
  FitOffer,
  MemoryState,
  FitTable,
  GpuStatus,
  ImageChoice,
  ImageDownload,
  ImageSetup,
  ImagePresets,
  ImageStatus,
  Message,
  ModelInfo,
  ModelLoad,
  ModelSpeed,
  ModelMeasure,
  MeasureRun,
  PullProgress,
  RuntimeStatus,
  Settings,
  ShellStatus,
  Source,
  SourceImports,
  SuggestedList,
  Thread,
  ToolStep,
  TurnEnded,
  UpdateStatus,
  AttachedFile,
} from "@gates-local/contracts";

/** A v2 surface the server answers "not-implemented" for: the client hides it or says so. */
export const NA = "na" as const;
export type Maybe<T> = T | undefined | typeof NA;

export type Conn =
  | { readonly kind: "connecting" }
  | { readonly kind: "open" }
  | { readonly kind: "down"; readonly since: number }
  | { readonly kind: "no-server" };

export type View = "thread" | "new" | "settings" | "pictures" | "firstrun";
/** A screen that lies over the chat, which stays mounted under it. */
export const overChat = (view: View): boolean => view === "settings" || view === "pictures";
export type Section = "general" | "models" | "instructions" | "library" | "tools" | "images" | "runtime" | "advanced" | "shortcuts";

/** A chat's reply being written now, or its last one that stopped before it finished. */
export interface LiveTurn {
  readonly threadId: string;
  readonly turnId: string;
  /** The saved user message, once the record says it is saved; until then the question shown is the record's own words (`unsavedQuestion`). */
  readonly userMessageId?: string;
  readonly model: string;
  readonly startedAt: number;
  /**
   * The times of the reply's record as the server last sent it: the live line's stage and seconds
   * come from them and nothing else, a Stop included (stage "stopping", `stoppedAt`). They stay
   * with a reply that ended here, for its stopped line. Absent until the record's first change.
   */
  readonly reply?: TurnClock;
  /** This client's time when `reply` arrived: its work grows from then while it thinks or runs a call. */
  readonly replyAt?: number;
  readonly thinking: string;
  readonly text: string;
  readonly tools: readonly ToolStep[];
  /** Set once the turn ended without a saved message, or the server's record says a Stop was taken (`secs` from that record). */
  readonly end?: { readonly kind: "stopped"; readonly secs: number } | { readonly kind: "error"; readonly code: string; readonly message: string };
}

/**
 * A running reply's stage and times, from its reply.changed record. A picture's turn is "drawing"
 * from its start to its end. `workMs` is as of the record and grows here only while the stage is
 * thinking or tool.
 */
export interface TurnClock {
  readonly stage: "waiting" | "loading" | "thinking" | "tool" | "writing" | "stopping" | "ended" | "drawing";
  readonly startedAt: number;
  readonly readyAt?: number;
  readonly firstTokenAt?: number;
  readonly workMs: number;
  readonly toolMs: number;
  readonly attempt: number;
  readonly spans: readonly { readonly from: number; readonly ms: number }[];
  readonly callsAt: Readonly<Record<string, number>>;
  readonly stoppedAt?: number;
  readonly ended?: TurnEnded;
}

export type WaitingReply = Extract<Reply, { readonly stage: "queued" | "held" | "next" | "editing" }>;

/** A send waiting for a yes, because the load it needs would stop these chats' replies. */
export interface StopAsk {
  readonly messageId?: string;
  readonly images?: readonly string[];
  readonly files?: readonly AttachedFile[];
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

/**
 * Why a reply stopped: the person pressed Stop this many seconds in (a mark, no words), a reason
 * they did not cause in its own words, or a failure: the alert, "The reply didn't
 * finish." and Retry, with the runtime's own text in the tip.
 */
export type StopNote =
  | { readonly kind: "stopped"; readonly secs: number }
  | { readonly kind: "said"; readonly words: string }
  | { readonly kind: "failed"; readonly why: string };

/** A refusal for memory and what runs instead: `notice` the note's words it belongs to, `model` and `numCtx` what was refused. */
export interface NoticeOffer {
  readonly notice: string;
  readonly model: string;
  readonly numCtx: number;
  readonly offer: FitOffer;
}

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
  /** Each chat's reply, by thread id: being written, or ended here and still shown. The open chat shows `turns[threadId]`. */
  readonly turns: Readonly<Record<string, LiveTurn>>;
  /**
   * Every message waiting and every reply on its way, by its id, each as the server last sent it
   * (reply.changed, reply.list). Nothing else writes it: the queue's rows are the waiting records
   * (`waitingReplies`), in the order the server first named them.
   */
  readonly replies: ReadonlyMap<string, Reply>;
  /** The queued message being changed in the composer; the next Send updates it instead of sending. */
  readonly editingQueued: string | null;
  /** The warning before a send stops another chat's reply. */
  readonly stopAsk: StopAsk | null;

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
    | { readonly id: "plus" | "opts" | "images" | "count" | "unset"; readonly kb: boolean }
    | { readonly id: "thread"; readonly kb: boolean; readonly thread: string; readonly at?: { readonly x: number; readonly y: number } }
    | null;
  /** The pop-up over the chat area (the footer's Usage); the chat stays mounted under it. */
  readonly panel: "usage" | null;
  /** Where the "Drop files to attach" marker sits while files are dragged over a usable composer (composer/file-drop.tsx); null otherwise. */
  readonly dropAt: { readonly x: number; readonly y: number } | null;
  /** Below 1024 px the sidebar is a drawer over the page; this is whether it is open. */
  readonly drawer: boolean;
  /** On a phone, Settings shows its section list as its own screen instead of a section. */
  readonly setList: boolean;
  readonly pasting: number;
  /** A send is asking the server what it would stop (turns.blocking): Send turns its ring, so a second Enter is not met by nothing. */
  readonly asking?: true;
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
  /** When this client saw each running load start (its "loading" notice), by model. */
  readonly loadSince: Readonly<Record<string, number>>;
  /** Each model's last load on this machine, in milliseconds (load-times.ts). */
  readonly loadTimes: Readonly<Record<string, number>>;
  /** What is in memory (the server's gpu/memory.ts, by memory.status and memory.changed); undefined before the first read. */
  readonly memory: MemoryState | undefined;
  /**
   * The chat model in memory a new chat starts on, as memory named it: taken when the chat opens, and when a
   * load ends while its box is empty and the list is closed; never while the person types (session/models.ts).
   */
  readonly newChatResident: string | undefined;
  /** The person picked a model in this new chat: what is in memory no longer moves its button. */
  readonly newChatPicked: boolean;

  readonly settings: Maybe<Settings>;
  readonly gpu: Maybe<GpuStatus>;
  readonly catalog: Maybe<readonly CatalogEntry[]>;
  /** The chat list in use (models.suggested): maker groups and example names. */
  readonly suggested: Maybe<SuggestedList>;
  /** Measured decode speed by model name without ":latest"; a model with no entry shows no number (model-speed.tsx). */
  readonly speeds: Maybe<Readonly<Record<string, ModelSpeed>>>;
  /** Models measured on this computer, by name (Settings › Models, Measure; session/measures.ts). */
  readonly measures: Maybe<Readonly<Record<string, ModelMeasure>>>;
  /** Measure runs going now, and ones that failed, by model name. */
  readonly measuring: Readonly<Record<string, MeasureRun>>;
  readonly pulls: Readonly<Record<string, PullProgress>>;
  readonly sources: Maybe<readonly Source[]>;
  /** The sample databases and the Library's imports, kept current by sources.imports pushes. */
  readonly sourceImports: Maybe<SourceImports>;
  /** The desktop app's data folder, fixed for the window's life and read from its bridge once; null outside it. */
  readonly dataFolder: string | null | undefined;
  readonly imageStatus: Maybe<ImageStatus>;
  /** The shell sandbox's probe (tools.shell), read when Settings › Tools opens. */
  readonly shellStatus: Maybe<ShellStatus>;
  /** The image models ComfyUI has every file for, and what an Image send runs now. */
  readonly imagePresets: Maybe<ImagePresets>;
  /** A setup's download: the last image.download push, kept after it ends so its row can say how. */
  readonly imageDownload: ImageDownload | undefined;
  /** Set up images: what it would fetch here or why it cannot run, with the last image.setup push as its progress. */
  readonly imageSetup: ImageSetup | undefined;
  /** A new thread's pick where Settings cannot be written (the phone): its first send carries it, the computer's Settings keep theirs. */
  readonly imagePick: ImageChoice | undefined;
  /** A new thread's picture count (the count menu before its first send), which that send carries; then back to 1. */
  readonly imageCountNew: number;
  /**
   * ComfyUI's time for this computer's newest picture of a setup and size, under runKey (image-choice.ts):
   * from the numbered image.event done pushes, and for a setup no push has named yet, one pictures.list read.
   */
  readonly imageRuns: Readonly<Record<string, number>>;
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
  /** A memory refusal's offer (WIN-MEM-02): shown in the note while `notice` is still its words. */
  readonly noticeOffer: NoticeOffer | null;
  /** Per thread, why its newest load failed; the timeline shows it with Retry while that thread is open (WF-03). */
  readonly loadErrors: Readonly<Record<string, string>>;
  /** Work waiting for the next commit, such as a focus move to a node that commit draws (lib/ui/kit/focus.ts runs it). */
  readonly afterCommit: readonly CommitJob[];
}

/** One piece of after-commit work; false means its node is not drawn yet, so it runs once more a frame later. */
export type CommitJob = () => boolean | void;

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
  turns: {},
  replies: new Map(),
  editingQueued: null,
  stopAsk: null,
  view: "new",
  threadId: null,
  section: "general",
  addPage: false,
  ownerConfirm: false,
  fitPanel: { model: null },
  pop: null,
  panel: null,
  dropAt: null,
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
  loadSince: {},
  loadTimes: readLoadTimes(),
  memory: undefined,
  newChatResident: undefined,
  newChatPicked: false,
  settings: undefined,
  gpu: undefined,
  catalog: undefined,
  suggested: undefined,
  speeds: undefined,
  measures: undefined,
  measuring: {},
  pulls: {},
  sources: undefined,
  sourceImports: undefined,
  dataFolder: undefined,
  imageStatus: undefined,
  shellStatus: undefined,
  imagePresets: undefined,
  imageDownload: undefined,
  imageSetup: undefined,
  imagePick: undefined,
  imageCountNew: 1,
  imageRuns: {},
  update: undefined,
  updateChecking: false,
  updateInstalling: false,
  updateError: null,
  unavailable: {},
  notice: null,
  noticeOffer: null,
  loadErrors: {},
  afterCommit: [],
};

let state: State = initial;
const listeners = new Set<() => void>();
export function getState(): State {
  return state;
}

/** Merge a patch (or the result of a function of the current state) and notify readers. */
export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const p = typeof patch === "function" ? patch(state) : patch;
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

/** Test only: how many readers are subscribed now (apps/web/src/thread/long-thread.test.ts counts them). */
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

export function turnOf(s: State, threadId: string | null): LiveTurn | undefined {
  return threadId === null ? undefined : s.turns[threadId];
}

/**
 * The question of a reply on its way, before it is saved: the words of the turn's own record, in
 * every window alike. None once the saved row has taken its place, and none for a Retry, whose
 * question is in the chat already. The same record object until the server changes it.
 */
export function unsavedQuestion(s: State, turn: LiveTurn | undefined): Extract<Reply, { readonly stage: "starting" }> | undefined {
  const r = turn === undefined ? undefined : s.replies.get(turn.turnId);
  return r?.stage === "starting" && r.retryOf === undefined ? r : undefined;
}

const WAITING: ReadonlySet<Reply["stage"]> = new Set(["queued", "held", "next", "editing"]);
export const isWaiting = (r: Reply): r is WaitingReply => WAITING.has(r.stage);

let waitingFrom: State["replies"] | undefined;
let waitingRows: readonly WaitingReply[] = [];

// why: one going next shows first, as it goes first; the rest keep the server's order
export function waitingReplies(s: State): readonly WaitingReply[] {
  if (waitingFrom === s.replies) return waitingRows;
  const rows = [...s.replies.values()].filter(isWaiting);
  waitingFrom = s.replies;
  waitingRows = [...rows.filter((r) => r.stage === "next"), ...rows.filter((r) => r.stage !== "next")];
  return waitingRows;
}

export const onHold = (r: WaitingReply): boolean => r.stage === "held" || (r.stage === "editing" && r.back.stage === "held");

// why: behind setup or the first download the whole app waits, so there is no Send now
export const behindSetup = (r: WaitingReply): boolean => r.stage === "queued" && (r.waitFor?.what === "setup" || r.waitFor?.what === "download");

/** True while a reply is being written in the chat on screen: Stop and queueing belong to that chat, not to one running behind it. */
export function streamingHere(s: State): boolean {
  return runningTurn(s, s.threadId) !== undefined;
}

let running: ReadonlySet<string> = new Set();

/**
 * The chats where a reply is being written, or waiting to start: the sidebar's dot.
 * Same set object until that list changes, so a word arriving re-renders no reader of it.
 */
export function runningThreads(s: State): ReadonlySet<string> {
  const now = Object.values(s.turns).filter((t) => t.end === undefined).map((t) => t.threadId);
  if (now.length !== running.size || now.some((id) => !running.has(id))) running = new Set(now);
  return running;
}
