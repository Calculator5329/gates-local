// Chat admissions, concurrent replies, streaming buffers and queue policy.
import { type BlockingTurn, type Message, type MethodName, type Params, type Payload, type ResultOf, type ToolStep, WireError } from "@gates-local/contracts";
import { ctxFor, describeModel, k } from "../format.ts";
import { firstChatPull, sendableModel } from "../pick.ts";
import { type LiveTurn, NA, type Queued, type State, type StopAsk, chatReady, getState, setState, streaming, streamingHere } from "../store.ts";
import { imageReason } from "../paste.ts";

declare global {
  interface Window {
    /**
     * Counters the performance spec reads. terminalFlush is that spec's
     * negative control (test/e2e/perf.spec.ts): the done event makes one
     * extra store publish of the live turn before the saved row replaces it.
     */
    glPerf?: { deltas: number; flushes: number; terminalFlush?: boolean };
  }
}

interface ChatEffects {
  readonly applyServerEvent: typeof setState;
  readonly call: <M extends MethodName>(method: M, params: Params<M>) => Promise<ResultOf<M>>;
  readonly codeOf: (error: unknown) => string;
  readonly createThread: (content: string, model: string | undefined) => Promise<string | null>;
  readonly creatingDraft: (version: number) => boolean;
  readonly loadThread: (threadId: string, force?: boolean) => Promise<void>;
  readonly loading: (threadId: string) => boolean;
  readonly noteMessage: (threadId: string, message: Message) => void;
  readonly withMessage: (state: State, threadId: string, message: Message) => State["messages"];
  readonly untrackedDone: (threadId: string, message: Message) => void;
  readonly openThread: (threadId: string) => void;
  readonly blockingFor: (model: string, numCtx: number) => Promise<readonly BlockingTurn[]>;
  readonly invalidateFits: (hideOld?: boolean) => void;
}

const catalogOf = (s: State) => (s.catalog === NA ? undefined : s.catalog);

const STOP_OTHERS_KEY = "gates-local.stop-others-ok";

const queueId = () => `q-${crypto.randomUUID()}`;

type ChatEvent = Payload<"chat.event">["event"];

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
  return s.threadId !== null && !streamingHere(s) && !(s.live?.threadId === s.threadId && s.live.ending === true);
}

/** One plain sentence for a reply the server stopped to make way for something else. */
function stopReason(event: { readonly code: string; readonly neededBy?: string | undefined }): string | undefined {
  if (event.code === "runtime-changed") return "Stopped when the Ollama runtime changed.";
  if (event.code !== "preempted") return undefined;
  const by = event.neededBy === undefined ? "another model" : describeModel(event.neededBy, catalogOf(getState())).name;
  return `Stopped so ${by} could load.`;
}

/** The reply these messages waited for stopped or failed: they wait for Send now instead of going out on their own. */
function holdQueue(threadId: string): void {
  const waiting = (q: Queued) => q.threadId === threadId && q.waitFor === "reply" && q.now !== true;
  setState((s) => (s.queued.some(waiting) ? { queued: s.queued.map((q) => (waiting(q) ? { ...q, held: true as const } : q)) } : {}));
}

function upsertStep(steps: readonly ToolStep[], step: ToolStep): ToolStep[] {
  const i = steps.findIndex((x) => x.callId === step.callId);
  return i < 0 ? [...steps, step] : steps.map((x, j) => (j === i ? step : x));
}

/** Remove: the message is gone. Edit is the way to get its words back. */
export function removeQueued(id: string): void {
  setState((s) => ({
    queued: s.queued.filter((q) => q.id !== id),
    ...(s.editingQueued === id ? { editingQueued: null, draft: "", draftImages: [] } : {}),
    ...(s.stopAsk?.queuedId === id ? { stopAsk: null } : {}),
  }));
}

