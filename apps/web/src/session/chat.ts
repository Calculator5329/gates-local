// Chat admissions, concurrent replies, streaming buffers and queue policy.
import { type BlockingTurn, type ImageChoice, type Message, type MethodName, type Params, type Payload, type ReplyTimes, type ResultOf, WireError } from "@gates-local/contracts";
import { ctxFor, describeModel, k } from "../format.ts";
import { firstChatPull, sendableModel } from "../pick.ts";
import { type LiveTurn, NA, type Queued, type State, type StopAsk, chatReady, getState, runningTurn, setState, streamingHere, turnOf } from "../store.ts";
import { imageReason } from "../paste.ts";
import { drawChoice, imageMode } from "../image-choice.ts";
import { releaseFiles } from "../file-holds.ts";
import { type Draft, beginQueuedDraft, cancelQueuedDraft, clearDraft, currentDraftKey, getDraft, moveDraft, replaceDraft } from "../drafts.ts";
import type { ServerEvent } from "./server-state.ts";
import { type ChatEvent, type TurnEvent, endReason, leaveThinking, reduceTurn, startClock, stopThinking, thoughtSecsAt, unfinished, withTurn } from "./turn.ts";
import { stopReason as stopWords } from "./times.ts";

declare global {
  interface Window {
    /**
     * Counters the performance spec reads. terminalFlush is that spec's
     * negative control (test/e2e/perf.spec.ts): the done event makes one
     * extra store publish of the open chat's turn before the saved row replaces it.
     */
    glPerf?: { deltas: number; flushes: number; terminalFlush?: boolean };
  }
}

interface ChatEffects {
  /** A function that returns nothing publishes nothing: no selector runs. */
  readonly applyServerEvent: (event: ServerEvent) => void;
  readonly call: <M extends MethodName>(method: M, params: Params<M>, options?: { readonly timeoutMs?: number }) => Promise<ResultOf<M>>;
  readonly codeOf: (error: unknown) => string;
  /** `fromDraft` false: the words are not in the composer, so a refusal does not say they are. */
  readonly createThread: (content: string, model: string | undefined, fromDraft?: boolean) => Promise<string | null>;
  readonly creatingDraft: (version: number) => boolean;
  readonly loadThread: (threadId: string, force?: boolean) => Promise<void>;
  readonly loading: (threadId: string) => boolean;
  readonly noteMessage: (threadId: string, message: Message) => void;
  readonly withMessage: (state: State, threadId: string, message: Message) => State["messages"];
  readonly untrackedDone: (threadId: string, message: Message) => void;
  readonly openThread: (threadId: string) => void;
  readonly blockingFor: (model: string, numCtx: number) => Promise<readonly BlockingTurn[]>;
}

const catalogOf = (s: State) => (s.catalog === NA ? undefined : s.catalog);

const STOP_OTHERS_KEY = "gates-local.stop-others-ok";

const queueId = () => `q-${crypto.randomUUID()}`;

type Outgoing = Omit<StopAsk, "blocking">;

/** Whether a message typed now would wait for setup or the first download instead of sending. */
export function queueReason(s: State): "setup" | "download" | null {
  if (s.conn.kind !== "open") return null;
  if (s.runtime?.state === "installing") return "setup";
  const first = firstPull(s);
  if (s.runtime?.state === "ready" && first !== undefined) return "download";
  return null;
}

/** The download that will become the first chat model, while none is installed (an embedding model does not count). */
export function firstPull(s: State): string | undefined {
  return firstChatPull(s.models, s.pulls);
}

function stopOthersOk(): boolean {
  try {
    return localStorage.getItem(STOP_OTHERS_KEY) === "1";
  } catch {
    return false;
  }
}

/** What a `keepDraft` send reads in place of the composer's draft: no pictures, no copy identity, no create in flight. */
const APART: Draft = { text: "", images: [], sendId: null, version: -1 };

/** A Send now waits on the server and on the warning: meanwhile the person may have removed its message or opened it for editing. */
function gone(out: Outgoing): boolean {
  const s = getState();
  return out.queuedId !== undefined && (s.editingQueued === out.queuedId || !s.queued.some((q) => q.id === out.queuedId));
}

function leaving(queued: readonly Queued[], q: Queued): Leaving {
  return { q, ahead: new Set(queued.slice(0, queued.indexOf(q)).map((x) => x.id)) };
}

function putBack(queued: readonly Queued[], { q, ahead }: Leaving): Queued[] {
  const { now: _now, ...rest } = q;
  const at = queued.findLastIndex((x) => ahead.has(x.id)) + 1;
  // reply, even if it waited for setup: that wait is over, and Send now on this row is how it goes
  return [...queued.slice(0, at), { ...rest, waitFor: "reply" as const, held: true as const }, ...queued.slice(at)];
}

export function cancelStopAsk(): void {
  setState({ stopAsk: null });
}


function elsewhereNotice(s: State, threadId: string): string {
  const title = s.threads.find((t) => t.id === threadId)?.title;
  return `A message in ${title === undefined || title === "" ? "another chat" : `“${title}”`} didn't send. It's on hold in that chat.`;
}

/** Plain words for a refused send; `where` is where its words went (null: they were already in the chat). */
function refusal(code: string, model: string, where: "box" | "queue" | null): string {
  const name = describeModel(model, catalogOf(getState())).name;
  const back = where === null ? "" : ` Your message is back in the ${where}.`;
  switch (code) {
    case "wont-fit":
      return `${name} doesn't fit in memory at ${k(ctxFor(getState().numCtx, getState().models, model))}. Pick a smaller model or context.`;
    case "turn-active":
      return "A reply is still being written in this thread. Stop it or wait.";
    case "would-stop":
      return `Another chat's reply is using the memory ${name} needs.${back}`;
    case "runtime-not-ready":
      return `Chat starts when Ollama is ready.${back}`;
    case "closed":
    case "timeout":
      return `Gates Local stopped answering.${back}`;
    default:
      return "The message didn't send. Try again.";
  }
}


/** Retry stays off while a stopped turn has not ended on the server: the server refuses a second turn in a thread, and the old turn's events must not land on the new one. */
export function canRetry(s: State): boolean {
  return s.threadId !== null && !streamingHere(s) && s.turns[s.threadId]?.ending !== true;
}

