// Layout adapts T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.); full notice in LICENSES/T3-Code-MIT.txt.
// The thread timeline (shell.md F11, F40, F50, F56, F58, F60). Finished turns
// are memoised by message, so a streaming token re-renders only the live turn.
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Message, ToolStep } from "@gates-local/contracts";
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
import { NA, type State, setState, useStore } from "./store.ts";
import { closeTip, esc } from "./ui.tsx";

const EMPTY: readonly Message[] = [];
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

function UserBubble({ text, time, images = [] }: { text: string; time: string; images?: readonly string[] | undefined }) {
  return (
    <div className="turn u" tabIndex={0} aria-label="Your message">
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
              setState({ draft: text, draftImages: images });
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

function ThinkLine({ secs, text }: { secs: number | undefined; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="think" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="th-i">
          <Icon id="bulb" />
        </span>
        <span className="th-l">{secs === undefined ? "Show thinking" : `Thought for ${secs} s`}</span>
        <span className="th-x">
          <Icon id="down" />
        </span>
      </button>
      <div className="think-body">{text}</div>
    </>
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

/** A generated image from the server's /files route; a quiet placeholder when it is gone. */
function ImageOut({ path }: { path: string }) {
  const origin = useStore((s) => s.serverOrigin);
  const token = useStore((s) => s.fileToken);
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

function ImageJob({ msg }: { msg: Message }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acceptedRetry, setAcceptedRetry] = useState<string>();
  const job = msg.imageJob!;
  const retryId = job.retryJobId ?? acceptedRetry;
  const retried = useStore(s => retryId === undefined ? undefined : s.messages[msg.threadId]?.find(m => m.id === retryId)?.imageJob);
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
    {job.state === "done" && job.imagePath ? <ImageOut path={job.imagePath} /> : <div className="image-job-state" role="status">
      <Icon id={pending ? "spin" : "alert"} cls={pending ? "spin" : undefined} />
      <p>{pending ? label : job.message ?? "The image did not finish; try again."}</p>
      {job.state === "running" && (job.progress ?? 0) > 0 ? <span>{Math.round(job.progress! * 100)}%</span> : null}
      <button type="button" className="qa" disabled={busy || retryId !== undefined} onClick={() => void action()}>{retryId !== undefined ? retryLabel : busy && !pending ? "Retrying…" : pending ? "Cancel image" : "Try again"}</button>
      {error ? <p>{error}</p> : null}
    </div>}
  </div>;
}

const UserTurn = memo(function UserTurn({ msg }: { msg: Message }) {
  countRender(msg.id);
  return <UserBubble text={msg.content} images={msg.images} time={turnTime(msg.createdAt)} />;
});

/** The status row before the first token (F50): "Thinking · 3 s", counting from 1 s. While the model reasons, its icon is the thinking row's bulb. */
function Working({ startedAt, loading, thinking }: { startedAt: number; loading: boolean; thinking: boolean }) {
  const now = useTicker(250, true);
  const cpu = useStore((s) => noGpu(s.gpu));
  const imageBusy = useStore((s) => s.live?.turnId === null && s.imageStatus !== NA && s.imageStatus?.state === "busy");
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

/** One component owns a reply from its first delta through its saved message. */
const AsstTurn = memo(function AsstTurn({ threadId, msg, last }: { threadId: string; msg: Message | undefined; last: boolean }) {
  const live = useStore((s) => (msg === undefined && s.live?.threadId === threadId ? s.live : null));
  const catalog = useStore(catalogOf);
  const ft = useStore((s) => (msg === undefined ? undefined : s.firstToken[msg.id]));
  const loading = useStore((s) => live !== null && s.loads[live.model]?.state === "loading");
  const end = live?.end;
  const contextNotice = msg?.contextNotice ?? live?.contextNotice;
  const name = describeModel(msg?.model ?? live?.model ?? "", catalog).name;
  const text = msg?.content ?? live?.text ?? "";
  const thinking = msg?.thinking ?? live?.thinking ?? "";
  const tools = msg?.tools ?? live?.tools ?? [];
  const queuedImage = tools.some(t => t.name === "image" && t.state === "done");
  const messages = useStore(s => queuedImage ? s.messages[threadId] ?? EMPTY : EMPTY);
  const allowedLinks = useMemo(() => imageTurnLinks(messages, tools), [messages, tools]);
  const running = tools.some((t) => t.state === "running");
  const interrupted = msg?.interrupted === true;
  const streaming = live !== null && end === undefined;
  const showThink = thinking !== "" && (!streaming || text !== "" || tools.length > 0);
  const secs = live === null
    ? ft === undefined ? undefined : Math.max(1, Math.round(ft / 1000))
    : live.thinkingSecs ?? Math.max(1, Math.round(((live.firstTokenAt ?? Date.now()) - live.startedAt) / 1000));
  const paced = usePacedText(text, streaming);
  const pending = paced.length < text.length;
  const shown = reveal(paced, streaming || pending);
  if (msg === undefined && live === null) return null;
  if (msg !== undefined) countRender(msg.id);
  return (
    <>
      {live?.pendingUser != null ? <UserBubble text={live.pendingUser} images={live.pendingImages} time={turnTime(live.startedAt)} /> : null}
      <div className={`turn a${interrupted ? " interrupted" : streaming || pending ? "" : " done"}`} tabIndex={0} aria-label={interrupted ? "Interrupted reply" : "Reply"} data-received={text.length} data-revealed={paced.length}>
        {showThink ? <ThinkLine secs={secs} text={thinking} /> : null}
        {tools.filter(t => t.name !== "image" || t.state !== "done").map((t) => (
          <ToolRow key={t.callId} step={t} stopped={end !== undefined || interrupted} />
        ))}
        {msg?.imageJob ? <ImageJob msg={msg} /> : shown !== "" ? <Markdown text={shown} live={streaming || pending} allowedLinks={allowedLinks} /> : null}
        {contextNotice ? <p className="na" role="status">{contextNotice}</p> : null}
        {(msg?.imageJob ? [] : msg?.images ?? []).map((p) => <ImageOut key={p} path={p} />)}
        {(streaming || pending) && text !== "" ? (
          <div className="working writing" role="status">
            <span className="ph">Writing</span>
          </div>
        ) : null}
        {streaming && text === "" && !running ? <Working startedAt={live.startedAt} loading={loading} thinking={thinking !== ""} /> : null}
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
        {interrupted ? <div className="stop-note" role="status">Interrupted before this reply finished. Its text is kept here and excluded from later model prompts.</div> : null}
        {!streaming && !pending && !msg?.imageJob && !(text === "" && msg?.tools?.every(t => t.name === "image")) ? <ActRow text={text} meta={msg === undefined ? name : replyMeta(name, msg, ft)} regen={msg !== undefined && last} /> : null}
      </div>
    </>
  );
});

/** From this many messages, turns out of view skip rendering work (styles.css `.col.long`). */
const LONG_THREAD = 50;

/** The open thread: `.tl > .col`. Follows the end while the reader is near it (120 px). */
export function Timeline({ threadId }: { threadId: string }) {
  const messages = useStore((s) => s.messages[threadId] ?? EMPTY);
  const loading = useStore((s) => s.messages[threadId] === undefined && s.live?.threadId !== threadId);
  const loadError = useStore((s) => s.loadErrors[threadId]);
  const stopNotes = useStore((s) => s.stopNotes);
  // A refused admission can clear pendingUser without assigning a user ID.
  const liveOwner = useStore((s) => s.live?.threadId === threadId
    ? s.live.userMessageId ?? `pending:${s.live.gen}`
    : null);
  // 0 unless the perf spec's negative control is on (window.glRows.bustMemo)
  const bust = useStore((s) => (window.glRows?.bustMemo === true ? (s.live?.text.length ?? 0) : 0));
  const row = (m: Message) => (bust === 0 ? m : { ...m });
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
  }, []);

  return (
    <div className="tl" ref={tl} aria-busy={loading && loadError === undefined}>
      <div className={messages.length >= LONG_THREAD ? "col long" : "col"} ref={col}>
        {loading && loadError === undefined ? <p className="na" role="status" data-thread-loading>Loading conversation…</p> : null}
        {turns.map(({ msg: m, key }, i) => (
          <Fragment key={key}>
            {m?.role === "user" ? <UserTurn msg={row(m)} /> : <AsstTurn threadId={threadId} msg={m === undefined ? undefined : row(m)} last={i === messages.length - 1} />}
            {m !== undefined && stopNotes[m.id] !== undefined ? (
              <div className="stop-note" role="status">
                {stopNotes[m.id]}
              </div>
            ) : null}
          </Fragment>
        ))}
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
