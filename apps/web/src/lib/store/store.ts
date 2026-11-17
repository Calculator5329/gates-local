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

export const NA = "na" as const;
export type Maybe<T> = T | undefined | typeof NA;

export type Conn =
  | { readonly kind: "connecting" }
  | { readonly kind: "open" }
  | { readonly kind: "down"; readonly since: number }
  | { readonly kind: "no-server" };

export type View = "thread" | "new" | "settings" | "pictures" | "firstrun";
export const overChat = (view: View): boolean => view === "settings" || view === "pictures";
export type Section = "general" | "models" | "instructions" | "library" | "tools" | "images" | "runtime" | "advanced" | "shortcuts";

export interface LiveTurn {
  readonly threadId: string;
  readonly turnId: string;
  readonly userMessageId?: string;
  readonly model: string;
  readonly startedAt: number;
  readonly reply?: TurnClock;
  readonly replyAt?: number;
  readonly thinking: string;
  readonly text: string;
  readonly tools: readonly ToolStep[];
  readonly end?: { readonly kind: "stopped"; readonly secs: number } | { readonly kind: "error"; readonly code: string; readonly message: string };
}

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

export interface StopAsk {
  readonly messageId?: string;
  readonly images?: readonly string[];
  readonly files?: readonly AttachedFile[];
  readonly blocking: readonly BlockingTurn[];
  readonly content: string;
  readonly model: string;
  readonly threadId: string | null;
  readonly keepDraft: boolean;
  readonly queuedId?: string;
  readonly regenerate?: true;
  readonly draw?: ImageChoice;
}

export type StopNote =
  | { readonly kind: "stopped"; readonly secs: number }
  | { readonly kind: "said"; readonly words: string }
  | { readonly kind: "failed"; readonly why: string; readonly code?: string };

export interface NoticeOffer {
  readonly notice: string;
  readonly model: string;
  readonly numCtx: number;
  readonly offer: FitOffer;
}

export type NoticeActKind = "stop-other" | "wait" | "retry";
export interface NoticeAct {
  readonly notice: string;
  readonly acts: readonly NoticeActKind[];
}

export interface State {
  readonly conn: Conn;
  readonly hydrationSettled: boolean;
  readonly bootWaited: boolean;
  readonly serverOrigin: string | null;
  readonly fileToken: string | null;
  readonly runtime: RuntimeStatus | undefined;
  readonly models: readonly ModelInfo[] | undefined;
  readonly threads: readonly Thread[];
  readonly messages: Readonly<Record<string, readonly Message[]>>;
  readonly turns: Readonly<Record<string, LiveTurn>>;
  readonly replies: ReadonlyMap<string, Reply>;
  readonly editingQueued: string | null;
  readonly stopAsk: StopAsk | null;

  readonly view: View;
  readonly threadId: string | null;
  readonly section: Section;
  readonly addPage: boolean;
  readonly ownerConfirm: boolean;
  readonly fitPanel: { readonly model: string | null };
  readonly pop:
    | { readonly id: "picker"; readonly kb: boolean; readonly ready?: true }
    | { readonly id: "plus" | "opts" | "images" | "count" | "unset"; readonly kb: boolean }
    | { readonly id: "thread"; readonly kb: boolean; readonly thread: string; readonly at?: { readonly x: number; readonly y: number } }
    | null;
  readonly panel: "usage" | null;
  readonly dropAt: { readonly x: number; readonly y: number } | null;
  readonly drawer: boolean;
  readonly setList: boolean;
  readonly pasting: number;
  readonly asking?: true;
  readonly voiceConnectionVersion: number;
  readonly renaming: boolean;
  readonly search: string;

  readonly model: string | undefined;
  readonly chosen: string | undefined;
  readonly threadModels: Readonly<Record<string, string>>;
  readonly numCtx: ContextSize;
  readonly think: boolean;
  readonly image: boolean;
  readonly fitTable: FitTable | undefined;
  readonly loads: Readonly<Record<string, ModelLoad>>;
  readonly loadSince: Readonly<Record<string, number>>;
  readonly loadTimes: Readonly<Record<string, number>>;
  readonly memory: MemoryState | undefined;
  readonly newChatResident: string | undefined;
  readonly newChatPicked: boolean;

  readonly settings: Maybe<Settings>;
  readonly gpu: Maybe<GpuStatus>;
  readonly catalog: Maybe<readonly CatalogEntry[]>;
  readonly suggested: Maybe<SuggestedList>;
  readonly speeds: Maybe<Readonly<Record<string, ModelSpeed>>>;
  readonly measures: Maybe<Readonly<Record<string, ModelMeasure>>>;
  readonly measuring: Readonly<Record<string, MeasureRun>>;
  readonly pulls: Readonly<Record<string, PullProgress>>;
  readonly sources: Maybe<readonly Source[]>;
  readonly sourceImports: Maybe<SourceImports>;
  readonly dataFolder: string | null | undefined;
  readonly imageStatus: Maybe<ImageStatus>;
  readonly shellStatus: Maybe<ShellStatus>;
  readonly imagePresets: Maybe<ImagePresets>;
  readonly imageDownload: ImageDownload | undefined;
  readonly imageSetup: ImageSetup | undefined;
  readonly imagePick: ImageChoice | undefined;
  readonly imageCountNew: number;
  readonly imageRuns: Readonly<Record<string, number>>;
  readonly update: Maybe<UpdateStatus>;
  // why: the server speaks another contract version than this page; only a reload mends it
  readonly outdated?: true;
  readonly updateChecking: boolean;
  readonly updateInstalling: boolean;
  readonly updateError: string | null;
  readonly unavailable: Readonly<Record<string, true>>;
  readonly notice: string | null;
  readonly noticeOffer: NoticeOffer | null;
  readonly noticeAct: NoticeAct | null;
  readonly loadErrors: Readonly<Record<string, string>>;
  readonly afterCommit: readonly CommitJob[];
}

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
  noticeAct: null,
  loadErrors: {},
  afterCommit: [],
};

let state: State = initial;
const listeners = new Set<() => void>();
export function getState(): State {
  return state;
}

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

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const listenerCount = (): number => listeners.size;

export function useStore<T>(selector: (s: State) => T): T {
  const snapshot = () => selector(getState());
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function chatReady(s: State): boolean {
  return s.conn.kind === "open" && s.runtime?.state === "ready";
}

export function runningTurn(s: State, threadId: string | null): LiveTurn | undefined {
  const turn = turnOf(s, threadId);
  return turn?.end === undefined ? turn : undefined;
}

export function turnOf(s: State, threadId: string | null): LiveTurn | undefined {
  return threadId === null ? undefined : s.turns[threadId];
}

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

export function streamingHere(s: State): boolean {
  return runningTurn(s, s.threadId) !== undefined;
}

let running: ReadonlySet<string> = new Set();

export function runningThreads(s: State): ReadonlySet<string> {
  const now = Object.values(s.turns).filter((t) => t.end === undefined).map((t) => t.threadId);
  if (now.length !== running.size || now.some((id) => !running.has(id))) running = new Set(now);
  return running;
}
