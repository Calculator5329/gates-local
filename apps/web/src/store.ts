// The client's one state tree and a tiny external store over it. Components
// read slices with useStore(selector); a slice that did not change keeps its
// identity, so a token arriving re-renders the live turn and nothing else.
import { useSyncExternalStore } from "react";
import type {
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
export type Section = "general" | "models" | "runtime" | "memory" | "images" | "library";

/** The reply being written now, or the last one that stopped before it finished. */
export interface LiveTurn {
  readonly threadId: string;
  readonly turnId: string | null;
  readonly model: string;
  readonly startedAt: number;
  readonly firstTokenAt?: number;
  readonly thinking: string;
  readonly thinkingSecs?: number;
  readonly text: string;
  readonly tools: readonly ToolStep[];
  /** The user's text, shown until chat.send returns the saved message. */
  readonly pendingUser: string | null;
  /** Set once the turn ended without a saved message. */
  readonly end?: { readonly kind: "stopped"; readonly secs: number } | { readonly kind: "error"; readonly code: string; readonly message: string };
}

/** A message typed during setup or the first download; it sends once chat is ready. */
export interface Queued {
  readonly id: string;
  readonly threadId: string;
  readonly text: string;
  readonly at: number;
  readonly waitFor: "setup" | "download";
}

export interface State {
  readonly conn: Conn;
  readonly serverOrigin: string | null;
  readonly fileToken: string | null;
  readonly runtime: RuntimeStatus | undefined;
  readonly models: readonly ModelInfo[] | undefined;
  readonly threads: readonly Thread[];
  readonly messages: Readonly<Record<string, readonly Message[]>>;
  /** First-token times measured this session, by message id, for the meta line. */
  readonly firstToken: Readonly<Record<string, number>>;
  readonly live: LiveTurn | null;
  readonly queued: readonly Queued[];

  readonly view: View;
  readonly threadId: string | null;
  readonly section: Section;
  /** Settings › Models › Download a model. */
  readonly addPage: boolean;
  readonly ownerConfirm: boolean;
  readonly fitPanel: { readonly open: boolean; readonly model: string | null };
  /** The open popover; kb is the picker opened from the keyboard (Ctrl M), which shows digit keys. */
  readonly pop: { readonly id: "picker" | "plus" | "more"; readonly kb: boolean } | null;
  readonly draft: string;
  /** The header title is an input (thread menu › Rename). */
  readonly renaming: boolean;
  readonly searchOpen: boolean;
  readonly search: string;

  readonly model: string | undefined;
  readonly numCtx: ContextSize;
  readonly think: boolean;
  readonly image: boolean;
  readonly fits: Readonly<Record<string, FitReport | "error">>;
  readonly loads: Readonly<Record<string, ModelLoad>>;

  readonly settings: Maybe<Settings>;
  readonly gpu: Maybe<GpuStatus>;
  readonly catalog: Maybe<readonly CatalogEntry[]>;
  readonly pulls: Readonly<Record<string, PullProgress>>;
  readonly sources: Maybe<readonly Source[]>;
  readonly imageStatus: Maybe<ImageStatus>;
  /** Action methods that answered not-implemented once (models.load, models.pull, …). */
  readonly unavailable: Readonly<Record<string, true>>;
  /** A one-line note the client shows under the composer after a refused send. */
  readonly notice: string | null;
}

export const fitKey = (model: string, numCtx: number) => `${model}@${numCtx}`;

const initial: State = {
  conn: { kind: "connecting" },
  serverOrigin: null,
  fileToken: null,
  runtime: undefined,
  models: undefined,
  threads: [],
  messages: {},
  firstToken: {},
  live: null,
  queued: [],
  view: "new",
  threadId: null,
  section: "general",
  addPage: false,
  ownerConfirm: false,
  fitPanel: { open: false, model: null },
  pop: null,
  draft: "",
  renaming: false,
  searchOpen: false,
  search: "",
  model: undefined,
  numCtx: 16384,
  think: true,
  image: false,
  fits: {},
  loads: {},
  settings: undefined,
  gpu: undefined,
  catalog: undefined,
  pulls: {},
  sources: undefined,
  imageStatus: undefined,
  unavailable: {},
  notice: null,
};

let state: State = initial;
const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}

/** Merge a patch (or the result of a function of the current state) and notify readers. */
export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
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
