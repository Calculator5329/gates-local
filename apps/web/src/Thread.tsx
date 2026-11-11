// Layout adapts T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.); full notice in LICENSES/T3-Code-MIT.txt.
// The thread timeline (shell.md F11, F40, F50, F56, F58, F60). A saved reply is
// props only and memoised by message, so a streaming token or a keystroke runs
// nothing in it; only the live reply reads the store and paces its text. A
// thread opens with its last turns mounted and adds the older ones when idle.
import { Fragment, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { CatalogEntry, Message, ToolStep } from "@gates-local/contracts";
import { useCopy } from "./copy.ts";
import { describeModel, noGpu, replyMeta, turnTime } from "./format.ts";
import { Icon } from "./icons.tsx";
import { Markdown } from "./markdown.tsx";
import { imageTurnLinks } from "./image-links.ts";
import { reveal } from "./reveal.ts";
import { usePacedText } from "./paced.ts";
import { focusComposer } from "./Sidebar.tsx";
import { cancelImage, fileUrl, reloadThread, retry, retryImage } from "./session.ts";
import { AttachmentImages } from "./attachment-images.tsx";
import { type LiveTurn, NA, type State, turnOf, useStore } from "./store.ts";
import { currentDraftKey, replaceDraft } from "./drafts.ts";
import { closeTip, esc } from "./ui.tsx";

const EMPTY: readonly Message[] = [];
const NO_TOOLS: readonly ToolStep[] = [];
const catalogOf = (s: State) => (s.catalog === NA ? undefined : s.catalog);

declare global {
  interface Window {
    /**
     * Test flag for test/e2e/perf.spec.ts. Set, every finished-turn render
     * counts under its message id; bustMemo hands each row a fresh message on
     * every live token, the regression the row-render gate must catch.
     */
    glRows?: { renders: Record<string, number>; bustMemo?: boolean };
  }
}

function countRender(id: string): void {
  const rows = window.glRows;
  if (rows !== undefined) rows.renders[id] = (rows.renders[id] ?? 0) + 1;
}

function useTicker(ms: number, on: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, on]);
  return now;
}