/** One plain sentence for a reply the server stopped to make way for something else. */
const stopReason = (event: { readonly code: string; readonly neededBy?: string | undefined }): string | undefined => stopWords(event, catalogOf(getState()));

/**
 * A live turn's times, as a row of words kept here carries them when the server saved none (a
 * reply retired before its end came): the same shape the server stamps, so it draws the same way.
 */
function localTimes(l: LiveTurn, end: NonNullable<LiveTurn["end"]>, now: number): ReplyTimes {
  const thought = l.thinkingSecs ?? (l.firstTokenAt === undefined || l.thinking === "" ? undefined : thoughtSecsAt(l, l.firstTokenAt));
  const clock = l.clock === undefined ? undefined : stopThinking(l.clock, now);
  return {
    startedAt: l.startedAt,
    ...(l.firstTokenAt === undefined ? {} : { firstTokenAt: l.firstTokenAt }),
    ...(thought === undefined ? {} : { thoughtMs: thought * 1000 }),
    spans: clock?.spans ?? [],
    callsAt: clock?.at ?? {},
    // a Stop keeps the seconds this client showed; a failure says only that the reply didn't finish
    ended: end.kind === "stopped" ? { reason: "stopped", at: l.startedAt + end.secs * 1000 } : { reason: "failed", at: now },
    ...(end.kind === "error" ? { why: { code: end.code, message: "" } } : {}),
  };
}

/** A row Retry replaces: a stopped reply, or a picture that failed or was cancelled (the server's retriedRows). */
const retriable = (m: Message) => m.interrupted === true || m.imageJob?.state === "error" || m.imageJob?.state === "cancelled";

/** What a Retry replaces on the server: the last question and the unfinished rows after it. None when a finished reply followed: Regenerate is then a new question. */
function retriedRows(messages: readonly Message[]): readonly Message[] {
  const rows = messages.slice(messages.findLastIndex((m) => m.role === "user"));
  return rows[0]?.role === "user" && rows.slice(1).every(retriable) ? rows : [];
}

/** The reply these messages waited for stopped or failed: they wait for Send now instead of going out on their own. */
function holdQueue(threadId: string): void {
  const waiting = (q: Queued) => q.threadId === threadId && q.waitFor === "reply" && q.now !== true;
  setState((s) => (s.queued.some(waiting) ? { queued: s.queued.map((q) => (waiting(q) ? { ...q, held: true as const } : q)) } : {}));
}

const waitsBehind = (threadId: string) => (q: Queued) => q.threadId === threadId && q.waitFor === "reply" && q.now !== true;

/**
 * The queue behind a reply the app retries on its own: on hold while the retry runs ("running"),
 * still on hold when it failed too ("failed"), sent as usual when it finished (undefined: no longer held).
 * A stop during the retry leaves it held with no retry word.
 */
function markRetry(threadId: string, retry: "running" | "failed" | "finished" | "stopped"): void {
  const waiting = waitsBehind(threadId);
  setState((s) => (s.queued.some(waiting) ? {
    queued: s.queued.map((q) => {
      if (!waiting(q)) return q;
      const { held: _held, retry: _retry, ...rest } = q;
      if (retry === "finished") return q.retry === "running" ? rest : q;
      if (retry === "stopped") return { ...rest, held: true as const };
      return { ...rest, held: true as const, retry };
    }),
  } : {}));
}

/** Remove: the message is gone. Edit is the way to get its words back. */
export function removeQueued(id: string): void {
  const files = getState().queued.find((q) => q.id === id)?.files ?? [];
  if (getState().editingQueued === id) cancelQueuedDraft(currentDraftKey());
  setState((s) => ({
    queued: s.queued.filter((q) => q.id !== id),
    ...(s.editingQueued === id ? { editingQueued: null } : {}),
    ...(s.stopAsk?.queuedId === id ? { stopAsk: null } : {}),
  }));
  releaseFiles(files.map((f) => f.path));
}

/** Edit: the words go in the composer and the message keeps its place until the next Send updates it. */
export function editQueued(id: string): void {
  const q = getState().queued.find((x) => x.id === id);
  if (q) {
    beginQueuedDraft(q.threadId, q.text, q.images ?? [], q.messageId ?? null, q.files);
    setState({ editingQueued: id, notice: null, stopAsk: null });
  }
}

/** A queued message on its way to the server, and the ones that were ahead of it: a refused send puts it back at its place. */
interface Leaving {
  readonly q: Queued;
  readonly ahead: ReadonlySet<string>;
}

interface TurnOptions {
  readonly messageId?: string;
  readonly stopOthers?: boolean;
  readonly stopTurns?: readonly string[] | undefined;
  /** It left the queue for this send. */
  readonly from?: Leaving | undefined;
  /** The person is waiting on it, so a reply in the way can still get the warning; queued messages that go on their own have none. */
  readonly out?: Outgoing;
}

/** Words that came since the last frame, for one turn. */
interface Waiting {
  readonly gen: number;
  text: string;
  thinking: string;
  /** When the first of these words arrived: a first word's time is when it came, not when it reached the screen. */
  textAt?: number;
  /** When the first of the thinking words arrived: a thought starts when it came, also in a chat not on screen. */
  thinkingAt?: number;
}

/**
 * The turn with the words that waited for a frame applied at the times they came:
 * the thinking runs from its first waiting word and stops at `answerAt` when answer words waited too.
 */
function withWaiting(turn: LiveTurn, w: Waiting, now: number, answerAt: number): LiveTurn {
  const thought = reduceTurn(turn, { type: "thinking", text: w.thinking }, w.thinkingAt ?? now) ?? turn;
  const answering = w.text === "" ? thought : leaveThinking(thought, answerAt);
  return reduceTurn(answering, { type: "delta", text: w.text }, w.textAt ?? now) ?? answering;
}

/** The model is loading into memory now, by the server's models.load: a turn starting on it is not ready yet. */
const loadingNow = (s: State, model: string): boolean => s.loads[model]?.state === "loading";

