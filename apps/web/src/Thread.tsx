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
import { focusComposer } from "./Sidebar.tsx";
import { cancelImage, fileUrl, reloadThread, retry, retryImage } from "./session.ts";
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

function UserBubble({ text, time }: { text: string; time: string }) {
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
              setState({ draft: text });
              focusComposer(true);
            }}
          >
            <Icon id="pencil" />
          </button>
          <CopyButton text={text} />
        </div>
        <div className="bubble">{text}</div>
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

const AsstTurn = memo(function AsstTurn({ msg, last }: { msg: Message; last: boolean }) {
  countRender(msg.id);
  const catalog = useStore(catalogOf);
  const ft = useStore((s) => s.firstToken[msg.id]);
  const name = describeModel(msg.model ?? "", catalog).name;
  const queuedImage = msg.tools?.some(t => t.name === "image" && t.state === "done") === true;
  const messages = useStore(s => queuedImage ? s.messages[msg.threadId] ?? EMPTY : EMPTY);
  const allowedLinks = useMemo(() => imageTurnLinks(messages, msg.tools ?? []), [messages, msg.tools]);
  return (
    <div className="turn a done" tabIndex={0} aria-label="Reply">
      {msg.thinking ? <ThinkLine secs={ft === undefined ? undefined : Math.max(1, Math.round(ft / 1000))} text={msg.thinking} /> : null}
      {(msg.tools ?? []).filter(t => t.name !== "image" || t.state !== "done").map((t) => (
        <ToolRow key={t.callId} step={t} />
      ))}
      {msg.imageJob ? <ImageJob msg={msg} /> : msg.content !== "" ? <Markdown text={msg.content} allowedLinks={allowedLinks} /> : null}
      {(msg.imageJob ? [] : msg.images ?? []).map((p) => (
        <ImageOut key={p} path={p} />
      ))}
      {msg.imageJob || (msg.content === "" && msg.tools?.every(t => t.name === "image")) ? null : <ActRow text={msg.content} meta={replyMeta(name, msg, ft)} regen={last} />}
    </div>
  );
});

const UserTurn = memo(function UserTurn({ msg }: { msg: Message }) {
  countRender(msg.id);
  return <UserBubble text={msg.content} time={turnTime(msg.createdAt)} />;
});

/** The status row before the first token (F50): "Thinking · 3 s", counting from 1 s. While the model reasons, its icon is the thinking row's bulb. */
function Working({ startedAt, loading, thinking }: { startedAt: number; loading: boolean; thinking: boolean }) {
  const now = useTicker(250, true);
  const cpu = useStore((s) => noGpu(s.gpu));
  const secs = Math.floor((now - startedAt) / 1000);
  return (
    <div className={thinking ? "working thinking" : "working"}>
      {thinking ? <Icon id="bulb" /> : <Icon id="spin" cls="spin" />}
      <span className="ph">{loading ? (cpu ? "Loading into memory…" : "Loading into GPU memory…") : "Thinking"}</span>
      <span className="el">{secs >= 1 ? `· ${secs} s` : ""}</span>
    </div>
  );
}

/** Errors whose message is already the plain sentence to show. */
const SAYS_WHY = new Set(["context-too-small", "preempted", "runtime-changed"]);

function LiveTurnView({ threadId }: { threadId: string }) {
  const live = useStore((s) => (s.live?.threadId === threadId ? s.live : null));
  const catalog = useStore(catalogOf);
  const loading = useStore((s) => (s.live ? s.loads[s.live.model]?.state === "loading" : false));
  const messages = useStore(s => s.messages[threadId] ?? EMPTY);
  const allowedLinks = useMemo(() => imageTurnLinks(messages, live?.tools ?? []), [messages, live?.tools]);
  if (live === null) return null;
  const end = live.end;
  const name = describeModel(live.model, catalog).name;
  const running = live.tools.some((t) => t.state === "running");
  const showThink = live.thinking !== "" && (live.text !== "" || live.tools.length > 0 || end !== undefined);
  // whole blocks while it streams; everything once it ends for any reason
  const shown = reveal(live.text, end === undefined);
  return (
    <>
      {live.pendingUser !== null ? <UserBubble text={live.pendingUser} time={turnTime(live.startedAt)} /> : null}
      <div className={`turn a${end ? " done" : ""}`} tabIndex={0} aria-label="Reply">
        {showThink ? <ThinkLine secs={live.thinkingSecs ?? Math.max(1, Math.round(((live.firstTokenAt ?? Date.now()) - live.startedAt) / 1000))} text={live.thinking} /> : null}
        {live.tools.filter(t => t.name !== "image" || t.state !== "done").map((t) => (
          <ToolRow key={t.callId} step={t} stopped={end !== undefined} />
        ))}
        {shown !== "" ? <Markdown text={shown} live allowedLinks={allowedLinks} /> : null}
        {end === undefined && live.text !== "" ? (
          <div className="working writing" role="status">
            <span className="ph">Writing</span>
          </div>
        ) : null}
        {end === undefined && live.text === "" && !running ? <Working startedAt={live.startedAt} loading={loading} thinking={live.thinking !== ""} /> : null}
        {end?.kind === "stopped" ? (
          <div className="stopped">
            <span>Stopped after {end.secs} s</span>
            {/* off until the server has ended the stopped turn (W-02) */}
            <button type="button" className="qa" data-regen disabled={live.ending === true} onClick={retry}>
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
        {end ? <ActRow text={live.text} meta={name} regen={false} /> : null}
      </div>
    </>
  );
}

/** From this many messages, turns out of view skip rendering work (styles.css `.col.long`). */
const LONG_THREAD = 50;

/** The open thread: `.tl > .col`. Follows the end while the reader is near it (120 px). */
export function Timeline({ threadId }: { threadId: string }) {
  const messages = useStore((s) => s.messages[threadId] ?? EMPTY);
  const loadError = useStore((s) => s.loadErrors[threadId]);
  const stopNotes = useStore((s) => s.stopNotes);
  // 0 unless the perf spec's negative control is on (window.glRows.bustMemo)
  const bust = useStore((s) => (window.glRows?.bustMemo === true ? (s.live?.text.length ?? 0) : 0));
  const row = (m: Message) => (bust === 0 ? m : { ...m });
  const tl = useRef<HTMLDivElement>(null);
  const col = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastAsst = messages.findLastIndex((m) => m.role === "assistant");

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
    <div className="tl" ref={tl}>
      <div className={messages.length >= LONG_THREAD ? "col long" : "col"} ref={col}>
        {messages.map((m, i) => (
          <Fragment key={m.id}>
            {m.role === "user" ? <UserTurn msg={row(m)} /> : <AsstTurn msg={row(m)} last={i === lastAsst && i === messages.length - 1} />}
            {stopNotes[m.id] !== undefined ? (
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
        <LiveTurnView threadId={threadId} />
      </div>
    </div>
  );
}