/** Copy, with the check-mark flash (F60): the icon and tip read "Copied" for 1.2 s. */
function CopyButton({ text }: { text: string }) {
  const [copied, copy] = useCopy(text, 1200);
  return (
    <>
      <button type="button" className="ibtn xs" data-copy data-tip={copied ? "Copied" : "Copy"} aria-label="Copy" onClick={copy}>
        <Icon id={copied ? "check" : "copy"} />
      </button>
      {copied === false ? <span className="na" role="status">Couldn't copy</span> : null}
    </>
  );
}

function ActRow({ text, meta, regen }: { text: string; meta: string; regen: boolean }) {
  // no hover on touch: the model and speed wait behind a tap so the row stays one line of icons
  const [details, setDetails] = useState(false);
  return (
    <div className={details ? "a-act det" : "a-act"}>
      <CopyButton text={text} />
      {regen ? (
        <button
          type="button"
          className="ibtn xs"
          data-regen
          data-tip="Regenerate"
          aria-label="Regenerate"
          onClick={() => {
            closeTip();
            retry();
          }}
        >
          <Icon id="redo" />
        </button>
      ) : null}
      <button type="button" className="ibtn xs a-det" aria-label="Reply details" aria-expanded={details} onClick={() => setDetails(!details)}>
        <Icon id="more" />
      </button>
      <span className="meta">{meta}</span>
    </div>
  );
}

function UserBubble({ text, time, images = [], noted = false }: { text: string; time: string; images?: readonly string[] | undefined; noted?: boolean }) {
  return (
    <div className={noted ? "turn u noted" : "turn u"} tabIndex={0} aria-label="Your message">
      <div className="u-row">
        <div className="u-act">
          <span className="tm">{time}</span>
          <button
            type="button"
            className="ibtn xs"
            data-edit
            data-tip="Edit"
            aria-label="Edit"
            onClick={() => {
              replaceDraft(currentDraftKey(), { text, images });
              focusComposer(true);
            }}
          >
            <Icon id="pencil" />
          </button>
          <CopyButton text={text} />
        </div>
        <div className="bubble">{images.length ? <div className="user-images"><AttachmentImages images={images} /></div> : null}{text}</div>
      </div>
    </div>
  );
}

/**
 * A reply's thought: one control from the first piece of thinking to the saved
 * reply. While the model thinks (`since`, when its turn started) it reads
 * "Thinking" and its text grows in place. It opens only when asked and stays as
 * the person left it when the reply starts and ends. Its seconds are hidden from
 * a screen reader, which hears one stable name.
 */
function ThinkLine({ secs, text, since }: { secs: number | undefined; text: string; since: number | undefined }) {
  const [open, setOpen] = useState(false);
  const body = useId();
  return (
    <>
      <button type="button" className={since === undefined ? "think" : "think live"} aria-expanded={open} aria-controls={body} onClick={() => setOpen(!open)}>
        <span className="th-i">
          <Icon id="bulb" />
        </span>
        {since === undefined ? <ThoughtLabel secs={secs} /> : <ThinkingLabel since={since} />}
        <span className="th-x">
          <Icon id="down" />
        </span>
      </button>
      <div className="think-body" id={body}>{text}</div>
    </>
  );
}

// Both labels share one grid cell, the other one hidden, so the pill is as wide
// as the wider of them before and after "Thinking" becomes "Thought for N s".
function ThinkingLabel({ since }: { since: number }) {
  const now = useTicker(250, true);
  const secs = Math.floor((now - since) / 1000);
  return (
    <span className="th-l">
      <span>Thinking{secs >= 1 ? <span aria-hidden="true">{` · ${secs} s`}</span> : null}</span>
      <span className="th-w" aria-hidden="true">{`Thought for ${Math.max(1, Math.round((now - since) / 1000))} s`}</span>
    </span>
  );
}

function ThoughtLabel({ secs }: { secs: number | undefined }) {
  return (
    <span className="th-l">
      <span>{secs === undefined ? "Show thinking" : `Thought for ${secs} s`}</span>
      <span className="th-w" aria-hidden="true">{`Thinking · ${secs ?? 1} s`}</span>
    </span>
  );
}

const TOOL_LABEL: Record<string, string> = { read: "Read", sql: "SQL", shell: "Shell", note: "Note", image: "Image" };
const toolLabel = (name: string) => TOOL_LABEL[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
const duration = (ms: number | undefined) => (ms === undefined ? "" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/** A tool step row; `stopped` marks a step that was running when the user pressed Stop. */
function ToolRow({ step, stopped }: { step: ToolStep; stopped?: boolean }) {
  const [open, setOpen] = useState(false);
  const st = stopped && step.state === "running" ? "rej" : step.state === "running" ? "run" : step.state === "error" ? "rej" : "done";
  const label = toolLabel(step.name);
  // the contract has no read-only flag yet; a `-readonly` flag in the call is the evidence the design's word rests on
  const ro = /(^|\s)-readonly(\s|$)/.test(step.detail ?? "") ? "read-only" : "";
  const lead = ro === "" ? label : `${label} · ${ro}`;
  const dur = duration(step.durationMs);
  const meta = st === "run" ? `${label} · running` : stopped && step.state === "running" ? "stopped" : step.state === "error" ? `${label} · failed` : dur === "" ? lead : null;
  const [cmd = "", ...rest] = (step.detail ?? "").split("\n");
  const out = rest.join("\n").trim();
  const toggle = () => setOpen(!open);
  return (
    <div
      className="wr"
      role="button"
      tabIndex={0}
      aria-expanded={open}
      data-tool-row
      onClick={(e) => {
        if (!(e.target instanceof Element && e.target.closest(".wr-body"))) toggle();
      }}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          toggle();
        }
      }}
    >
      <div className="wr-line">
        <span className="wr-st" data-st>
          {st === "run" ? <Icon id="spin" cls="spin" /> : <Icon id={st === "rej" ? "xc" : "checkc"} />}
        </span>
        <span className="wr-h">{step.summary}</span>
        {/* a phone's collapsed line keeps the time; the tool's name moves into the details */}
        <span className="wr-m">
          {meta ?? (
            <>
              <span className="wr-tool">{lead} · </span>
              {dur}
            </>
          )}
        </span>
        <span className="wr-x">
          <Icon id="down" />
        </span>
      </div>
      <div className="wr-body">
        {meta === null ? <p className="wr-who">{lead}</p> : null}
        {cmd !== "" ? (
          <p className="cmd">
            <span>$ </span>
            {cmd}
          </p>
        ) : null}
        {out !== "" ? <p className="out">{out}</p> : null}
      </div>
    </div>
  );
}

