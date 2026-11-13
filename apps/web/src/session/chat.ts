// Chat admissions, concurrent replies, streaming buffers and queue policy.
import { type BlockingTurn, type Message, type MethodName, type Params, type Payload, type ResultOf, WireError } from "@gates-local/contracts";
import { ctxFor, describeModel, k } from "../format.ts";
import { firstChatPull, sendableModel } from "../pick.ts";
import { type LiveTurn, NA, type Queued, type State, type StopAsk, type StopNote, chatReady, getState, runningTurn, setState, streamingHere, turnOf } from "../store.ts";
import { imageReason } from "../paste.ts";
import { drawChoice, imageMode } from "../image-choice.ts";
import { type Draft, beginQueuedDraft, cancelQueuedDraft, clearDraft, currentDraftKey, getDraft, moveDraft, replaceDraft } from "../drafts.ts";
import type { ServerEvent } from "./server-state.ts";
import { type ChatEvent, type TurnEvent, type WorkClock, aborted, leaveThinking, reduceTurn, startClock, stopThinking, stoppedBy, unfinished, withTurn } from "./turn.ts";

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

/**
 * chat.send answers once the question is saved, after the server admits the turn: that can wait
 * behind another chat's reply and a cold load on a full GPU (3 min 7 s on 2026-11-13, chat row 23).
 * The 30 s every other call gets made this client drop a send the server then ran anyway. A dropped
 * connection still ends the wait at once.
 */
export const SEND_TIMEOUT_MS = 20 * 60 * 1000;

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
function stopReason(event: { readonly code: string; readonly neededBy?: string | undefined }): string | undefined {
  if (event.code === "runtime-changed") return "Stopped when the Ollama runtime changed.";
  if (event.code !== "preempted") return undefined;
  const by = event.neededBy === undefined ? "another model" : describeModel(event.neededBy, catalogOf(getState())).name;
  return `Stopped so ${by} could load.`;
}

/** Why a reply the server saved unfinished stopped. `end` is how this client saw it stop (the person's Stop counts only when the server's end is an abort); none: the row's stop square alone marks it, because this client cannot say why. */
function savedNote(event: Extract<ChatEvent, { type: "error" }>, end: LiveTurn["end"]): StopNote | undefined {
  if (stoppedBy(end, event.code)) return { kind: "stopped", secs: end.secs };
  if (event.code === "cancelled") return undefined;
  return { kind: "said", words: stopReason(event) ?? `The reply didn't finish.${asSentence(event.message)}` };
}

/** The server's error text as a following sentence of a note; nothing when it has none. */
function asSentence(text: string): string {
  const t = text.trim();
  if (t === "") return "";
  const sentence = t.charAt(0).toUpperCase() + t.slice(1);
  return ` ${/[.!?]$/.test(sentence) ? sentence : `${sentence}.`}`;
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
  if (getState().editingQueued === id) cancelQueuedDraft(currentDraftKey());
  setState((s) => ({
    queued: s.queued.filter((q) => q.id !== id),
    ...(s.editingQueued === id ? { editingQueued: null } : {}),
    ...(s.stopAsk?.queuedId === id ? { stopAsk: null } : {}),
  }));
}