/** Edit: the words go in the composer and the message keeps its place until the next Send updates it. */
export function editQueued(id: string): void {
  const q = getState().queued.find((x) => x.id === id);
  if (q) setState({ editingQueued: id, draft: q.text, draftImages: q.images ?? [], draftSendId: q.messageId ?? null, draftSendThreadId: q.threadId, notice: null, stopAsk: null });
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

/** History, navigation, fit and RPC operations are wired by session.ts. */
export function createChat({ applyServerEvent, call, codeOf, createThread, creatingDraft, loadThread, loading, noteMessage, withMessage, untrackedDone, openThread, blockingFor, invalidateFits }: ChatEffects) {
  /** A late terminal must leave a newer turn in the same thread marked. */
  function clearRunning(threadId: string, turnId: string | undefined): void {
    const active = getState().runningTurns;
    if (turnId === undefined || active[threadId] !== turnId) return;
    const runningTurns = { ...active };
    delete runningTurns[threadId];
    applyServerEvent({ runningTurns });
  }

  /** A saved user message confirms its exact copy; edited words already have a new identity. */
  function confirmCopy(message: Message): void {
    applyServerEvent(s => {
      const queued = s.queued.find(q => q.messageId === message.id);
      const editing = queued !== undefined && queued.id === s.editingQueued;
      const draft = s.draftSendId === message.id && s.draftSendThreadId === message.threadId;
      const ask = s.stopAsk?.messageId === message.id;
      if (!queued && !draft && !ask) return {};
      return {
        ...(queued ? { queued: s.queued.filter(q => q.messageId !== message.id) } : {}),
        ...(editing ? { editingQueued: null } : {}),
        ...(draft ? { draft: "", draftImages: [], draftSendId: null } : {}),
        ...(ask ? { stopAsk: null } : {}),
      };
    });
  }

  const perf: NonNullable<Window["glPerf"]> = { deltas: 0, flushes: 0 };
  window.glPerf = perf;

  /** Turns started this session; each live turn carries its number (LiveTurn.gen). */
  let turnGen = 0;
  /**
   * Turn ids the client stopped or replaced. Until their terminal event, their
   * events reach only the live turn that still carries their id, never a newer
   * turn that is waiting for its own id (W-02).
   */
  const oldTurns = new Set<string>();

  /**
   * Before a live turn is replaced: its id, when known, is retired, so its late
   * events (after a reconnect its server turn may still run) never reach the
   * turn that replaces it (WF-01).
   */
  function retire(live: LiveTurn | null, keepWords = true): void {
    if (live === null) return;
    if (live.turnId !== null) oldTurns.add(live.turnId);
    if (keepWords) keepStoppedWords(live);
  }

  /** Events that came while the live turn waited for chat.send to give its id; the answer replays them (WF-01). */
  let early: Array<Payload<"chat.event">> = [];

  async function send(text: string, opts: { reuseThread?: boolean } = {}): Promise<void> {
    const content = text.trim();
    const s = getState();
    const images = s.draftImages;
    if (creatingDraft(s.draftVersion)) return;
    if ((content === "" && images.length === 0) || asking) return;
    if (s.pasting) return;
    const cannotSee = imageReason(s.models, s.model, images);
    if (cannotSee) return setState({ notice: cannotSee });
    const threadId = s.view === "thread" || opts.reuseThread ? s.threadId : null;
    const messageId = threadId !== null && s.draftSendThreadId === threadId ? s.draftSendId ?? queueId() : queueId();
    // Sending this copy elsewhere is a new message, even if its words did not change.
    if (s.draftSendId !== null && s.draftSendThreadId !== threadId) setState({ draftSendId: null });
    if (s.editingQueued !== null) {
      const id = s.editingQueued;
      if (!s.queued.some(q => q.id === id)) { setState({ editingQueued: null, notice: "Your edited words are still in the composer. Send them as a new message." }); return; }
      setState((st) => ({ queued: st.queued.map((q) => (q.id === id ? { ...q, text: content, images, messageId } : q)), editingQueued: null, draft: "", draftImages: [], notice: null }));
      flushQueued();
      return;
    }
    const wait = queueReason(s) ?? (streamingHere(s) ? "reply" : null);
    if (!chatReady(s) && wait === null) return;
    const model = sendableModel(s.models, s.model);
    if (model === undefined && wait === null) return;

    if (wait === null) return admit({ content, images, messageId, model: model ?? "", threadId, keepDraft: false });
    // Keep the draft visible while a first thread is being created.
    const queueIn = threadId ?? (await createThread(content, model));
    if (queueIn === null) return;
    const q: Queued = { id: queueId(), messageId, threadId: queueIn, text: content, images, at: Date.now(), waitFor: wait, ...(model === undefined ? {} : { model }) };
    setState((st) => ({ ...settled(), ...(st.draft === s.draft && st.draftImages === images ? { draft: "", draftImages: [] } : {}), notice: null, stopAsk: null, queued: [...st.queued, q] }));
  }

  /**
   * The live slot, cleared of a turn that has ended; a reply still being written
   * keeps it until another turn needs it. A stopped reply's words stay in its
   * chat, unless this is a Retry in that chat, which is asking to replace them.
   */
  function settled(regenerating?: string): Partial<State> {
    const s = getState();
    if (streaming(s)) return {};
    retire(s.live, s.live?.threadId !== regenerating);
    return { live: null };
  }

  /** The server is being asked what a send would stop; a second Enter in that moment is the same send. */
  let asking = false;

  /** Every send from the person goes through here: the server says whether it would stop another chat, and the warning asks once. */
  async function admit(out: Outgoing): Promise<void> {
    if (asking) return;
    out = { ...out, messageId: out.messageId ?? queueId() };
    asking = true;
    const blocking = await blockingFor(out.model, getState().numCtx);
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
    const slot = settled(out.regenerate === true ? (out.threadId ?? undefined) : undefined);
    // Keep the words in view until a new chat exists. A failed create leaves the draft alone.
    const threadId = out.threadId ?? (await createThread(out.content, out.model));
    if (threadId === null) return;
    setState((s) => ({
      ...slot, notice: null, stopAsk: null,
      ...(out.keepDraft || s.draft.trim() !== out.content || s.draftImages !== out.images ? {} : { draft: "", draftImages: [] }),
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

  /**
   * Turns still running on the server for chats not on screen, kept out of the
   * store so their words cost no render. openThread puts one back in the live
   * slot with everything it wrote meanwhile.
   */
  let parked: LiveTurn[] = [];

  /** Running replies in a thread, including one kept behind the displayed chat. */
  function repliesInProgress(s: State, threadId: string): number {
    return Number(streaming(s) && s.live?.threadId === threadId) + parked.filter((turn) => turn.threadId === threadId && turn.end === undefined).length;
  }

  /** The live slot is about to hold a turn in `threadId`: a reply running in another chat keeps running behind it. */
  function setAside(threadId: string): void {
    const live = getState().live;
    if (live !== null && live.end === undefined && live.threadId !== threadId) {
      // its waiting words are its own, not the next turn's
      flushDeltas();
      const now = getState().live;
      if (now !== null) parked.push(now);
      return;
    }
    retire(live);
  }

  function bringBack(threadId: string): void {
    const i = parked.findIndex((t) => t.threadId === threadId);
    const back = parked[i];
    if (back === undefined) return;
    flushDeltas();
    parked.splice(i, 1);
    const s = getState();
    if (streaming(s) && s.live !== null) parked.push(s.live);
    else retire(s.live);
    setState({ live: back });
  }

  /** A stopped or failed reply without a saved partial keeps its words in this client's chat. */
  function keepStoppedWords(l: LiveTurn): void {
    if (l.end === undefined || (l.end.kind === "error" && l.end.code === "closed") || (l.text === "" && l.thinking === "" && l.tools.length === 0)) return;
    const { threadId } = l;
    const tools = l.tools.map((t) => t.state === "running" ? { ...t, state: "error" as const } : t);
    const msg: Message = { id: `stopped-${l.gen}`, threadId, role: "assistant", content: l.text, ...(l.thinking === "" ? {} : { thinking: l.thinking }), ...(tools.length === 0 ? {} : { tools }), ...(l.contextNotice ? { contextNotice: l.contextNotice } : {}), model: l.model, createdAt: Date.now() };
    const note = l.end.kind === "stopped" ? `Stopped after ${l.end.secs} s.` : "The reply didn't finish.";
    // A partial is not the whole history of a chat this client never opened.
    if (getState().messages[threadId] === undefined && !loading(threadId)) void loadThread(threadId);
    noteMessage(threadId, msg);
    applyServerEvent((s) => ({ messages: withMessage(s, threadId, msg), stopNotes: { ...s.stopNotes, [msg.id]: note } }));
  }

  /** Sends Stop reached before the server gave them an id: the live slot that showed it may belong to another chat by the time the answer comes. */
  const stoppedAtAdmission = new Set<number>();

  async function startTurn(threadId: string, content: string, model: string, opts: TurnOptions = {}): Promise<void> {
    setAside(threadId);
    const s = getState();
    const images = opts.out?.images ?? opts.from?.q.images ?? [];
    const gen = ++turnGen;
    const messageId = opts.out?.messageId ?? opts.from?.q.messageId ?? queueId();
    opts = { ...opts, messageId, ...(opts.from ? { from: { ...opts.from, q: { ...opts.from.q, messageId } } } : {}) };
    setState(st => ({ ...(opts.from ? { queued: st.queued.filter(q => q.id !== opts.from?.q.id) } : {}), live: { gen, threadId, turnId: null, model, startedAt: Date.now(), thinking: "", text: "", tools: [], pendingUser: content, pendingImages: images } }));
    try {
      const r = await call("chat.send", {
        threadId,
        content,
        messageId,
        model,
        numCtx: s.numCtx,
        think: s.think,
        ...(images.length ? { images } : {}),
        ...(s.image ? { image: true } : {}),
        ...(opts.stopOthers ? { stopOthers: true, ...(opts.stopTurns === undefined ? {} : { stopTurns: opts.stopTurns }) } : opts.out === undefined ? {} : { askFirst: true }),
      });
      confirmCopy(r.userMessage);
      if (r.replayed) {
        parked = parked.filter(turn => turn.gen !== gen);
        noteMessage(threadId, r.userMessage);
        applyServerEvent(st => ({ messages: withMessage(st, threadId, r.userMessage), notice: "Your message was already sent. It was not sent again.", ...(st.live?.gen === gen ? { live: null } : {}) }));
        replayEarly();
        await loadThread(threadId, true);
        flushQueued();
        return;
      }
      const away = parked.findIndex((t) => t.gen === gen);
      if (away >= 0) {
        // the person moved on before the id came, and another chat's turn took the slot: this one runs on behind it
        parked[away] = { ...(parked[away] as LiveTurn), turnId: r.turnId, userMessageId: r.userMessage.id, pendingUser: null };
        noteMessage(threadId, r.userMessage);
        applyServerEvent((st) => ({ messages: withMessage(st, threadId, r.userMessage) }));
        const theirs = early.filter((p) => p.turnId === r.turnId);
        early = early.filter((p) => p.turnId !== r.turnId);
        for (const p of theirs) turnEvent(p);
        return;
      }
      const now = getState().live;
      const mine = now !== null && now.gen === gen;
      noteMessage(threadId, r.userMessage);
      applyServerEvent((st) => ({
        messages: withMessage(st, threadId, r.userMessage),
        ...(st.live !== null && st.live.gen === gen ? { live: { ...st.live, turnId: r.turnId, userMessageId: r.userMessage.id, pendingUser: null } } : {}),
      }));
      // stopped before its id was known, or replaced by a newer turn: end it on the server too
      if (!mine || now.end !== undefined) {
        clearRunning(threadId, r.turnId);
        oldTurns.add(r.turnId);
        void call("chat.cancel", { turnId: r.turnId }).catch(() => undefined);
      }
      if (mine) {
        // this turn's own early events land now; any other turn's go where they would have
        replayEarly();
      } else {
        const theirs = early.filter((p) => p.turnId === r.turnId);
        early = early.filter((p) => p.turnId !== r.turnId);
        for (const p of theirs) if (p.event.type === "done") untrackedDone(p.threadId, p.event.message);
      }
    } catch (e) {
      parked = parked.filter((t) => t.gen !== gen);
      notSent(e, gen, threadId, content, model, opts);
      // A refused send may have buffered another client's start in this thread,
      // also while parked. With its pending owner removed those events can land.
      replayEarly();
      flushQueued();
    } finally {
      stoppedAtAdmission.delete(gen);
    }
  }

  /**
   * chat.send was refused, so nothing was saved: the words go where the person
   * will find them, whoever holds the live slot now. A queued message goes back
   * to its place. Other words go back in the box if it is on screen and empty,
   * else on hold in their own chat's queue. A Retry's are already in the chat.
   * A reply in the way that the preflight missed gets the usual warning, when
   * the person is still there to answer it.
   */
  function notSent(e: unknown, gen: number, threadId: string, content: string, model: string, { from, out, messageId }: TurnOptions): void {
    const st = getState();
    const images = out?.images ?? from?.q.images ?? [];
    const code = codeOf(e);
    const owner = st.live?.gen === gen ? st.live : null;
    const halted = owner?.end !== undefined || stoppedAtAdmission.has(gen);
    const here = st.view === "thread" && st.threadId === threadId;
    const where = out?.regenerate === true ? null : from === undefined && here && st.draft === "" && st.draftImages.length === 0 ? "box" : "queue";
    const blocking = e instanceof WireError ? e.blocking : undefined;
    // halted: the person has already said no; a message that went to the queue instead of the box would warn about words not in view
    const ask = code === "would-stop" && blocking !== undefined && out !== undefined && here && !halted && (from !== undefined || where !== "queue") ? { ...out, threadId, blocking } : null;
    const typed: Queued = { id: queueId(), ...(messageId ? { messageId } : {}), threadId, text: content, images, at: Date.now(), waitFor: "reply", model, held: true };
    const consented = ask !== null && stopOthersOk();
    applyServerEvent({
      ...(owner === null ? {} : { live: halted ? { ...owner, pendingUser: null, ending: undefined } : null }),
      ...(where === "box" ? { draft: content, draftImages: images, draftSendId: messageId ?? null, draftSendThreadId: threadId } : {}),
      ...(where === "queue" ? { queued: from === undefined ? [...st.queued, typed] : putBack(st.queued, from) } : {}),
      ...(ask === null || consented ? {} : { stopAsk: ask, notice: null }),
      ...(ask === null && !halted ? { notice: code === "gpu-unreadable" && e instanceof Error ? `${e.message}${where === null ? "" : ` Your message is back in the ${where}.`}` : code === "image-input" && e instanceof Error ? e.message : where === "queue" && !here ? elsewhereNotice(st, threadId) : refusal(code, model, where) } : {}),
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

  function stop(): void {
    const live = getState().live;
    if (live === null || live.end !== undefined) return;
    flushDeltas();
    // after the flush, on the state it left: the words that were waiting for a frame stay (W-05)
    const secs = Math.round((Date.now() - live.startedAt) / 1000);
    setState((s) => (s.live !== null && s.live.gen === live.gen && s.live.end === undefined ? { live: { ...s.live, end: { kind: "stopped", secs }, ending: true } } : {}));
    if (live.turnId !== null) {
      clearRunning(live.threadId, live.turnId);
      oldTurns.add(live.turnId);
      void call("chat.cancel", { turnId: live.turnId }).catch(() => undefined);
      return;
    }
    // without an id yet, startTurn cancels it once chat.send answers; until then another chat's
    // send can take the slot, and another chat finishing can wake the queue
    stoppedAtAdmission.add(live.gen);
    holdQueue(live.threadId);
  }

  /** Retry or Regenerate: send the thread's last user message again. The server keeps both copies (no regenerate method yet). */
  function retry(): void {
    const s = getState();
    if (s.threadId === null || !canRetry(s)) return;
    const last = (s.messages[s.threadId] ?? []).findLast((m) => m.role === "user");
    if (!last) return;
    void admit({ content: last.content, images: last.images, model: s.model ?? last.model ?? "", threadId: s.threadId, keepDraft: true, regenerate: true });
  }

  /** A dropped connection loses the live turn's stream; the server may still save it. */
  function lostTurn(): void {
    flushDeltas();
    // the words of a turn behind another chat stop too; the next visit to its thread reloads what was saved
    parked = [];
    applyServerEvent({ runningTurns: {} });
    // the old socket's terminal events will not come; a stopped turn stops waiting for them
    applyServerEvent((s) =>
      s.live === null
        ? {}
        : s.live.end === undefined
          ? { live: { ...s.live, end: { kind: "error", code: "closed", message: "The connection dropped while this reply was being written." } } }
          : s.live.ending
            ? { live: { ...s.live, ending: undefined } }
            : {},
    );
  }

  // Deltas batch into one store update per animation frame.
  let pendText = "";
  let pendThinking = "";
  let raf = 0;

  function flushDeltas(): void {
    if (raf !== 0) cancelAnimationFrame(raf);
    raf = 0;
    if (pendText === "" && pendThinking === "") return;
    const text = pendText;
    const thinking = pendThinking;
    pendText = "";
    pendThinking = "";
    perf.flushes++;
    applyServerEvent((s) => {
      if (s.live === null || s.live.end !== undefined) return {};
      const now = Date.now();
      const l = s.live;
      return {
        live: {
          ...l,
          text: l.text + text,
          thinking: l.thinking + thinking,
          ...(text !== "" && l.firstTokenAt === undefined ? { firstTokenAt: now } : {}),
          ...(text !== "" && l.thinking + thinking !== "" && l.thinkingSecs === undefined ? { thinkingSecs: Math.max(1, Math.round((now - l.startedAt) / 1000)) } : {}),
        },
      };
    });
  }

  function dropDeltas(): void {
    if (raf !== 0) cancelAnimationFrame(raf);
    raf = 0;
    pendText = "";
    pendThinking = "";
  }

  function queueDelta(kind: "text" | "thinking", t: string): void {
    perf.deltas++;
    if (kind === "text") pendText += t;
    else pendThinking += t;
    if (raf === 0) raf = requestAnimationFrame(flushDeltas);
  }

  function onChatEvent(p: Payload<"chat.event">): void {
    const { turnId, threadId, event } = p;
    if (event.type === "start") confirmCopy(event.userMessage);
    const active = getState().runningTurns;
    if (event.type === "start" && !oldTurns.has(turnId) && active[threadId] !== turnId) {
      applyServerEvent({ runningTurns: { ...active, [threadId]: turnId } });
    } else if (event.type === "done" || event.type === "error") clearRunning(threadId, turnId);
    turnEvent(p);
  }

  /** Buffered words replay here, without reviving activity that already ended on the wire. */
  function turnEvent(p: Payload<"chat.event">): void {
    const { turnId, threadId, event } = p;
    const live = getState().live;
    // Pending sends own their events even after another chat takes the live
    // slot. Their acknowledgment binds the id before these events are replayed.
    const pending = (turn: LiveTurn | null) => turn !== null && turn.threadId === threadId && turn.turnId === null && turn.pendingUser !== null;
    if (!oldTurns.has(turnId) && (pending(live) || parked.some(pending))) {
      early.push(p);
      return;
    }
    const terminal = event.type === "done" || event.type === "error";
    const ours = live !== null && live.threadId === threadId && live.turnId === turnId;
    if (terminal) oldTurns.delete(turnId);
    const away = parked.findIndex((t) => t.turnId === turnId);
    if (away >= 0) return parkedEvent(away, event);
    if (!ours) return otherTurn(p);
    // the stopped turn has ended on the server: Retry may send again
    if (terminal && live.ending) applyServerEvent((s) => (s.live?.gen === live.gen ? { live: { ...s.live, ending: undefined } } : {}));
    switch (event.type) {
      case "start":
        noteMessage(threadId, event.userMessage);
        return applyServerEvent((s) => ({ messages: withMessage(s, threadId, event.userMessage),
          ...(s.live?.end?.kind === "error" && s.live.end.code === "closed"
            ? { live: { ...s.live, end: undefined, text: "", thinking: "", tools: [] } } : {}),
        }));
      case "delta": {
        const contextNotice = event.contextNotice;
        if (contextNotice) applyServerEvent(s => s.live ? { live: { ...s.live, contextNotice } } : {});
        if (event.text !== "") queueDelta("text", event.text);
        return;
      }
      case "thinking":
        return queueDelta("thinking", event.text);
      case "tool":
        flushDeltas();
        return applyServerEvent((s) => (s.live ? { live: { ...s.live, tools: upsertStep(s.live.tools, event.step) } } : {}));
      case "done": {
        // the saved message has every word: drop the waiting ones instead of
        // publishing them a moment before the row that replaces them (W-09)
        if (window.glPerf?.terminalFlush === true) {
          perf.flushes++;
          applyServerEvent((s) => ({ live: s.live === null ? null : { ...s.live } }));
        }
        const firstWordsWaiting = pendText !== "";
        dropDeltas();
        const msg = event.message;
        noteMessage(threadId, msg);
        applyServerEvent((s) => {
          const l = s.live;
          const firstAt = l?.firstTokenAt ?? (firstWordsWaiting ? Date.now() : undefined);
          const ft = l !== null && firstAt !== undefined ? { [msg.id]: firstAt - l.startedAt } : {};
          return {
            messages: withMessage(s, threadId, msg),
            firstToken: { ...s.firstToken, ...ft },
            live: null,
          };
        });
        invalidateFits();
        flushQueued();
        return;
      }
      case "error": {
        flushDeltas();
        const contextNotice = event.contextNotice;
        if (contextNotice) applyServerEvent(s => s.live ? { live: { ...s.live, contextNotice } } : {});
        holdQueue(threadId);
        const why = stopReason(event);
        if (event.code === "cancelled" && event.partial === undefined) {
          applyServerEvent((s) =>
            s.live && s.live.end === undefined ? { live: { ...s.live, end: { kind: "stopped", secs: Math.round((Date.now() - s.live.startedAt) / 1000) } } } : {},
          );
        } else if (event.partial !== undefined) {
          // the saved partial has every word the live turn showed: it takes the live turn's place
          dropDeltas();
          const { partial } = event;
          noteMessage(threadId, partial);
          applyServerEvent((s) => ({ messages: withMessage(s, threadId, partial), live: null, ...(why === undefined ? {} : { stopNotes: { ...s.stopNotes, [partial.id]: why } }) }));
        } else {
          applyServerEvent((s) => (s.live ? { live: { ...s.live, end: { kind: "error", code: event.code, message: why ?? event.message } } } : {}));
        }
        flushQueued();
        return;
      }
    }
  }

  /** An event of a turn running behind another chat: its words wait outside the store for openThread. */
  function parkedEvent(i: number, event: ChatEvent): void {
    const t = parked[i] as LiveTurn;
    const first = t.firstTokenAt === undefined ? { firstTokenAt: Date.now() } : {};
    switch (event.type) {
      case "delta":
        parked[i] = { ...t, ...(event.text !== "" ? first : {}), ...(event.contextNotice ? { contextNotice: event.contextNotice } : {}), text: t.text + event.text };
        return;
      case "thinking":
        parked[i] = { ...t, thinking: t.thinking + event.text };
        return;
      case "tool":
        parked[i] = { ...t, tools: upsertStep(t.tools, event.step) };
        return;
      case "done":
        parked.splice(i, 1);
        untrackedDone(t.threadId, event.message);
        invalidateFits();
        flushQueued();
        return;
      case "error":
        parked.splice(i, 1);
        holdQueue(t.threadId);
        if (event.partial !== undefined) keepStopped(t.threadId, t.userMessageId, event);
        else if (t.text !== "" || t.thinking !== "" || t.tools.length > 0) {
          keepStoppedWords({ ...t, ...(event.contextNotice ? { contextNotice: event.contextNotice } : {}), end: event.code === "cancelled" ? { kind: "stopped", secs: Math.round((Date.now() - t.startedAt) / 1000) } : { kind: "error", code: event.code, message: event.message } });
        } else if (event.code !== "cancelled") keepStopped(t.threadId, t.userMessageId, event);
        flushQueued();
        return;
    }
  }

  /** A turn that ended without being on screen: what it saved goes into its thread, with why it stopped under it. */
  function keepStopped(threadId: string, userMessageId: string | undefined, event: Extract<ChatEvent, { type: "error" }>): void {
    const { partial } = event;
    if (partial !== undefined) noteMessage(threadId, partial);
    const why = stopReason(event) ?? "The reply didn't finish.";
    const on = partial?.id ?? userMessageId;
    applyServerEvent((s) => ({
      ...(partial !== undefined && s.messages[threadId] !== undefined ? { messages: withMessage(s, threadId, partial) } : {}),
      ...(on === undefined ? {} : { stopNotes: { ...s.stopNotes, [on]: why } }),
    }));
  }

  /**
   * An event of a turn this client is not showing. A turn begun in the open
   * thread by another client (the same thread open on the phone and the
   * desktop) becomes the live turn here too and streams (PH-02). A joining client
   * gets the same start with a snapshot of words already sent; off-screen starts
   * remain parked until their chat is opened.
   */
  function otherTurn({ turnId, threadId, event }: Payload<"chat.event">): void {
    if (event.type === "done") return untrackedDone(threadId, event.message);
    // a partial saved by a turn stopped elsewhere; a turn this client stopped itself reloads on its next visit
    if (event.type === "error" && event.partial !== undefined) return keepStopped(threadId, undefined, event);
    if (event.type !== "start") return;
    if (oldTurns.has(turnId)) return;
    noteMessage(threadId, event.userMessage);
    const s = getState();
    const adopt = s.threadId === threadId && (s.live === null || (s.live.end !== undefined && s.live.ending !== true));
    const gen = ++turnGen;
    if (adopt) {
      retire(s.live);
      dropDeltas();
    }
    const start = Date.now();
    const turn: LiveTurn = { gen, threadId, turnId, userMessageId: event.userMessage.id, model: event.model, startedAt: start, thinking: "", text: "", tools: [], pendingUser: null };
    if (!adopt) parked.push(turn);
    applyServerEvent((st) => ({
      ...(st.messages[threadId] !== undefined ? { messages: withMessage(st, threadId, event.userMessage) } : {}),
      ...(adopt
        ? { live: turn }
        : {}),
    }));
  }

  /**
   * Send the next waiting message, oldest first, once nothing is in its way: one
   * at a time for this client, never past a message on hold or being edited
   * unless Send now asked for it.
   */
  function flushQueued(): void {
    const s = getState();
    if (!chatReady(s) || queueReason(s) !== null) return;
    const next = s.queued.find((q) => q.id !== s.editingQueued && (q.now === true || q.held !== true));
    const model = next?.model ?? s.model;
    if (next === undefined || model === undefined) return;
    if (next.now === true) {
      if (s.live?.threadId === next.threadId && (streaming(s) || s.live.ending === true)) return;
      void admit({ content: next.text, images: next.images, messageId: next.messageId, model, threadId: next.threadId, keepDraft: true, queuedId: next.id });
      return;
    }
    if (streaming(s) || s.live?.ending === true || parked.length > 0) return;
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
    const here = s.live?.threadId === q.threadId;
    if (here && (streaming(s) || s.live?.ending === true)) {
      const { held: _held, ...rest } = q;
      setState({ queued: [{ ...rest, now: true }, ...s.queued.filter((x) => x.id !== id)] });
      stop();
      return;
    }
    void admit({ content: q.text, images: q.images, messageId: q.messageId, model: q.model ?? s.model ?? "", threadId: q.threadId, keepDraft: true, queuedId: q.id });
  }

  function cancelQueuedEdit(): void {
    setState({ editingQueued: null, draft: "", draftImages: [] });
    flushQueued();
  }

  return {
    send, confirmStopAsk, repliesInProgress, stop, retry, sendQueuedNow, cancelQueuedEdit,
    onChatEvent, lostTurn, bringBack, flushQueued,
    hasParkedModel: (model: string) => parked.some((t) => t.model === model),
  };
}