/** Where a reply's generated images come from: the server's /files route. The timeline reads it once for every row. */
interface Files {
  readonly origin: string | null;
  readonly token: string | null;
}

/** A generated image from the server's /files route; a quiet placeholder when it is gone. */
function ImageOut({ path, origin, token }: { path: string } & Files) {
  const [missing, setMissing] = useState(false);
  if (missing || origin === null) {
    return (
      <div className="img-miss">
        <Icon id="image" />
        Image not available
      </div>
    );
  }
  const src = fileUrl(origin, token, path);
  return <img className="img-out" src={src} alt="Generated image" loading="lazy" onError={() => setMissing(true)} />;
}

function ImageJob({ msg, thread, origin, token }: { msg: Message; thread: readonly Message[] } & Files) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acceptedRetry, setAcceptedRetry] = useState<string>();
  const job = msg.imageJob!;
  const retryId = job.retryJobId ?? acceptedRetry;
  const retried = retryId === undefined ? undefined : thread.find(m => m.id === retryId)?.imageJob;
  const retryLabel = retried?.state === "done" ? "Image ready" : retried?.state === "error" ? "Retry failed" : retried?.state === "cancelled" ? "Retry cancelled" : retried?.state === "queued" ? "Retry queued" : "Retrying…";
  const pending = job.state === "queued" || job.state === "running";
  const label = job.state === "queued" ? "Waiting for the GPU" : "Making image";
  const action = async () => {
    setBusy(true);
    if (pending) setError(await cancelImage(job.jobId));
    else {
      const result = await retryImage(msg.threadId, msg.content, job.jobId);
      if (typeof result === "string") setError(result);
      else { setError(null); setAcceptedRetry(result.jobId); }
    }
    setBusy(false);
  };
  return <div className="image-job" data-image-job={job.state} data-fit={job.errorKind === "wont-fit" ? "refuse" : undefined}>
    {job.state === "done" && job.imagePath ? <ImageOut path={job.imagePath} origin={origin} token={token} /> : <div className="image-job-state" role="status">
      <Icon id={pending ? "spin" : "alert"} cls={pending ? "spin" : undefined} />
      <p>{pending ? label : job.message ?? "The image did not finish; try again."}</p>
      {job.state === "running" && (job.progress ?? 0) > 0 ? <span>{Math.round(job.progress! * 100)}%</span> : null}
      <button type="button" className="qa" disabled={busy || retryId !== undefined} onClick={() => void action()}>{retryId !== undefined ? retryLabel : busy && !pending ? "Retrying…" : pending ? "Cancel image" : "Try again"}</button>
      {error ? <p>{error}</p> : null}
    </div>}
  </div>;
}

const UserTurn = memo(function UserTurn({ msg, noted }: { msg: Message; noted: boolean }) {
  countRender(msg.id);
  return <UserBubble text={msg.content} images={msg.images} time={turnTime(msg.createdAt)} noted={noted} />;
});

/** The status row before the first token (F50): "Thinking · 3 s", counting from 1 s. While the model reasons, its icon is the thinking row's bulb. */
function Working({ startedAt, loading, thinking }: { startedAt: number; loading: boolean; thinking: boolean }) {
  const now = useTicker(250, true);
  const cpu = useStore((s) => noGpu(s.gpu));
  const imageBusy = useStore((s) => s.threadId !== null && s.turns[s.threadId]?.turnId === null && s.imageStatus !== NA && s.imageStatus?.state === "busy");
  const secs = Math.floor((now - startedAt) / 1000);
  return (
    <div className={thinking ? "working thinking" : "working"}>
      {thinking ? <Icon id="bulb" /> : <Icon id="spin" cls="spin" />}
      <span className="ph">{imageBusy ? "Waiting for image generation…" : loading ? (cpu ? "Loading into memory…" : "Loading into GPU memory…") : thinking ? "Thinking" : "Waiting for Ollama…"}</span>
      <span className="el">{secs >= 1 ? `· ${secs} s` : ""}</span>
    </div>
  );
}

/** Errors whose message is already the plain sentence to show. */
const SAYS_WHY = new Set(["context-too-small", "preempted", "runtime-changed"]);
/** The model never sees an interrupted reply again, and nothing else on screen says so. */
const KEPT_OUT_OF_PROMPTS = "Its text is kept here and excluded from later model prompts.";