/** Edit: the words go in the composer and the message keeps its place until the next Send updates it. */
export function editQueued(id: string): void {
  const q = getState().queued.find((x) => x.id === id);
  if (q) {
    beginQueuedDraft(q.threadId, q.text, q.images ?? [], q.messageId ?? null);
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

/** A turn's clock as it ends, with thinking still waiting for a frame counted: a chat not on screen has none. */
const endClock = (turn: LiveTurn, w: Waiting | undefined, now: number): WorkClock | undefined =>
  w === undefined || w.gen !== turn.gen ? turn.clock : withWaiting(turn, w, now, w.textAt ?? now).clock;

/** A finished reply's clock, its thinking stopped at the end: kept by message id when the turn watched it. */
const keptClock = (clocks: State["clocks"], id: string, clock: WorkClock | undefined, now: number): State["clocks"] =>
  clock === undefined ? clocks : { ...clocks, [id]: stopThinking(clock, now) };

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
   * its own id (W-02, WF-01). A turn the person stopped that left the map
   * keeps its question: a failure that ends it anyway is said under it.
   */
  const oldTurns = new Map<string, string | undefined>();

  /** Apply one event to a thread's turn, if that turn is still the one numbered `gen`. */
  function update(threadId: string, gen: number, event: TurnEvent): void {
    applyServerEvent((s) => {
      const turn = s.turns[threadId];
      if (turn === undefined || turn.gen !== gen) return;
      return { turns: withTurn(s.turns, threadId, reduceTurn(turn, event, Date.now())) };
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
    if (turn.turnId !== null) oldTurns.set(turn.turnId, keepWords && turn.end?.kind === "stopped" ? turn.userMessageId : undefined);
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
   * Events that came while a send waited for chat.send to give its id; the
   * answer replays them (WF-01). They cannot live in the map: until the answer
   * this client does not know whose turn they belong to.
   */
  let early: Array<Payload<"chat.event">> = [];

  /** `keepDraft`: words from elsewhere (a Library question). The composer's draft is not this message: none of its pictures go, and it is left as it is, here and after the new chat exists. */
  async function send(text: string, opts: { reuseThread?: boolean; keepDraft?: true } = {}): Promise<void> {
    const content = text.trim();
    const s = getState();
    const key = currentDraftKey();
    const apart = opts.keepDraft === true;
    const draft = apart ? APART : getDraft(key);
    const images = draft.images;
    if (creatingDraft(draft.version)) return;
    if ((content === "" && images.length === 0) || asking) return;
    if (s.pasting) return;
    // Image on: the words go to the image model, so no chat model has to be ready, see the attachments or fit
    const draw = drawChoice(s);
    if (draw === undefined && imageMode(s)) return setState({ notice: "The image models are still being read. Send again in a moment." });
    const cannotSee = draw === undefined ? imageReason(s.models, s.model, images) : null;
    if (cannotSee) return setState({ notice: cannotSee });
    const threadId = s.view === "thread" || opts.reuseThread ? s.threadId : null;
    const messageId = draft.sendId ?? queueId();
    if (s.editingQueued !== null && !apart) {
      const id = s.editingQueued;
      if (!s.queued.some(q => q.id === id)) { setState({ editingQueued: null, notice: "Your edited words are still in the composer. Send them as a new message." }); return; }
      cancelQueuedDraft(key);
      setState((st) => ({ queued: st.queued.map((q) => (q.id === id ? { ...q, text: content, images, messageId } : q)), editingQueued: null, notice: null }));
      flushQueued();
      return;
    }
    const wait = (draw === undefined ? queueReason(s) : null) ?? (streamingHere(s) ? "reply" : null);
    if (!(draw === undefined ? chatReady(s) : s.conn.kind === "open") && wait === null) return;
    const model = sendableModel(s.models, s.model);
    if (model === undefined && draw === undefined && wait === null) return;
    const drawing = draw === undefined ? {} : { draw };

    if (wait === null) return admit({ content, images, messageId, model: model ?? "", threadId, keepDraft: apart, ...drawing });
    // Keep the draft visible while a first thread is being created.
    const queueIn = threadId ?? (await createThread(content, model, !apart));
    if (queueIn === null) return;
    const q: Queued = { id: queueId(), messageId, threadId: queueIn, text: content, images, at: Date.now(), waitFor: wait, ...(model === undefined ? {} : { model }), ...drawing };
    // Unchanged since Send, by its words: New thread during the creation gives the same draft a new identity.
    const now = getDraft(key);
    if (!apart && now.text === draft.text && now.images === draft.images && now.sendId === draft.sendId) clearDraft(key);
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
    if (!out.keepDraft && draft.text.trim() === out.content && draft.images === out.images) clearDraft(draftKey);
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
    const msg: Message = { id: `stopped-${l.gen}`, threadId, role: "assistant", content: l.text, ...(l.thinking === "" ? {} : { thinking: l.thinking }), ...(tools.length === 0 ? {} : { tools }), ...(l.contextNotice ? { contextNotice: l.contextNotice } : {}), model: l.model, createdAt: Date.now() };
    const note: StopNote = l.end.kind === "stopped" ? { kind: "stopped", secs: l.end.secs } : { kind: "said", words: "The reply didn't finish." };
    // A partial is not the whole history of a chat this client never opened.
    if (getState().messages[threadId] === undefined && !loading(threadId)) void loadThread(threadId);
    noteMessage(threadId, msg);
    const first = l.firstTokenAt;
    applyServerEvent((s) => ({
      messages: withMessage(s, threadId, msg),
      stopNotes: { ...s.stopNotes, [msg.id]: note },
      ...(first === undefined ? {} : { firstToken: { ...s.firstToken, [msg.id]: first - l.startedAt } }),
      clocks: keptClock(s.clocks, msg.id, l.clock, Date.now()),
    }));
  }

  async function startTurn(threadId: string, content: string, model: string, opts: TurnOptions = {}): Promise<void> {
    const s = getState();
    // a stopped reply's words stay in its chat, unless this is a Retry there, which is asking to replace them
    retire(s.turns[threadId], opts.out?.regenerate !== true);
    const images = opts.out?.images ?? opts.from?.q.images ?? [];
    const gen = ++turnGen;
    const replacing = opts.out?.regenerate === true ? retriedRows(s.messages[threadId] ?? []) : [];
    // the server has taken the old rows out in the same write that saved the new question
    const replacedIds = new Set(replacing.map((m) => m.id));
    const withoutReplaced = (st: State): State => replacing.length === 0 ? st : { ...st, messages: { ...st.messages, [threadId]: (st.messages[threadId] ?? []).filter((m) => !replacedIds.has(m.id)) } };
    const messageId = opts.out?.messageId ?? opts.from?.q.messageId ?? queueId();
    opts = { ...opts, messageId, ...(opts.from ? { from: { ...opts.from, q: { ...opts.from.q, messageId } } } : {}) };
    const draw = opts.out?.draw ?? opts.from?.q.draw;
    const startedAt = Date.now();
    const turn: LiveTurn = { gen, threadId, turnId: null, model: draw?.preset ?? model, startedAt, clock: startClock(startedAt), thinking: "", text: "", tools: [], pendingUser: content, pendingImages: images, ...(draw === undefined ? {} : { image: true as const }) };
    // Using is a turn that starts: a send, a queued send, Retry or Regenerate, after any warning was answered.
    // The next new chat starts on this model (navigation.ts newThread). An Image send uses no chat model.
    setState(st => ({ ...(opts.from ? { queued: st.queued.filter(q => q.id !== opts.from?.q.id) } : {}), turns: withTurn(st.turns, threadId, turn), ...(model === "" || draw !== undefined ? {} : { chosen: model }) }));
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
        ...(draw === undefined ? {} : { draw }),
        ...(opts.stopOthers ? { stopOthers: true, ...(opts.stopTurns === undefined ? {} : { stopTurns: opts.stopTurns }) } : opts.out === undefined ? {} : { askFirst: true }),
      }, { timeoutMs: SEND_TIMEOUT_MS });
      confirmCopy(r.userMessage);
      // the phone's pick for a new chat went with its first send, which the thread keeps; the next new chat starts from Settings
      if (draw !== undefined && opts.out?.threadId === null) {
        applyServerEvent((st) => st.imagePick?.preset === draw.preset && st.imagePick.width === draw.width && st.imagePick.height === draw.height ? { imagePick: undefined } : {});
      }
      if (r.replayed) {
        noteMessage(threadId, r.userMessage);
        applyServerEvent(st => ({ messages: withMessage(st, threadId, r.userMessage), notice: "Your message was already sent. It was not sent again.", ...(st.turns[threadId]?.gen === gen ? { turns: withTurn(st.turns, threadId, null) } : {}) }));
        replayEarly();
        await loadThread(threadId, true);
        flushQueued();
        return;
      }
      const now = getState().turns[threadId];
      const mine = now !== undefined && now.gen === gen;
      noteMessage(threadId, r.userMessage);
      applyServerEvent((st) => ({ messages: withMessage(withoutReplaced(st), threadId, r.userMessage) }));
      update(threadId, gen, { type: "sent", turnId: r.turnId, userMessageId: r.userMessage.id });
      // stopped before its id was known, or replaced by a newer turn: end it on the server too
      if (!mine || now.end !== undefined) {
        oldTurns.set(r.turnId, undefined);
        void call("chat.cancel", { turnId: r.turnId }).catch(() => undefined);
      }
      if (mine) {
        // this turn's own early events land now; any other pending turn's wait again for its answer
        replayEarly();
      } else {
        const theirs = early.filter((p) => p.turnId === r.turnId);
        early = early.filter((p) => p.turnId !== r.turnId);
        for (const p of theirs) if (p.event.type === "done") untrackedDone(p.threadId, p.event.message);
      }
    } catch (e) {
      // the app's own retry was refused: that counts as its one try
      if (opts.out?.regenerate === true) retryEnded(threadId, "failed");
      notSent(e, gen, threadId, content, model, opts);
      // A refused send may have buffered another client's start in this thread.
      // With its pending owner removed those events can land.
      replayEarly();
      flushQueued();
    }
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
    const code = codeOf(e);
    const turn = st.turns[threadId];
    const owner = turn?.gen === gen ? turn : null;
    // the person stopped it before the answer came: it ended here, or a newer send in its chat took its place after the Stop
    const halted = owner === null || owner.end?.kind === "stopped";
    const here = st.view === "thread" && st.threadId === threadId;
    const draft = getDraft(threadId);
    const where = out?.regenerate === true ? null : from === undefined && draft.text === "" && draft.images.length === 0 ? "box" : "queue";
    const blocking = e instanceof WireError ? e.blocking : undefined;
    // halted: the person has already said no; a message that went to the queue instead of the box would warn about words not in view
    const ask = code === "would-stop" && blocking !== undefined && out !== undefined && here && !halted && (from !== undefined || where !== "queue") ? { ...out, threadId, blocking } : null;
    const draw = out?.draw ?? from?.q.draw;
    const typed: Queued = { id: queueId(), ...(messageId ? { messageId } : {}), threadId, text: content, images, at: Date.now(), waitFor: "reply", model, held: true, ...(draw === undefined ? {} : { draw }) };
    const consented = ask !== null && stopOthersOk();
    if (where === "box") replaceDraft(threadId, { text: content, images, sendId: messageId ?? null });
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

  function replayEarly(): void {
    const all = early;
    early = [];
    for (const p of all) turnEvent(p);
  }

  /** Stop the reply being written in this chat (the open one unless named). */
  function stop(threadId = getState().threadId): void {
    const turn = runningTurn(getState(), threadId);
    if (turn === undefined) return;
    // the words that were waiting for a frame stay (W-05)
    flushWords(turn.threadId);
    update(turn.threadId, turn.gen, { type: "stop" });
    if (turn.turnId !== null) {
      oldTurns.set(turn.turnId, undefined);
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
    void admit({ content: last.content, images: last.images, model: s.model ?? last.model ?? "", threadId: s.threadId, keepDraft: true, regenerate: true, ...(draw === undefined ? {} : { draw }) });
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
      await admit({ content: last.content, images: last.images, model: model !== "" ? model : last.model ?? s.model ?? "", threadId, keepDraft: true, regenerate: true });
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
   */
  function lostTurn(): void {
    const open = getState().threadId;
    if (open !== null) flushWords(open);
    waiting.clear();
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
    const turn = getState().turns[threadId];
    // A send waiting for its id owns its chat's events; the answer binds the id before they replay.
    if (!oldTurns.has(turnId) && turn !== undefined && turn.turnId === null && turn.pendingUser !== null) {
      early.push(p);
      // the sidebar still knows whether a reply is being written there
      if (event.type === "start" || event.type === "done" || event.type === "error") update(threadId, turn.gen, { type: "early", turnId, ended: event.type !== "start" });
      return;
    }
    const question = oldTurns.get(turnId);
    if (event.type === "done" || event.type === "error") oldTurns.delete(turnId);
    if (turn === undefined || turn.turnId !== turnId) return otherTurn(p, question);
    const open = getState().threadId === threadId;
    switch (event.type) {
      case "thinking":
        return queueWords(turn, "thinking", event.text);
      case "delta":
        if (event.contextNotice === undefined) return event.text === "" ? undefined : queueWords(turn, "text", event.text);
        flushWords(threadId);
        return update(threadId, turn.gen, event);
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
        const w = waiting.get(threadId);
        const firstWordsAt = w !== undefined && w.gen === turn.gen ? w.textAt : undefined;
        waiting.delete(threadId);
        const msg = event.message;
        const firstAt = turn.firstTokenAt ?? firstWordsAt;
        const now = Date.now();
        const clock = endClock(turn, w, now);
        if (open) noteMessage(threadId, msg);
        applyServerEvent((s) => ({
          ...(open ? { messages: withMessage(s, threadId, msg) } : {}),
          ...(firstAt === undefined ? {} : { firstToken: { ...s.firstToken, [msg.id]: firstAt - turn.startedAt } }),
          clocks: keptClock(s.clocks, msg.id, clock, now),
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
          // the saved partial has every word the turn showed: it takes the turn's place
          const w = waiting.get(threadId);
          const firstAt = turn.firstTokenAt ?? (w !== undefined && w.gen === turn.gen ? w.textAt : undefined);
          waiting.delete(threadId);
          const now = Date.now();
          const clock = endClock(turn, w, now);
          const { partial } = said;
          noteMessage(threadId, partial);
          // a reply stopped while not on screen says so; who stopped it is not known here
          const note = savedNote(said, turn.end ?? (!open && said.code === "cancelled" ? { kind: "stopped", secs: Math.round((Date.now() - turn.startedAt) / 1000) } : undefined));
          applyServerEvent((s) => ({
            turns: withTurn(s.turns, threadId, null),
            clocks: keptClock(s.clocks, partial.id, clock, now),
            ...(open || s.messages[threadId] !== undefined ? { messages: withMessage(s, threadId, partial) } : {}),
            ...(note === undefined ? {} : { stopNotes: { ...s.stopNotes, [partial.id]: note } }),
            // the thought's length stays on the pill once the saved row takes over, as it does for a finished reply
            ...(firstAt === undefined ? {} : { firstToken: { ...s.firstToken, [partial.id]: firstAt - turn.startedAt } }),
          }));
        } else {
          flushWords(threadId);
          update(threadId, turn.gen, said);
          // on screen the ended turn stays with its Retry; elsewhere it settles into its chat now
          const ended = getState().turns[threadId];
          if (!open && ended !== undefined && ended.gen === turn.gen) settle(ended, said);
        }
        // a reply the person stopped, or the server halted to make way for something, is not retried
        const stopped = turn.end?.kind === "stopped" || aborted(event.code);
        if (retrying.has(threadId)) retryEnded(threadId, stopped ? "stopped" : "failed");
        else if (!stopped && turn.image !== true && retryBehindQueue(threadId, turn.model)) return;
        flushQueued();
        return;
      }
    }
  }

  /** A reply that ended without a saved row while its chat was not open: its words become a row with why it stopped, or the question gets the note. */
  function settle(turn: LiveTurn, event: Extract<ChatEvent, { type: "error" }>): void {
    applyServerEvent((s) => ({ turns: withTurn(s.turns, turn.threadId, null) }));
    if (turn.text !== "" || turn.thinking !== "" || turn.tools.length > 0) keepStoppedWords(turn);
    else if (event.code !== "cancelled" && turn.end?.kind !== "stopped") keepStopped(turn.threadId, turn.userMessageId, event);
  }

  /** A turn that ended without being on screen: what it saved goes into its thread, with why it stopped under it. */
  function keepStopped(threadId: string, userMessageId: string | undefined, event: Extract<ChatEvent, { type: "error" }>): void {
    const { partial } = event;
    if (partial !== undefined) noteMessage(threadId, partial);
    const why: StopNote | undefined = partial === undefined ? { kind: "said", words: stopReason(event) ?? "The reply didn't finish." } : savedNote(event, undefined);
    const on = partial?.id ?? userMessageId;
    applyServerEvent((s) => ({
      ...(partial !== undefined && s.messages[threadId] !== undefined ? { messages: withMessage(s, threadId, partial) } : {}),
      ...(on === undefined || why === undefined ? {} : { stopNotes: { ...s.stopNotes, [on]: why } }),
    }));
  }

  /**
   * An event of a turn this client has no turn for. A turn begun by another
   * client (the same thread open on the phone and the desktop) becomes its
   * chat's turn here too and streams (PH-02); a joining client gets the same
   * start with a snapshot of words already sent.
   */
  function otherTurn({ turnId, threadId, event }: Payload<"chat.event">, question?: string): void {
    if (event.type === "done") return untrackedDone(threadId, event.message);
    // a partial saved by a turn stopped elsewhere; a turn this client stopped itself reloads on its next visit
    if (event.type === "error" && event.partial !== undefined) return keepStopped(threadId, undefined, event);
    // a turn the person stopped, gone from the screen, that failed anyway: the failure is said under its question
    if (event.type === "error" && question !== undefined && !aborted(event.code)) return keepStopped(threadId, question, event);
    if (event.type !== "start" || oldTurns.has(turnId)) return;
    noteMessage(threadId, event.userMessage);
    retire(getState().turns[threadId]);
    const startedAt = Date.now();
    // a start sent again to this client as it connected: the turn began before it was here
    const clock = event.replayed === true ? {} : { clock: startClock(startedAt) };
    const turn: LiveTurn = { gen: ++turnGen, threadId, turnId, userMessageId: event.userMessage.id, model: event.model, startedAt, ...clock, thinking: "", text: "", tools: [], pendingUser: null, ...(event.image === true ? { image: true as const } : {}) };
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
      void admit({ content: next.text, images: next.images, messageId: next.messageId, model, threadId: next.threadId, keepDraft: true, queuedId: next.id, ...(next.draw === undefined ? {} : { draw: next.draw }) });
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
    void admit({ content: q.text, images: q.images, messageId: q.messageId, model: q.model ?? s.model ?? "", threadId: q.threadId, keepDraft: true, queuedId: q.id, ...(q.draw === undefined ? {} : { draw: q.draw }) });
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