/** History, navigation, fit and RPC operations are wired by session.ts. */
export function createChat({ applyServerEvent, call, codeOf, createThread, creatingDraft, loadThread, loading, noteMessage, withMessage, untrackedDone, openThread, blockingFor }: ChatEffects) {
  /** A saved user message confirms its exact copy; edited words already have a new identity. */
  function confirmCopy(message: Message): void {
    const matchedDraft = getDraft(message.threadId).sendId === message.id;
    if (matchedDraft) {
      if (getDraft(message.threadId).beforeEdit) cancelQueuedDraft(message.threadId);
      else clearDraft(message.threadId);
    }
    applyServerEvent(s => {
      const queued = s.queued.find(q => q.messageId === message.id);
      const editing = queued !== undefined && queued.id === s.editingQueued;
      const draft = matchedDraft;
      const ask = s.stopAsk?.messageId === message.id;
      if (!queued && !draft && !ask) return {};
      return {
        ...(queued ? { queued: s.queued.filter(q => q.messageId !== message.id) } : {}),
        ...(editing ? { editingQueued: null } : {}),
        ...(ask ? { stopAsk: null } : {}),
      };
    });
  }

  const perf: NonNullable<Window["glPerf"]> = { deltas: 0, flushes: 0 };
  window.glPerf = perf;

  /** Turns started this session; each turn carries its number (LiveTurn.gen). */
  let turnGen = 0;
  /**
   * Ids of turns this client stopped or replaced, until their terminal event.
   * A replaced turn is no longer in the map, so this is what keeps its late
   * events off the turn that took its chat's place while that one waits for
   * its own id (W-02, WF-01). Its terminal event still brings the rows it
   * saved, with how it ended stamped on them.
   */
  const oldTurns = new Set<string>();

  /** Apply one event to a thread's turn, if that turn is still the one numbered `gen`. */
  function update(threadId: string, gen: number, event: TurnEvent): void {
    applyServerEvent((s) => {
      const turn = s.turns[threadId];
      if (turn === undefined || turn.gen !== gen) return;
      return { turns: withTurn(s.turns, threadId, reduceTurn(turn, event, Date.now(), event.type === "start" && loadingNow(s, event.model))) };
    });
  }

  /**
   * A turn leaving the map: its id, when known, is retired, so its late events
   * never reach the turn that replaces it (WF-01); words it showed that no saved
   * row will bring stay in its chat.
   */
  function retire(turn: LiveTurn | undefined, keepWords = true): void {
    // a listed turn has shown nothing, and its events, if they come, start it afresh
    if (turn === undefined || turn.listed === true) return;
    // a Retry replaces what it stopped: nothing is said under its question
    if (turn.turnId !== null) oldTurns.add(turn.turnId);
    if (keepWords) keepStoppedWords(turn);
  }

  /**
   * Replies that ended (stopped, failed or cut off) stay in their chat with
   * their Retry until the person moves on: a send, or opening a chat whose
   * reply is running. Then their words become rows with their note, except in
   * the chat a Retry is replacing them in.
   */
  function settleEnded(except?: string, regenerating?: string): void {
    const ended = Object.values(getState().turns).filter((t) => t.end !== undefined && t.threadId !== except);
    if (ended.length === 0) return;
    for (const t of ended) retire(t, t.threadId !== regenerating);
    applyServerEvent((s) => ({ turns: ended.reduce((turns, t) => (turns[t.threadId]?.gen === t.gen ? withTurn(turns, t.threadId, null) : turns), s.turns) }));
  }

  /**
   * This client's sends that have not started yet (chat row 32), by the message id each asks the
   * server to save: the turn's start brings the saved question with that id, and an error before
   * it is the refusal, which puts the words back. `turnId` is the one chat.send answered with; the
   * start, which names the question, can also be told apart before the answer is read.
   */
  interface Admitting {
    readonly threadId: string;
    readonly gen: number;
    turnId?: string;
    readonly started: (question: Message) => void;
    readonly refused: (e: WireError) => void;
  }
  const admitting = new Map<string, Admitting>();
  const admittingTurn = (turnId: string) => [...admitting.entries()].find(([, a]) => a.turnId === turnId);
  /** The send a start belongs to: by its turn id once answered, else by the question it saved, which names the message id the send asked for. */
  function ownAdmission(turnId: string, threadId: string, questionId: string): [string, Admitting] | undefined {
    const answered = admittingTurn(turnId);
    if (answered !== undefined) return answered;
    const asked = admitting.get(questionId);
    return asked !== undefined && asked.threadId === threadId && asked.turnId === undefined ? [questionId, asked] : undefined;
  }

  /** `keepDraft`: words from elsewhere (a Library question). The composer's draft is not this message: none of its pictures go, and it is left as it is, here and after the new chat exists. */
  async function send(text: string, opts: { reuseThread?: boolean; keepDraft?: true; draw?: ImageChoice } = {}): Promise<void> {
    const content = text.trim();
    const s = getState();
    const key = currentDraftKey();
    const apart = opts.keepDraft === true;
    const draft = apart ? APART : getDraft(key);
    const images = draft.images;
    const files = draft.files ?? [];
    const attached = files.length ? { files } : {};
    if (creatingDraft(draft.version)) return;
    if ((content === "" && images.length === 0 && files.length === 0) || asking) return;
    if (s.pasting) return;
    // Image on: the words go to the image model, so no chat model has to be ready, see the attachments or fit.
    // `draw`: a picture's own setup (Pictures' Again), whatever the composer is set to.
    const draw = opts.draw ?? drawChoice(s);
    if (draw === undefined && imageMode(s)) return setState({ notice: "The image models are still being read. Send again in a moment." });
    const cannotSee = draw === undefined ? imageReason(s.models, s.model, images) : null;
    if (cannotSee) return setState({ notice: cannotSee });
    const threadId = s.view === "thread" || opts.reuseThread ? s.threadId : null;
    const messageId = draft.sendId ?? queueId();
    if (s.editingQueued !== null && !apart) {
      const id = s.editingQueued;
      if (!s.queued.some(q => q.id === id)) { setState({ editingQueued: null, notice: "Your edited words are still in the composer. Send them as a new message." }); return; }
      cancelQueuedDraft(key);
      setState((st) => ({ queued: st.queued.map((q) => (q.id === id ? { ...q, text: content, images, files, messageId } : q)), editingQueued: null, notice: null }));
      flushQueued();
      return;
    }
    const wait = (draw === undefined ? queueReason(s) : null) ?? (streamingHere(s) ? "reply" : null);
    if (!(draw === undefined ? chatReady(s) : s.conn.kind === "open") && wait === null) return;
    const model = sendableModel(s.models, s.model);
    if (model === undefined && draw === undefined && wait === null) return;
    const drawing = draw === undefined ? {} : { draw };

    if (wait === null) return admit({ content, images, ...attached, messageId, model: model ?? "", threadId, keepDraft: apart, ...drawing });
    // Keep the draft visible while a first thread is being created.
    const queueIn = threadId ?? (await createThread(content, model, !apart));
    if (queueIn === null) return;
    const q: Queued = { id: queueId(), messageId, threadId: queueIn, text: content, images, ...attached, at: Date.now(), waitFor: wait, ...(model === undefined ? {} : { model }), ...drawing };
    // Unchanged since Send, by its words: New thread during the creation gives the same draft a new identity.
    const now = getDraft(key);
    if (!apart && now.text === draft.text && now.images === draft.images && now.files === draft.files && now.sendId === draft.sendId) clearDraft(key);
    if (key === null && !apart) moveDraft(null, queueIn);
    settleEnded();
    setState((st) => ({ notice: null, stopAsk: null, queued: [...st.queued, q] }));
  }

  /** The server is being asked what a send would stop; a second Enter in that moment is the same send. */
  let asking = false;

  /** Every send from the person goes through here: the server says whether it would stop another chat, and the warning asks once. */
  async function admit(out: Outgoing): Promise<void> {
    if (asking) return;
    out = { ...out, messageId: out.messageId ?? queueId() };
    asking = true;
    // a picture loads no chat model, so it stops no other chat's reply (the image job keeps its own GPU rules)
    const blocking = out.draw === undefined ? await blockingFor(out.model, getState().numCtx) : [];
    asking = false;
    if (gone(out)) return;
    if (blocking.length > 0 && !stopOthersOk()) {
      setState({ stopAsk: { ...out, blocking }, notice: null });
      return;
    }
    await launch(out, blocking.length > 0);
  }

  /** `stopTurns`: the turns a warning named and the person agreed to; without it, standing consent. */
  async function launch(out: Outgoing, stopOthers: boolean, stopTurns?: readonly string[]): Promise<void> {
    if (gone(out)) return setState({ stopAsk: null });
    const { queued } = getState();
    const q = queued.find((x) => x.id === out.queuedId);
    const from = q === undefined ? undefined : leaving(queued, q);
    settleEnded(undefined, out.regenerate === true ? out.threadId ?? undefined : undefined);
    // Keep the words in view until a new chat exists. A failed create leaves the draft alone.
    const threadId = out.threadId ?? (await createThread(out.content, out.model === "" ? undefined : out.model, !out.keepDraft));
    if (threadId === null) return;
    const draftKey = out.threadId;
    const draft = getDraft(draftKey);
    if (!out.keepDraft && draft.text.trim() === out.content && draft.images === out.images && (draft.files ?? []).length === (out.files ?? []).length) clearDraft(draftKey);
    // A new chat for words from elsewhere leaves the new-chat draft where it was.
    if (out.threadId === null && !out.keepDraft) moveDraft(null, threadId);
    setState((s) => ({
      notice: null, stopAsk: null,
      ...(out.queuedId === undefined ? {} : { queued: s.queued.filter((x) => x.id !== out.queuedId) }),
    }));
    await startTurn(threadId, out.content, out.model, { stopOthers, stopTurns, from, out });
  }

  /** The warning's action. `dontShowAgain` is saved only here, so a Cancel with the box ticked changes nothing. */
  function confirmStopAsk(dontShowAgain: boolean): void {
    const ask = getState().stopAsk;
    if (ask === null) return;
    if (dontShowAgain) {
      try {
        localStorage.setItem(STOP_OTHERS_KEY, "1");
      } catch {
        // private windows may refuse storage; the warning shows again next time
      }
    }
    void launch(ask, true, stopOthersOk() ? undefined : ask.blocking.flatMap((t) => t.turnId ?? []));
  }

  /** A stopped or failed reply without a saved partial keeps its words in this client's chat. Still `ending`: the server's terminal event is on its way and brings the saved row. */
  function keepStoppedWords(l: LiveTurn): void {
    if (l.end === undefined || l.ending === true || (l.end.kind === "error" && l.end.code === "closed") || (l.text === "" && l.thinking === "" && l.tools.length === 0)) return;
    const { threadId } = l;
    // a call the person's Stop cut short is kept as stopped, one that a failure cut as failed
    const stopped = l.end.kind === "stopped";
    const tools = l.tools.map((t) => t.state === "running" ? { ...t, state: "error" as const, ...(stopped ? { stopped: true as const } : {}) } : t);
    const now = Date.now();
    const msg: Message = { id: `stopped-${l.gen}`, threadId, role: "assistant", content: l.text, ...(l.thinking === "" ? {} : { thinking: l.thinking }), ...(tools.length === 0 ? {} : { tools }),
      model: l.model, createdAt: now, times: localTimes(l, l.end, now) };
    // A partial is not the whole history of a chat this client never opened.
    if (getState().messages[threadId] === undefined && !loading(threadId)) void loadThread(threadId);
    noteMessage(threadId, msg);
    applyServerEvent((s) => ({ messages: withMessage(s, threadId, msg) }));
  }

  async function startTurn(threadId: string, content: string, model: string, opts: TurnOptions = {}): Promise<void> {
    const s = getState();
    // a stopped reply's words stay in its chat, unless this is a Retry there, which is asking to replace them
    retire(s.turns[threadId], opts.out?.regenerate !== true);
    const images = opts.out?.images ?? opts.from?.q.images ?? [];
    const files = opts.out?.files ?? opts.from?.q.files ?? [];
    const gen = ++turnGen;
    const replacing = opts.out?.regenerate === true ? retriedRows(s.messages[threadId] ?? []) : [];
    // the server has taken the old rows out in the same write that saved the new question
    const replacedIds = new Set(replacing.map((m) => m.id));
    const withoutReplaced = (st: State): State => replacing.length === 0 ? st : { ...st, messages: { ...st.messages, [threadId]: (st.messages[threadId] ?? []).filter((m) => !replacedIds.has(m.id)) } };
    const messageId = opts.out?.messageId ?? opts.from?.q.messageId ?? queueId();
    opts = { ...opts, messageId, ...(opts.from ? { from: { ...opts.from, q: { ...opts.from.q, messageId } } } : {}) };
    const draw = opts.out?.draw ?? opts.from?.q.draw;
    // a new thread's first send carries the count picked before it existed; a thread keeps its own
    const fresh = opts.out?.threadId === null;
    const drawCount = draw === undefined ? undefined : fresh ? s.imageCountNew : s.threads.find((t) => t.id === threadId)?.imageCount ?? 1;
    const startedAt = Date.now();
    const turn: LiveTurn = { gen, threadId, turnId: null, model: draw?.preset ?? model, startedAt, clock: startClock(startedAt), thinking: "", text: "", tools: [], pendingUser: content, pendingImages: images, ...(files.length ? { pendingFiles: files } : {}), ...(draw === undefined ? {} : { image: true as const }) };
    // Using is a turn that starts: a send, a queued send, Retry or Regenerate, after any warning was answered.
    // The next new chat starts on this model (navigation.ts newThread). An Image send uses no chat model.
    setState(st => ({ ...(opts.from ? { queued: st.queued.filter(q => q.id !== opts.from?.q.id) } : {}), turns: withTurn(st.turns, threadId, turn), ...(model === "" || draw !== undefined ? {} : { chosen: model }) }));
    const own: Admitting = {
      threadId,
      gen,
      started: (question) => {
        noteMessage(threadId, question);
        applyServerEvent((st) => ({ messages: withMessage(withoutReplaced(st), threadId, question) }));
        // the phone's pick for a new chat went with its first send, which the thread keeps; the next new chat starts from Settings
        if (draw !== undefined && fresh) {
          // the thread keeps the count now (the server saved it with this send), so the button does not blink back to 1 before the list says so
          applyServerEvent((st) => ({
            ...st.imagePick?.preset === draw.preset && st.imagePick.width === draw.width && st.imagePick.height === draw.height ? { imagePick: undefined } : {},
            imageCountNew: 1,
            threads: st.threads.map((t) => (t.id === threadId && drawCount !== undefined && drawCount > 1 ? { ...t, imageCount: drawCount } : t)),
          }));
        }
      },
      refused: (e) => notStarted(e, gen, threadId, content, model, opts),
    };
    admitting.set(messageId, own);
    try {
      const r = await call("chat.send", {
        threadId,
        content,
        messageId,
        ...(replacing[0] === undefined ? {} : { retryOf: replacing[0].id }),
        model,
        numCtx: s.numCtx,
        think: s.think,
        ...(images.length ? { images } : {}),
        ...(files.length ? { files: [...files] } : {}),
        ...(draw === undefined ? {} : { draw, drawCount }),
        ...(opts.stopOthers ? { stopOthers: true, ...(opts.stopTurns === undefined ? {} : { stopTurns: opts.stopTurns }) } : opts.out === undefined ? {} : { askFirst: true }),
      });
      const saved = r.userMessage;
      if (r.replayed && saved !== undefined) {
        if (admitting.get(messageId) === own) admitting.delete(messageId);
        confirmCopy(saved);
        noteMessage(threadId, saved);
        // the first send's turn may still be writing, and its start already made this the turn that shows it
        const running = own.turnId !== undefined;
        applyServerEvent(st => ({ messages: withMessage(st, threadId, saved), notice: "Your message was already sent. It was not sent again.", ...(!running && st.turns[threadId]?.gen === gen ? { turns: withTurn(st.turns, threadId, null) } : {}) }));
        await loadThread(threadId, true);
        flushQueued();
        return;
      }
      // its start may have come already, and bound the turn's id (turnEvent)
      if (own.turnId === undefined) {
        own.turnId = r.turnId;
        update(threadId, gen, { type: "sent", turnId: r.turnId });
      }
      const now = getState().turns[threadId];
      const mine = now !== undefined && now.gen === gen;
      // stopped before its id was known, or replaced by a newer turn: end it on the server too
      if (!mine || now.end !== undefined) {
        oldTurns.add(r.turnId);
        void call("chat.cancel", { turnId: r.turnId }).catch(() => undefined);
      }
    } catch (e) {
      if (admitting.get(messageId) !== own) return;
      admitting.delete(messageId);
      notStarted(e, gen, threadId, content, model, opts);
    }
  }

  /** chat.send was refused, or the turn ended before its start: nothing was saved. */
  function notStarted(e: unknown, gen: number, threadId: string, content: string, model: string, opts: TurnOptions): void {
    // the app's own retry was refused: that counts as its one try
    if (opts.out?.regenerate === true) retryEnded(threadId, "failed");
    notSent(e, gen, threadId, content, model, opts);
    flushQueued();
  }

  /**
   * chat.send was refused, so nothing was saved: the words go where the person
   * will find them. A queued message goes back
   * to its place. Other words go back in their thread's empty draft, even off
   * screen, else on hold in that chat's queue. A Retry's are already in the chat.
   * A reply in the way that the preflight missed gets the usual warning, when
   * the person is still there to answer it.
   */
  function notSent(e: unknown, gen: number, threadId: string, content: string, model: string, { from, out, messageId }: TurnOptions): void {
    const st = getState();
    const images = out?.images ?? from?.q.images ?? [];
    const files = out?.files ?? from?.q.files ?? [];
    const attached = files.length ? { files } : {};
    const code = codeOf(e);
    const turn = st.turns[threadId];
    const owner = turn?.gen === gen ? turn : null;
    // the person stopped it before the answer came: it ended here, or a newer send in its chat took its place after the Stop
    const halted = owner === null || owner.end?.kind === "stopped";
    const here = st.view === "thread" && st.threadId === threadId;
    const draft = getDraft(threadId);
    const where = out?.regenerate === true ? null : from === undefined && draft.text === "" && draft.images.length === 0 && !draft.files?.length ? "box" : "queue";
    const blocking = e instanceof WireError ? e.blocking : undefined;
    // halted: the person has already said no; a message that went to the queue instead of the box would warn about words not in view
    const ask = code === "would-stop" && blocking !== undefined && out !== undefined && here && !halted && (from !== undefined || where !== "queue") ? { ...out, threadId, blocking } : null;
    const draw = out?.draw ?? from?.q.draw;
    const typed: Queued = { id: queueId(), ...(messageId ? { messageId } : {}), threadId, text: content, images, ...attached, at: Date.now(), waitFor: "reply", model, held: true, ...(draw === undefined ? {} : { draw }) };
    const consented = ask !== null && stopOthersOk();
    if (where === "box") replaceDraft(threadId, { text: content, images, ...attached, sendId: messageId ?? null });
    const title = st.threads.find(t => t.id === threadId)?.title;
    const restoredElsewhere = where === "box" && !here ? `Your message didn't send. Your words are in the draft in ${title ? `“${title}”` : "another chat"}.` : undefined;
    applyServerEvent({
      ...(owner === null ? {} : { turns: withTurn(st.turns, threadId, halted ? reduceTurn(owner, { type: "refused" }, Date.now()) : null) }),
      ...(where === "queue" ? { queued: from === undefined ? [...st.queued, typed] : putBack(st.queued, from) } : {}),
      ...(ask === null || consented ? {} : { stopAsk: ask, notice: null }),
      ...(ask === null && !halted ? { notice: restoredElsewhere ?? (code === "gpu-unreadable" && e instanceof Error ? `${e.message}${where === null ? "" : ` Your message is back in the ${where}.`}` : code === "image-input" && e instanceof Error ? e.message : where === "queue" && !here ? elsewhereNotice(st, threadId) : refusal(code, model, where)) } : {}),
    });
    if (consented) void launch(ask, true);
    // what waited behind it does not overtake it
    else if (ask === null && from !== undefined) holdQueue(from.q.threadId);
  }

  /** Stop the reply being written in this chat (the open one unless named). */
  function stop(threadId = getState().threadId): void {
    const turn = runningTurn(getState(), threadId);
    if (turn === undefined) return;
    // the words that were waiting for a frame stay (W-05)
    flushWords(turn.threadId);
    update(turn.threadId, turn.gen, { type: "stop" });
    if (turn.turnId !== null) {
      oldTurns.add(turn.turnId);
      void call("chat.cancel", { turnId: turn.turnId }).catch(() => undefined);
      return;
    }
    // without an id yet, startTurn cancels it once chat.send answers; until then another chat finishing can wake the queue
    holdQueue(turn.threadId);
  }

  /** Retry or Regenerate: send the thread's last user message again. An unfinished reply is replaced; after a finished one the server keeps both copies (no regenerate method yet). */
  function retry(): void {
    const s = getState();
    if (s.threadId === null || !canRetry(s)) return;
    const last = (s.messages[s.threadId] ?? []).findLast((m) => m.role === "user");
    if (!last) return;
    // sent again the way Send would send it now: with Image on, to the image model
    const draw = drawChoice(s);
    void admit({ content: last.content, images: last.images, ...(last.files ? { files: last.files } : {}), model: s.model ?? last.model ?? "", threadId: s.threadId, keepDraft: true, regenerate: true, ...(draw === undefined ? {} : { draw }) });
  }

  /**
   * Threads whose failed reply the app is retrying once on its own, because a message
   * waits behind it (owner ruling, chat row 23). A second failure is not retried.
   */
  const retrying = new Set<string>();

  /** A reply that failed with a message queued behind it in its chat: retried once, the way Retry would, in that chat whether it is open or not. */
  function retryBehindQueue(threadId: string, model: string): boolean {
    if (retrying.has(threadId) || !getState().queued.some(waitsBehind(threadId))) return false;
    retrying.add(threadId);
    markRetry(threadId, "running");
    void (async () => {
      if (getState().messages[threadId] === undefined) await loadThread(threadId);
      const s = getState();
      const last = (s.messages[threadId] ?? []).findLast((m) => m.role === "user");
      if (last === undefined || !retrying.has(threadId) || unfinished(s.turns[threadId]) || s.turns[threadId]?.ending === true) {
        if (retrying.delete(threadId)) markRetry(threadId, "failed");
        flushQueued();
        return;
      }
      // the model that failed, as Retry would send it from that chat
      await admit({ content: last.content, images: last.images, ...(last.files ? { files: last.files } : {}), model: model !== "" ? model : last.model ?? s.model ?? "", threadId, keepDraft: true, regenerate: true });
    })();
    return true;
  }

  /** How a retried reply ended: a finish sends the queue behind it, a failure keeps it held and says so, a stop just holds it. */
  function retryEnded(threadId: string, how: "finished" | "failed" | "stopped"): void {
    if (retrying.delete(threadId)) markRetry(threadId, how);
  }

  /**
   * A dropped connection loses every stream. The open chat keeps its reply,
   * marked cut off; a reply behind another chat is let go, and the next visit
   * to its thread reloads what was saved. A send still waiting for its answer
   * stays: the dropped connection refuses it, and notSent takes it from there.
   * A send answered but not started is refused here the same way: its start or
   * its refusal may have been lost with the connection. Its words go back with
   * its message id, so sending them again cannot ask twice.
   */
  function lostTurn(): void {
    const open = getState().threadId;
    if (open !== null) flushWords(open);
    waiting.clear();
    // one still waiting for its answer is refused by its call
    const unstarted = [...admitting.entries()].filter(([, a]) => a.turnId !== undefined);
    for (const [key] of unstarted) admitting.delete(key);
    for (const [, own] of unstarted) own.refused(new WireError("closed", "The connection dropped before this message was sent."));
    applyServerEvent((s) => {
      let turns = s.turns;
      for (const turn of Object.values(s.turns)) {
        const behind = turn.threadId !== open && turn.turnId !== null && turn.end === undefined;
        turns = withTurn(turns, turn.threadId, behind || turn.listed === true ? null : reduceTurn(turn, { type: "lost" }, Date.now()));
      }
      return { turns };
    });
  }

  /**
   * turns.active at hydration: a reply the server is writing that this client
   * has no turn for gets a listed one, which only marks its chat running until
   * its first event; one this client marked cut off is running again. The
   * server lists a turn before saving its question and may drop it with no
   * event, so a listed turn ends here, at the next hydration that does not list
   * it (or when the connection drops).
   */
  function activeTurns(s: State, active: readonly { readonly threadId: string; readonly turnId: string }[]): Pick<State, "turns"> {
    const ids = new Set(active.map((a) => a.turnId));
    let turns = s.turns;
    for (const turn of Object.values(s.turns)) if (turn.listed === true && (turn.turnId === null || !ids.has(turn.turnId))) turns = withTurn(turns, turn.threadId, null);
    for (const { threadId, turnId } of active) {
      const turn = turns[threadId];
      if (oldTurns.has(turnId)) continue;
      if (turn?.turnId === turnId) turns = withTurn(turns, threadId, reduceTurn(turn, { type: "running" }, Date.now()));
      else if (turn === undefined) turns = withTurn(turns, threadId, { gen: ++turnGen, threadId, turnId, model: "", startedAt: Date.now(), thinking: "", text: "", tools: [], pendingUser: null, listed: true });
      // any other turn there is this client's own: its send's answer, or the snapshot's start, settles it
    }
    return { turns };
  }

  // Words batch into one store update per animation frame, and only for the
  // open chat: a reply in another chat costs it nothing per word. Its words
  // land when its turn changes phase (first word, tool step, end) or when its
  // chat is opened.
  const waiting = new Map<string, Waiting>();
  let raf = 0;

  function flushWords(threadId: string): void {
    const w = waiting.get(threadId);
    if (w === undefined) return;
    waiting.delete(threadId);
    perf.flushes++;
    applyServerEvent((s) => {
      const turn = s.turns[threadId];
      if (turn === undefined || turn.gen !== w.gen) return;
      const now = Date.now();
      // the thinking stops when the answer's words reach the store, never before a time the chip already showed
      return { turns: withTurn(s.turns, threadId, withWaiting(turn, w, now, now)) };
    });
  }

  function frame(): void {
    raf = 0;
    const open = getState().threadId;
    if (open !== null) flushWords(open);
  }

  function queueWords(turn: LiveTurn, kind: "text" | "thinking", t: string): void {
    perf.deltas++;
    // words after the person's Stop are dropped (W-05), and so is their time: the seconds Stop showed stay the only ones
    if (turn.end?.kind === "stopped") return;
    let w = waiting.get(turn.threadId);
    if (w === undefined || w.gen !== turn.gen) waiting.set(turn.threadId, (w = { gen: turn.gen, text: "", thinking: "" }));
    if (kind === "text" && w.textAt === undefined) w.textAt = Date.now();
    if (kind === "thinking" && w.thinkingAt === undefined) w.thinkingAt = Date.now();
    w[kind] += t;
    if (getState().threadId === turn.threadId) {
      if (raf === 0) raf = requestAnimationFrame(frame);
    } else if (kind === "text" && (turn.firstTokenAt === undefined || (turn.thinkingSecs === undefined && turn.thinking + w.thinking !== ""))) {
      // the first word ends the thinking: the chat's turn changes phase now, not when the chat is opened
      flushWords(turn.threadId);
    }
  }

  /** Opening a chat shows every word its reply wrote meanwhile; a reply coming back to the screen moves ended ones on. */
  function catchUp(threadId: string): void {
    flushWords(threadId);
    if (turnOf(getState(), threadId) !== undefined) settleEnded(threadId);
  }

  function onChatEvent(p: Payload<"chat.event">): void {
    if (p.event.type === "start") confirmCopy(p.event.userMessage);
    turnEvent(p);
  }

  /** Every event of every turn, in an open chat or not, goes through here; all but the two that save a row (done, an error with a partial) then go through reduceTurn. */
  function turnEvent(p: Payload<"chat.event">): void {
    const { turnId, threadId, event } = p;
    // a send of this client's that has not started: its start brings the question, an error before it is its refusal
    const mine = event.type === "start" ? ownAdmission(turnId, threadId, event.userMessage.id) : event.type === "error" ? admittingTurn(turnId) : undefined;
    if (mine !== undefined) {
      const [key, own] = mine;
      admitting.delete(key);
      if (event.type === "error") {
        oldTurns.delete(turnId);
        return own.refused(new WireError(event.code, event.message, event.blocking));
      }
      if (own.turnId === undefined) {
        own.turnId = turnId;
        update(threadId, own.gen, { type: "sent", turnId });
      }
      if (event.type === "start") own.started(event.userMessage);
    }
    if (event.type === "done" || event.type === "error") oldTurns.delete(turnId);
    const turn = getState().turns[threadId];
    // a turn another window sent that never started here: refused there, so nothing of it shows here
    if (turn?.listed === true && turn.turnId === turnId && event.type === "error") {
      applyServerEvent((s) => ({ turns: withTurn(s.turns, threadId, null) }));
      keepStopped(threadId, event);
      return flushQueued();
    }
    if (turn === undefined || turn.turnId !== turnId) return otherTurn(p);
    const open = getState().threadId === threadId;
    switch (event.type) {
      case "thinking":
        return queueWords(turn, "thinking", event.text);
      case "delta":
        return event.text === "" ? undefined : queueWords(turn, "text", event.text);
      case "tool":
        flushWords(threadId);
        return update(threadId, turn.gen, event);
      case "start":
        noteMessage(threadId, event.userMessage);
        if (getState().messages[threadId] !== undefined) applyServerEvent((s) => ({ messages: withMessage(s, threadId, event.userMessage) }));
        // the snapshot that follows has every word: words still waiting would come twice
        if (turn.end === undefined || turn.end.kind === "error") waiting.delete(threadId);
        return update(threadId, turn.gen, event);
      case "done": {
        // the saved message has every word: drop the waiting ones instead of
        // publishing them a moment before the row that replaces them (W-09)
        if (open && window.glPerf?.terminalFlush === true) {
          perf.flushes++;
          applyServerEvent((s) => ({ turns: { ...s.turns, [threadId]: { ...turn } } }));
        }
        waiting.delete(threadId);
        // the row carries the server's times: its thought, first token and rounds draw from them
        const msg = event.message;
        if (open) noteMessage(threadId, msg);
        applyServerEvent((s) => ({
          ...(open ? { messages: withMessage(s, threadId, msg) } : {}),
          turns: withTurn(s.turns, threadId, null),
        }));
        // a chat not on screen reloads: its cached history may be behind
        if (!open) untrackedDone(threadId, msg);
        // the person said stop: a Stop that lost the race to the last token holds the queue like any other
        if (turn.end?.kind === "stopped") { holdQueue(threadId); retryEnded(threadId, "stopped"); }
        else retryEnded(threadId, "finished");
        flushQueued();
        return;
      }
      case "error": {
        const said = { ...event, message: stopReason(event) ?? event.message };
        holdQueue(threadId);
        if (said.partial !== undefined) {
          // the saved partial has every word the turn showed, and how and when it ended: it takes the turn's place
          waiting.delete(threadId);
          const { partial } = said;
          noteMessage(threadId, partial);
          applyServerEvent((s) => ({
            turns: withTurn(s.turns, threadId, null),
            ...(open || s.messages[threadId] !== undefined ? { messages: withMessage(s, threadId, partial) } : {}),
          }));
        } else {
          flushWords(threadId);
          // the question, stamped with how its turn ended: its note shows once the ended turn leaves the screen
          keepQuestion(threadId, said);
          update(threadId, turn.gen, said);
          // on screen the ended turn stays with its Retry; elsewhere it settles into its chat now
          const ended = getState().turns[threadId];
          if (!open && ended !== undefined && ended.gen === turn.gen) settle(ended);
        }
        // a reply the person stopped, or the server halted to make way for something, is not retried
        const stopped = turn.end?.kind === "stopped" || endReason(event) !== "failed";
        if (retrying.has(threadId)) retryEnded(threadId, stopped ? "stopped" : "failed");
        else if (!stopped && turn.image !== true && retryBehindQueue(threadId, turn.model)) return;
        flushQueued();
        return;
      }
    }
  }

  /** A reply that ended without a saved row while its chat was not open: its words become a row; its question already says how it ended. */
  function settle(turn: LiveTurn): void {
    applyServerEvent((s) => ({ turns: withTurn(s.turns, turn.threadId, null) }));
    if (turn.text !== "" || turn.thinking !== "" || turn.tools.length > 0) keepStoppedWords(turn);
  }

  /**
   * The question of a turn that saved no reply, stamped by the server with how the turn ended, in
   * place of its copy here. Only in place: a Retry may have taken the row out on the server already.
   */
  function keepQuestion(threadId: string, event: Extract<ChatEvent, { type: "error" }>): void {
    const { question } = event;
    if (question === undefined) return;
    applyServerEvent((s) => s.messages[threadId]?.some((m) => m.id === question.id) === true ? { messages: withMessage(s, threadId, question) } : {});
  }

  /** A turn that ended without being on screen: what it saved goes into its thread, with how it ended on the row. */
  function keepStopped(threadId: string, event: Extract<ChatEvent, { type: "error" }>): void {
    const { partial } = event;
    if (partial === undefined) return keepQuestion(threadId, event);
    noteMessage(threadId, partial);
    applyServerEvent((s) => (s.messages[threadId] !== undefined ? { messages: withMessage(s, threadId, partial) } : {}));
  }

  /**
   * An event of a turn this client has no turn for. A turn begun by another
   * client (the same thread open on the phone and the desktop) becomes its
   * chat's turn here too and streams (PH-02); a joining client gets the same
   * start with a snapshot of words already sent.
   */
  function otherTurn({ turnId, threadId, event }: Payload<"chat.event">): void {
    if (event.type === "done") return untrackedDone(threadId, event.message);
    // what a turn stopped elsewhere, or gone from the screen, saved: the row says how it ended
    if (event.type === "error") return keepStopped(threadId, event);
    if (event.type !== "start" || oldTurns.has(turnId)) return;
    noteMessage(threadId, event.userMessage);
    retire(getState().turns[threadId]);
    const startedAt = Date.now();
    // a start sent again to this client as it connected: the turn began before it was here
    const clock = event.replayed === true ? {} : { clock: startClock(startedAt) };
    // its model still loading: ready at its first token, as for a turn of this client's own
    const ready = loadingNow(getState(), event.model) ? {} : { readyAt: startedAt };
    const turn: LiveTurn = { gen: ++turnGen, threadId, turnId, userMessageId: event.userMessage.id, model: event.model, startedAt, ...clock, ...ready, thinking: "", text: "", tools: [], pendingUser: null, ...(event.image === true ? { image: true as const } : {}) };
    applyServerEvent((st) => ({
      ...(st.messages[threadId] !== undefined ? { messages: withMessage(st, threadId, event.userMessage) } : {}),
      turns: withTurn(st.turns, threadId, turn),
    }));
  }

  /**
   * Send the next waiting message, oldest first, once nothing is in its way:
   * one at a time for this client, never past a message on hold or being
   * edited unless Send now asked for it.
   */
  function flushQueued(): void {
    const s = getState();
    const next = s.queued.find((q) => q.id !== s.editingQueued && (q.now === true || q.held !== true));
    // a picture needs no chat model: only the connection
    if (next?.draw === undefined ? !chatReady(s) || queueReason(s) !== null : s.conn.kind !== "open") return;
    const model = next?.model ?? s.model ?? (next?.draw === undefined ? undefined : "");
    if (next === undefined || model === undefined) return;
    if (next.now === true) {
      if (unfinished(s.turns[next.threadId])) return;
      void admit({ content: next.text, images: next.images, ...(next.files ? { files: next.files } : {}), messageId: next.messageId, model, threadId: next.threadId, keepDraft: true, queuedId: next.id, ...(next.draw === undefined ? {} : { draw: next.draw }) });
      return;
    }
    // one reply at a time: a queued message waits while any reply this client knows of, in any chat, is unfinished
    if (Object.values(s.turns).some(unfinished)) return;
    const from = leaving(s.queued, next);
    // setup and the first download are the whole app waiting; a queue behind a reply stays out of the way
    if (next.waitFor !== "reply" && getState().threadId !== next.threadId) openThread(next.threadId);
    void startTurn(next.threadId, next.text, model, { from });
  }

  /**
   * Send now, T3 Code's interrupt: a reply running in this message's chat stops,
   * and the message goes first once that has ended. With nothing running there
   * it goes at once, through the same warning as any other send.
   */
  function sendQueuedNow(id: string): void {
    const s = getState();
    const q = s.queued.find((x) => x.id === id);
    if (!q || q.waitFor !== "reply") return;
    if (unfinished(s.turns[q.threadId])) {
      const { held: _held, retry: _retry, ...rest } = q;
      setState({ queued: [{ ...rest, now: true }, ...s.queued.filter((x) => x.id !== id)] });
      stop(q.threadId);
      return;
    }
    void admit({ content: q.text, images: q.images, ...(q.files ? { files: q.files } : {}), messageId: q.messageId, model: q.model ?? s.model ?? "", threadId: q.threadId, keepDraft: true, queuedId: q.id, ...(q.draw === undefined ? {} : { draw: q.draw }) });
  }

  function cancelQueuedEdit(): void {
    cancelQueuedDraft(currentDraftKey());
    setState({ editingQueued: null });
    flushQueued();
  }

  return {
    send, confirmStopAsk, stop: () => stop(), retry, sendQueuedNow, cancelQueuedEdit,
    onChatEvent, lostTurn, catchUp, activeTurns, flushQueued,
  };
}