/** What a reply shows, the same while it is written and once it is saved. Props only: the caller reads the store and paces the text. */
interface ReplyView extends Files {
  readonly msg: Message | undefined;
  /** The reply being written, or the one that stopped before it saved; null for a saved reply. */
  readonly live: LiveTurn | null;
  readonly text: string;
  /** The part of `text` revealed so far. */
  readonly paced: string;
  readonly thinking: string;
  readonly tools: readonly ToolStep[];
  readonly secs: number | undefined;
  readonly contextNotice: string | undefined;
  readonly allowedLinks: ReadonlySet<string> | undefined;
  /** This session knows why the reply stopped; the timeline shows that note instead of the generic one. */
  readonly knownStop: boolean;
  readonly meta: string;
  readonly regen: boolean;
  /** The thread's messages when an image card needs them, else EMPTY. */
  readonly thread: readonly Message[];
  readonly loading: boolean;
}

function Reply({ msg, live, text, paced, thinking, tools, secs, contextNotice, allowedLinks, knownStop, meta, regen, thread, loading, origin, token }: ReplyView) {
  const end = live?.end;
  const running = tools.some((t) => t.state === "running");
  const interrupted = msg?.interrupted === true;
  const streaming = live !== null && end === undefined;
  // the model is thinking: the thought is the pill, and no status row says so again
  const thinkingNow = streaming && text === "" && tools.length === 0 && thinking !== "";
  const pending = paced.length < text.length;
  const shown = reveal(paced, streaming || pending);
  return (
    <div className={`turn a${interrupted ? " interrupted" : streaming || pending ? "" : " done"}${knownStop ? " noted" : ""}`} tabIndex={0} aria-label={interrupted ? "Interrupted reply" : "Reply"} data-received={text.length} data-revealed={paced.length}>
      {thinking !== "" ? <ThinkLine secs={secs} text={thinking} since={thinkingNow ? live.startedAt : undefined} /> : null}
      {tools.filter(t => t.name !== "image" || t.state !== "done").map((t) => (
        <ToolRow key={t.callId} step={t} stopped={end !== undefined || interrupted} />
      ))}
      {msg?.imageJob ? <ImageJob msg={msg} thread={thread} origin={origin} token={token} /> : shown !== "" ? <Markdown text={shown} live={streaming || pending} allowedLinks={allowedLinks} /> : null}
      {contextNotice ? <p className="na" role="status">{contextNotice}</p> : null}
      {(msg?.imageJob ? [] : msg?.images ?? []).map((p) => <ImageOut key={p} path={p} origin={origin} token={token} />)}
      {(streaming || pending) && text !== "" ? (
        <div className="working writing" role="status">
          <span className="ph">Writing</span>
        </div>
      ) : null}
      {streaming && text === "" && !running && !thinkingNow ? <Working startedAt={live.startedAt} loading={loading} thinking={thinking !== ""} /> : null}
      {end?.kind === "stopped" ? (
        <div className="stopped">
          <span>Stopped after {end.secs} s</span>
          {/* off until the server has ended the stopped turn (W-02) */}
          <button type="button" className="qa" data-regen disabled={live?.ending} onClick={retry}>
            Retry
          </button>
        </div>
      ) : null}
      {end?.kind === "error" ? (
        <div className="err-line" data-tip={esc(end.message)}>
          <Icon id="alert" cls="s14" />
          <span>{SAYS_WHY.has(end.code) ? end.message : end.code === "closed" ? "The connection dropped before this reply finished." : "The reply didn't finish."}</span>
          <button type="button" className="qa" onClick={retry}>
            Retry
          </button>
        </div>
      ) : null}
      {interrupted && !knownStop ? <div className="stop-note" role="status">Interrupted before this reply finished. {KEPT_OUT_OF_PROMPTS}</div> : null}
      {!streaming && !pending && !msg?.imageJob && !(text === "" && msg?.tools?.every(t => t.name === "image")) ? <ActRow text={text} meta={meta} regen={regen} /> : null}
    </div>
  );
}

interface RowProps extends Files {
  readonly msg: Message;
  readonly last: boolean;
  readonly thread: readonly Message[];
}

/**
 * The reply being written, and the same reply once it is saved: it keeps its
 * row, DOM and pacing through the save. Only this row reads the store and
 * paces text, and only a reply that was live while the timeline was open is one.
 */
const LiveReply = memo(function LiveReply({ threadId, msg, last, origin, token }: { threadId: string; msg: Message | undefined; last: boolean } & Files) {
  const live = useStore((s) => (msg === undefined ? turnOf(s, threadId) ?? null : null));
  const catalog = useStore(catalogOf);
  const ft = useStore((s) => (msg === undefined ? undefined : s.firstToken[msg.id]));
  const loading = useStore((s) => live !== null && s.loads[live.model]?.state === "loading");
  const name = describeModel(msg?.model ?? live?.model ?? "", catalog).name;
  const text = msg?.content ?? live?.text ?? "";
  const tools = msg?.tools ?? live?.tools ?? NO_TOOLS;
  const queuedImage = tools.some(t => t.name === "image" && t.state === "done");
  const messages = useStore(s => queuedImage ? s.messages[threadId] ?? EMPTY : EMPTY);
  const allowedLinks = useMemo(() => imageTurnLinks(messages, tools), [messages, tools]);
  const knownStop = useStore(s => msg !== undefined && s.stopNotes[msg.id] !== undefined);
  const secs = live === null
    ? ft === undefined ? undefined : Math.max(1, Math.round(ft / 1000))
    // stopped while thinking: the thought lasted until Stop, not until this render
    : live.thinkingSecs ?? (live.firstTokenAt === undefined && live.end?.kind === "stopped" ? Math.max(1, live.end.secs)
      : Math.max(1, Math.round(((live.firstTokenAt ?? Date.now()) - live.startedAt) / 1000)));
  const paced = usePacedText(text, live !== null && live.end === undefined);
  if (msg === undefined && live === null) return null;
  if (msg !== undefined) countRender(msg.id);
  return (
    <>
      {live?.pendingUser != null ? <UserBubble text={live.pendingUser} images={live.pendingImages} time={turnTime(live.startedAt)} /> : null}
      <Reply msg={msg} live={live} text={text} paced={paced} thinking={msg?.thinking ?? live?.thinking ?? ""} tools={tools} secs={secs}
        contextNotice={msg?.contextNotice ?? live?.contextNotice} allowedLinks={allowedLinks} knownStop={knownStop}
        meta={msg === undefined ? name : replyMeta(name, msg, ft)} regen={msg !== undefined && last} thread={messages} loading={loading} origin={origin} token={token} />
    </>
  );
});

/** A saved reply: props only, so a keystroke or a token elsewhere runs nothing here. */
const SavedReply = memo(function SavedReply({ msg, last, thread, catalog, ft, knownStop, origin, token }: RowProps & { catalog: readonly CatalogEntry[] | undefined; ft: number | undefined; knownStop: boolean }) {
  countRender(msg.id);
  const tools = msg.tools ?? NO_TOOLS;
  const allowedLinks = useMemo(() => imageTurnLinks(thread, tools), [thread, tools]);
  return (
    <Reply msg={msg} live={null} text={msg.content} paced={msg.content} thinking={msg.thinking ?? ""} tools={tools}
      secs={ft === undefined ? undefined : Math.max(1, Math.round(ft / 1000))} contextNotice={msg.contextNotice} allowedLinks={allowedLinks}
      knownStop={knownStop} meta={replyMeta(describeModel(msg.model ?? "", catalog).name, msg, ft)} regen={last} thread={thread} loading={false} origin={origin} token={token} />
  );
});

/** A row whose image card or image links read the rest of the thread. */
const readsThread = (m: Message) => m.imageJob !== undefined || (m.tools ?? NO_TOOLS).some(t => t.name === "image" && t.state === "done");

/** From this many messages, turns out of view skip rendering work (styles.css `.col.long`). */
const LONG_THREAD = 50;
/**
 * Turns mounted when a thread opens. The shortest turn, a one-line question or
 * a one-line reply with its action row, is about 70 px with its gap, so 40 fill
 * 1.7 screens of a 1,600 px tall window: the first frame is full and there is a
 * screen to scroll before the scroll handler mounts more. In a 2,000-message
 * thread that is 2% of the rows.
 */
const FIRST_TURNS = 40;
/** Turns added per idle slice, or per step while the reader scrolls up: no more than the first commit mounts. */
const SLICE_TURNS = 40;

/** The longest a slice waits for an idle moment before it mounts anyway. */
const IDLE_WAIT_MS = 100;
/** Idle time a further slice in the same callback needs: about what mounting 40 turns takes. */
const SLICE_MS = 16;

/**
 * Runs `fn` once the browser is idle, or after IDLE_WAIT_MS at most, with how
 * much of the idle period is left; a 50 ms timer with none left where there is
 * no requestIdleCallback (Safari). On an idle page a callback mounts slices
 * while the deadline has room. On a page that is never idle (a reply
 * streaming), each slice waits the full 100 ms: 2,000 turns are 49 slices, so
 * the thread is fully mounted about 5 s after it opens, plus the time the
 * slices take. A hidden tab runs neither idle callbacks nor these timers on
 * time, so nothing more mounts until the tab is seen again; nobody is reading
 * it meanwhile.
 */
function whenIdle(fn: (timeLeft: () => number) => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback((deadline) => fn(() => deadline.timeRemaining()), { timeout: IDLE_WAIT_MS });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(() => fn(() => 0), 50);
  return () => clearTimeout(id);
}

/** The open thread: `.tl > .col`. Follows the end while the reader is near it (120 px). */
export function Timeline({ threadId }: { threadId: string }) {
  const messages = useStore((s) => s.messages[threadId] ?? EMPTY);
  const loading = useStore((s) => s.messages[threadId] === undefined && turnOf(s, threadId) === undefined);
  const loadError = useStore((s) => s.loadErrors[threadId]);
  const stopNotes = useStore((s) => s.stopNotes);
  // A refused admission can clear pendingUser without assigning a user ID.
  const liveOwner = useStore((s) => {
    const turn = turnOf(s, threadId);
    return turn === undefined ? null : turn.userMessageId ?? `pending:${turn.gen}`;
  });
  // 0 unless the perf spec's negative control is on (window.glRows.bustMemo)
  const bust = useStore((s) => (window.glRows?.bustMemo === true ? (s.turns[threadId]?.text.length ?? 0) : 0));
  const row = (m: Message) => (bust === 0 ? m : { ...m });
  // what saved rows need from the store, read once here and passed down as props
  const catalog = useStore(catalogOf);
  const firstToken = useStore((s) => s.firstToken);
  const origin = useStore((s) => s.serverOrigin);
  const token = useStore((s) => s.fileToken);
  const tl = useRef<HTMLDivElement>(null);
  const col = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Image jobs have their own identity. The text reply belongs to its user
  // turn, even when a job is inserted between that user and the live reply.
  let owner: string | undefined;
  const turns: { msg: Message | undefined; key: string }[] = messages.map(msg => {
    if (msg.role === "user") owner = msg.id;
    return { msg, key: msg.role === "user" ? msg.id : msg.imageJob ? `image:${msg.id}` : `reply:${owner ?? msg.id}` };
  });
  if (liveOwner !== null) turns.push({ msg: undefined, key: `reply:${liveOwner}` });
  // A reply that was live while this timeline was open stays a LiveReply once
  // it is saved: a different component under its key would remount it.
  const [wasLive] = useState(() => new Set<string>());
  if (liveOwner !== null) wasLive.add(`reply:${liveOwner}`);

  // The first mounted turn, by key. Turns in front of it are held back. When it
  // leaves the thread (deleted), the first turn that was mounted and is still
  // there takes its place. Only when none was (at open, or when the history
  // replaces a cache that shares no turn with it) is everything but the last
  // FIRST_TURNS held back. A turn added at the end never unmounts one at the top.
  const [first, setFirst] = useState<string | null>(null);
  const turnsNow = useRef(turns);
  const skipNow = useRef(0);
  const opening = Math.max(0, turns.length - FIRST_TURNS);
  let at = first === null ? -1 : turns.findIndex((t) => t.key === first);
  if (at < 0 && first !== null) {
    // turnsNow and skipNow still hold the last render's turns and how many it held back
    const now = new Map(turns.map((t, i) => [t.key, i]));
    at = turnsNow.current.slice(skipNow.current).map((t) => now.get(t.key)).find((i) => i !== undefined) ?? -1;
  }
  const skip = at < 0 ? opening : Math.min(at, opening);
  const firstKey = turns[skip]?.key ?? null;
  if (firstKey !== null && firstKey !== first) setFirst(firstKey);
  turnsNow.current = turns;
  skipNow.current = skip;
  // The first mounted turn and its distance from the top of the view, noted after
  // each commit and scroll and just before a slice goes in. A distance in the
  // view, not in the content: when the browser's own scroll anchoring has
  // already kept the view still, the turn has not moved and nothing is added.
  const anchor = useRef<{ readonly el: Element; readonly off: number } | null>(null);
  const note = useCallback(() => {
    const top = col.current?.querySelector(".turn") ?? null;
    const view = tl.current;
    anchor.current = top === null || view === null ? null : { el: top, off: top.getBoundingClientRect().top - view.getBoundingClientRect().top };
  }, []);
  const grow = useCallback(() => {
    if (skipNow.current === 0) return;
    const key = turnsNow.current[Math.max(0, skipNow.current - SLICE_TURNS)]?.key;
    if (key === undefined) return;
    note();
    flushSync(() => setFirst(key));
  }, [note]);

  // Turns went in above the one that was first: put it back where it was, then note the new first.
  useLayoutEffect(() => {
    const el = tl.current;
    const a = anchor.current;
    if (el !== null && a !== null && a.el !== col.current?.querySelector(".turn") && col.current?.contains(a.el) === true) {
      // They are above the view this keeps still, so nobody sees them come in: no fade. Set before
      // the read below first styles them, a fade never starts; running ones kept frames going
      // through the backfill, each laying out and observing every mounted turn. React sets no
      // style on these elements, so the mark stays.
      for (let up = a.el.previousElementSibling; up !== null; up = up.previousElementSibling) {
        if (up instanceof HTMLElement) up.style.animation = "none";
      }
      const moved = a.el.getBoundingClientRect().top - el.getBoundingClientRect().top - a.off;
      if (moved !== 0) el.scrollTop += moved;
    }
    note();
  });

  // the rest of the thread mounts in idle time, so find-in-page and select-all see all of it
  useEffect(() => (first === null || skip === 0 ? undefined : whenIdle((timeLeft) => {
    do grow(); while (skipNow.current > 0 && timeLeft() > SLICE_MS);
  })), [first, skip, grow]);

  // a newly opened thread starts at its end
  useLayoutEffect(() => {
    const el = tl.current;
    if (el) el.scrollTop = el.scrollHeight;
    stick.current = true;
  }, [threadId]);

  useEffect(() => {
    const el = tl.current;
    const c = col.current;
    if (!el || !c) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      note();
      // within a screen of the turns not mounted yet: mount them now, not when idle
      if (el.scrollTop < el.clientHeight) grow();
    };
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(c);
    ro.observe(el);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", onScroll);
    };
  }, [grow, note]);

  return (
    <div className="tl" ref={tl} aria-busy={loading && loadError === undefined}>
      <div className={messages.length >= LONG_THREAD ? "col long" : "col"} ref={col}>
        {loading && loadError === undefined ? <p className="na" role="status" data-thread-loading>Loading conversation…</p> : null}
        {turns.slice(skip).map(({ msg: m, key }, j) => {
          const last = skip + j === messages.length - 1;
          return (
            <Fragment key={key}>
              {m?.role === "user" ? <UserTurn msg={row(m)} noted={stopNotes[m.id] !== undefined} />
                : m === undefined || wasLive.has(key) ? <LiveReply threadId={threadId} msg={m === undefined ? undefined : row(m)} last={last} origin={origin} token={token} />
                : <SavedReply msg={row(m)} last={last} thread={readsThread(m) ? messages : EMPTY} catalog={catalog} ft={firstToken[m.id]} knownStop={stopNotes[m.id] !== undefined} origin={origin} token={token} />}
              {m !== undefined && stopNotes[m.id] !== undefined ? (
                <div className="stop-note" role="status">
                  {m.interrupted === true ? `${stopNotes[m.id]} ${KEPT_OUT_OF_PROMPTS}` : stopNotes[m.id]}
                </div>
              ) : null}
            </Fragment>
          );
        })}
        {loadError !== undefined ? (
          <div className="err-line" role="status" data-load-error>
            <Icon id="alert" cls="s14" />
            <span>{loadError}</span>
            <button type="button" className="qa" onClick={() => reloadThread(threadId)}>
              Retry
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
