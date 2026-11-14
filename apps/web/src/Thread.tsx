// Layout adapts T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.); full notice in LICENSES/T3-Code-MIT.txt.
// The thread timeline (shell.md F11, F40, F50, F56, F58, F60). A saved reply is
// props only and memoised by message, so a streaming token or a keystroke runs
// nothing in it; only the live reply reads the store and paces its text. A
// thread opens with its last turns mounted and adds the older ones when idle.
import { Fragment, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { AttachedFile, ImageEvent, Message, ToolStep } from "@gates-local/contracts";
import { useCopy } from "./copy.ts";
import { noGpu, replyMeta, turnTime } from "./format.ts";
import { Icon } from "./icons.tsx";
import { Markdown } from "./markdown.tsx";
import { imageTurnLinks } from "./image-links.ts";
import { presetName, sizeLabel } from "./image-choice.ts";
import { reveal } from "./reveal.ts";
import { usePacedText } from "./paced.ts";
import { focusComposer } from "./Sidebar.tsx";
import { cancelImage, fileUrl, reloadThread, retry, retryImage } from "./session.ts";
import { AttachedFiles, AttachmentImages } from "./attachment-images.tsx";
import { type LiveTurn, NA, type State, type StopNote, turnOf, useStore } from "./store.ts";
import { workMsAt } from "./session/turn.ts";
import { type Drawn, type Rounds, drawTimes } from "./session/times.ts";
import { currentDraftKey, replaceDraft } from "./drafts.ts";
import { TurnSkel, closeTip, esc } from "./ui.tsx";
import { type Answerer, LIVE_QUESTION, modelChanges } from "./model-change.ts";
import { ModelChange } from "./ModelChange.tsx";

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
function CopyButton({ text, handle }: { text: string; handle: "reply" | "user-message" }) {
  const [copied, copy] = useCopy(text, 1200);
  return (
    <>
      <button type="button" className="ibtn xs" data-testid={`chat.copy.${handle}`} data-copy data-tip={copied ? "Copied" : "Copy"} aria-label="Copy" onClick={copy}>
        <Icon id={copied ? "check" : "copy"} />
      </button>
      {copied === false ? <span className="na" role="status">Couldn't copy</span> : null}
    </>
  );
}

/**
 * `stop`: a stopped reply's mark leads the row, its square always in view; a number is Stop's seconds, null no seconds
 * (a stop this session did not see, or one the thought's pill already timed). `regenOff`: Regenerate waits for the server to end the turn.
 */
function ActRow({ text, meta, regen, regenOff = false, stop }: { text: string; meta: string; regen: boolean; regenOff?: boolean | undefined; stop?: number | null | undefined }) {
  // no hover on touch: the model and speed wait behind a tap so the row stays one line of icons
  const [details, setDetails] = useState(false);
  return (
    <div className={`a-act${stop === undefined ? "" : " stop"}${details ? " det" : ""}`}>
      {stop === undefined ? null : <StopMark secs={stop ?? undefined} />}
      <CopyButton text={text} handle="reply" />
      {regen ? (
        <button
          type="button"
          className="ibtn xs"
          data-testid="chat.reply.regenerate"
          data-regen
          data-tip="Regenerate"
          aria-label="Regenerate"
          disabled={regenOff}
          onClick={() => {
            closeTip();
            retry();
          }}
        >
          <Icon id="redo" />
        </button>
      ) : null}
      <button type="button" className="ibtn xs a-det" data-testid="chat.reply.details" aria-label="Reply details" aria-expanded={details} onClick={() => setDetails(!details)}>
        <Icon id="more" />
      </button>
      <span className="meta">{meta}</span>
    </div>
  );
}

function UserBubble({ text, time, images = [], files = [], noted = false }: { text: string; time: string; images?: readonly string[] | undefined; files?: readonly AttachedFile[] | undefined; noted?: boolean }) {
  return (
    <div className={noted ? "turn u noted" : "turn u"} data-testid="chat.user-message.turn" tabIndex={0} aria-label="Your message">
      {/* the bubble, then its actions under it at its right edge; their row's space is always kept, so showing it moves nothing */}
      <div className="u-row">
        <div className="bubble">{images.length || files.length ? <div className="user-images"><AttachmentImages images={images} /><AttachedFiles files={files} /></div> : null}{text}</div>
        <div className="u-act">
          <span className="tm">{time}</span>
          <button
            type="button"
            className="ibtn xs"
            data-testid="chat.user-message.edit"
            data-edit
            data-tip="Edit"
            aria-label="Edit"
            onClick={() => {
              replaceDraft(currentDraftKey(), { text, images, files });
              focusComposer(true);
            }}
          >
            <Icon id="pencil" />
          </button>
          <CopyButton text={text} handle="user-message" />
        </div>
      </div>
    </div>
  );
}

/** What a finished reply's line holds; the face draws it and knows nothing else. */
interface ChipStep {
  /** Work seconds (decision 2): thinking plus tool time; undefined when not known (an older thread). */
  readonly secs: number | undefined;
  /** Tool calls; null when the reply has none. */
  readonly calls: number | null;
  /** Calls that failed (not ones a Stop cut short). */
  readonly failed: number;
}

/** A finished reply's work seconds, whole and at least 1; undefined when not known. */
const workSecs = (ms: number | undefined) => (ms === undefined ? undefined : Math.max(1, Math.round(ms / 1000)));

/** The widest words the live line says, so its box holds still (decision 6). */
const WIDEST = "Loading into GPU memory…";

/**
 * The one live line of a running reply (decisions 1, 2, 6, 33): the breathing dot the sidebar
 * shows, what the server's record says the reply is doing, its work seconds and the chevron. The
 * same nodes from the send to the end; only words and digits change. The words sit in a box as
 * wide as the widest stage, so the seconds and the chevron hold still; a longer tool summary ends
 * in "…". No number while it waits or loads: the work clock has not started.
 */
function LiveLine({ turn, tools, chevron }: { turn: LiveTurn; tools: readonly ToolStep[]; chevron: boolean }) {
  const stage = turn.reply?.stage ?? "waiting";
  const now = useTicker(250, stage === "waiting" || stage === "thinking" || stage === "tool");
  const cpu = useStore((s) => noGpu(s.gpu));
  // the send is answered at once, so the turn has its id while it waits behind a picture
  const imageBusy = useStore((s) => turn.pendingUser != null && s.imageStatus !== NA && s.imageStatus?.state === "busy");
  const t = Math.max(now, Date.now());
  const secs = stage === "waiting" || stage === "loading" ? 0 : Math.floor((workMsAt(turn, t) ?? 0) / 1000);
  const words = stage === "loading" ? (cpu ? "Loading into memory…" : WIDEST)
    : stage === "thinking" ? "Thinking"
    : stage === "tool" ? (tools.findLast((s) => s.state === "running") ?? tools.at(-1))?.summary ?? "Thinking"
    : stage === "writing" || stage === "ended" ? "Writing"
    // a wait under a second says nothing, so nothing flashes before the model answers
    : imageBusy ? "Waiting for an image" : t - turn.startedAt >= 1000 ? "Waiting" : "";
  return (
    <>
      <span className="run-dot" />
      <span className="lv-w">
        <span>{words}</span>
        <span className="lv-wide" aria-hidden="true">{WIDEST}</span>
      </span>
      <span className="lv-t">{secs >= 1 ? ` · ${secs} s` : ""}</span>
      <span className={chevron ? "th-x" : "th-x off"} aria-hidden="true"><Icon id="down" /></span>
    </>
  );
}

/** A finished reply's line in words: its work seconds and steps; at rest only the icon shows them (decision 3). */
function doneWords(step: ChipStep): string {
  if (step.calls === null) return step.secs === undefined ? "Thought" : `Thought for ${step.secs} s`;
  return `${step.secs === undefined ? "" : `${step.secs} s · `}${step.calls} step${step.calls === 1 ? "" : "s"}`;
}

/**
 * A finished reply's line (decision 3): at rest an icon and the chevron, the bulb for a thought,
 * the check for steps and the red alert when a step failed; the words come back on hover and on
 * keyboard focus, in the same place.
 */
function DoneLine({ step }: { step: ChipStep }) {
  const bad = step.failed > 0;
  return (
    <>
      <span className={bad ? "lv-i bad" : "lv-i"}><Icon id={bad ? "alert" : step.calls === null ? "bulb" : "check"} /></span>
      <span className="lv-h">
        {doneWords(step)}
        {bad ? <span className="lv-bad">{` · ${step.failed} failed`}</span> : null}
      </span>
      <span className="th-x"><Icon id="down" /></span>
    </>
  );
}

interface FoldProps {
  readonly thinking: string;
  /** The reply's calls; the server's notes are not calls and are not here. */
  readonly tools: readonly ToolStep[];
  /** The whole work seconds once the reply has ended; undefined when not known. */
  readonly secs: number | undefined;
  /** The reply still running, for its live line; null once it has ended. */
  readonly live: LiveTurn | null;
  /** Steps still running are stopped: Stop, an error or an interrupted save. */
  readonly stopped: boolean;
  /** The thinking rounds and where each call came; undefined when the server kept none (an older reply). */
  readonly rounds: Rounds | undefined;
}

/**
 * Everything a reply did before its answer, as one control from the send to the saved reply.
 * Closed, nothing is added under it; open (only when asked, and it stays as left), it is one list
 * in the order things happened: thinking rounds and one line per call. Where each call came in
 * the thinking is the server's record; an older reply lists its thought first, then its calls.
 */
function Fold({ thinking, tools, secs, live, stopped, rounds }: FoldProps) {
  const [open, setOpen] = useState(false);
  const [shut, setShut] = useState<Readonly<Record<number, boolean>>>({});
  const body = useId();
  const thinkingNow = live?.reply?.stage === "thinking";
  // the list in the order things happened: a thinking round before each call it led to
  const items: ({ kind: "think"; from: number; to: number } | { kind: "call"; step: ToolStep })[] = [];
  let from = 0;
  for (const s of tools) {
    const at = Math.min(rounds?.callsAt[s.callId] ?? thinking.length, thinking.length);
    if (at > from) items.push({ kind: "think", from, to: at });
    from = Math.max(from, at);
    items.push({ kind: "call", step: s });
  }
  if (thinking.length > from) items.push({ kind: "think", from, to: thinking.length });
  /** A round's seconds: its closed spans in the record; none when the record has none. */
  const roundSecs = (a: number, b: number) => {
    const spans = rounds?.spans.filter((s) => s.from >= a && s.from < b) ?? [];
    return spans.length === 0 ? undefined : Math.max(1, Math.round(spans.reduce((n, s) => n + s.ms, 0) / 1000));
  };
  const step: ChipStep = { secs, calls: tools.length === 0 ? null : tools.length, failed: live !== null ? 0 : tools.filter((s) => s.state === "error" && !cutByStop(s)).length };
  const line = <ToggleLine open={open} onToggle={() => setOpen(!open)} body={body} step={step} live={live} tools={tools} />;
  if (tools.length === 0) {
    return (
      <>
        {line}
        <div className="think-body" id={body}>{thinking}</div>
      </>
    );
  }
  return (
    <>
      {line}
      <div className="fold-body" id={body}>
        <ol className="fold-list" aria-label="Steps">
          {items.map((it, i) => it.kind === "call" ? (
            <li key={it.step.callId}><ToolRow step={it.step} stopped={stopped} /></li>
          ) : (
            <li key={`th-${it.from}`} className="fold-th">
              <ThoughtRound text={thinking.slice(it.from, it.to)}
                live={thinkingNow && i === items.length - 1}
                secs={roundSecs(it.from, it.to)}
                open={shut[it.from] ?? i === items.length - 1} onToggle={(o) => setShut({ ...shut, [it.from]: o })} />
            </li>
          ))}
        </ol>
      </div>
    </>
  );
}

/** A call the person's Stop (or a halt) cut short: saved as "error", which a build before the mark reads as failed, and marked stopped. */
function cutByStop(step: ToolStep): boolean {
  return step.state === "error" && step.stopped === true;
}

/**
 * The control that opens a reply's fold: the live line while the reply runs, the icon and chevron
 * once it has ended. A finished line's words hide at rest, so its name carries them; a running
 * line's name is the calls so far, which the line no longer draws, and never a ticking second.
 * `data-think`: the finished reply's work seconds, which the opened list splits by round.
 */
function ToggleLine({ open, onToggle, body, step, live, tools }: { open: boolean; onToggle: () => void; body: string; step: ChipStep; live: LiveTurn | null; tools: readonly ToolStep[] }) {
  const n = tools.length;
  const name = live !== null ? (n === 0 ? undefined : `Working, ${n} tool ${n === 1 ? "call" : "calls"}`)
    : doneWords(step) + (step.failed > 0 ? `, ${step.failed} failed` : "");
  return (
    <div className={open ? "fold-line open" : "fold-line"}>
      <button type="button" className={live !== null ? "think fold run" : "think fold"} data-testid="chat.fold.toggle" aria-expanded={open} aria-controls={body}
        aria-label={name} data-think={live === null ? step.secs : undefined} onClick={onToggle}>
        {live !== null ? <LiveLine turn={live} tools={tools} chevron /> : <DoneLine step={step} />}
      </button>
    </div>
  );
}

/** One thinking round in the open fold: its text, growing live; once the next step starts it closes to the bulb and "6 s" and reopens on a click. */
function ThoughtRound({ text, live, secs, open, onToggle }: { text: string; live: boolean; secs: number | undefined; open: boolean; onToggle: (open: boolean) => void }) {
  const id = useId();
  return (
    <>
      <button type="button" className="th-line" data-testid="chat.fold.thinking" aria-expanded={open} aria-controls={id}
        aria-label={live ? "Thinking" : secs === undefined ? "Thought" : `Thought for ${secs} s`} onClick={() => onToggle(!open)}>
        <span className="wr-st">
          <Icon id="bulb" />
        </span>
        {/* the bulb says thought: the round says its seconds once */}
        <span className="wr-h">{live ? "Thinking" : secs === undefined ? "Thought" : `${secs} s`}</span>
        <span className="wr-x">
          <Icon id="down" />
        </span>
      </button>
      <div className="think-body" id={id}>{text}</div>
    </>
  );
}

const TOOL_LABEL: Record<string, string> = { read: "Read", sql: "SQL", shell: "Shell", note: "Note", image: "Image" };
const toolLabel = (name: string) => TOOL_LABEL[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
const duration = (ms: number | undefined) => (ms === undefined ? "" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/**
 * A step's call as a person reads it. The saved detail's first line is the call
 * as JSON ({"name":"shell","input":{"command":…}}): a shell call shows its
 * command after "$", another call its query, path or prompt. A line that is not
 * such JSON (an older step cut at 2,000 characters) is shown as saved.
 */
function callLine(line: string): { cmd: string; shell: boolean } {
  try {
    const call: unknown = JSON.parse(line);
    const input = typeof call === "object" && call !== null ? (call as { input?: unknown }).input : undefined;
    if (typeof input === "object" && input !== null) {
      const i = input as Record<string, unknown>;
      if (typeof i["command"] === "string") return { cmd: i["command"], shell: true };
      // an image call's prompts, one per line (an older step saved one prompt)
      const prompts = Array.isArray(i["prompts"]) && i["prompts"].every((p) => typeof p === "string") ? i["prompts"].join("\n") : undefined;
      const arg = [i["query"], i["path"], i["prompt"], prompts].find((v) => typeof v === "string");
      if (typeof arg === "string") return { cmd: arg, shell: false };
    }
  } catch {
    // not JSON: shown as it is
  }
  return { cmd: line, shell: true };
}

/** A tool step row; `stopped` marks a step that was running when the user pressed Stop. */
function ToolRow({ step, stopped }: { step: ToolStep; stopped?: boolean }) {
  const [open, setOpen] = useState(false);
  // cut short by Stop: live (a running step in a stopped turn) or saved (an "error" marked stopped)
  const cut = cutByStop(step) || (stopped === true && step.state === "running");
  // "rej" is a failed step, drawn red; a step Stop cut short keeps the grey mark
  const st = cut ? "cut" : step.state === "running" ? "run" : step.state === "error" ? "rej" : "done";
  const label = toolLabel(step.name);
  // the contract has no read-only flag yet; a `-readonly` flag in the call is the evidence the design's word rests on
  const ro = /(^|\s)-readonly(\s|$)/.test(step.detail ?? "") ? "read-only" : "";
  const lead = ro === "" ? label : `${label} · ${ro}`;
  const dur = duration(step.durationMs);
  // the summary is said once: "Read notes.md" needs no "Read ·" after it
  const named = step.summary.toLowerCase().startsWith(label.toLowerCase());
  const [line = "", ...rest] = (step.detail ?? "").split("\n");
  const { cmd, shell } = callLine(line);
  // a failed step is its call with the red mark, never "Tool could not finish" (chat row 37)
  const failed = step.state === "error" && !cut;
  const heading = !failed ? step.summary : cmd !== "" ? cmd : label;
  const meta = st === "run" ? (named ? "running" : `${label} · running`) : cut ? (named ? "stopped" : `${label} · stopped`) : failed ? (cmd !== "" ? lead : dur) : dur === "" ? lead : null;
  const out = rest.join("\n").trim();
  const toggle = () => setOpen(!open);
  return (
    <div
      className="wr"
      data-testid="chat.tool-call.toggle"
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
        <span className="wr-st" data-st={st}>
          {/* a running call carries the one working mark (decision 1), never a spinner */}
          {st === "run" ? <span className="run-dot" /> : <Icon id={st === "done" ? "checkc" : "xc"} />}
        </span>
        <span className="wr-h">{heading}</span>
        {/* a phone's collapsed line keeps the time; the tool's name moves into the details */}
        <span className="wr-m">
          {meta ?? (
            <>
              {named ? null : <span className="wr-tool">{lead} · </span>}
              {dur}
            </>
          )}
        </span>
        <span className="wr-x">
          <Icon id="down" />
        </span>
      </div>
      {/* one box up to 360 px: longer output scrolls inside it, by wheel or keys; the wheel goes on to the page at its ends */}
      <div className="wr-body" data-testid="chat.tool-call.body" tabIndex={open ? 0 : -1} aria-label={`${heading}: details`}>
        {meta === null ? <p className="wr-who">{lead}</p> : null}
        {cmd !== "" ? (
          <p className="cmd">
            {shell ? <span>$ </span> : null}
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

/** A retry this client started, from the job it retries, until the thread's copy names it. */
interface Accepted { readonly from: string; readonly to: string }

/**
 * The job a card shows: the newest of its retry chain. A retry is a card message
 * of its own (the server's claimImageRetry), but it takes over the box of the
 * card it retries; the Timeline does not render it as a row.
 */
export function chainEnd(first: ImageEvent, thread: readonly Message[], accepted?: Accepted): ImageEvent {
  let job = first;
  const seen = new Set([job.jobId]);
  for (;;) {
    const next = job.retryJobId ?? (accepted?.from === job.jobId ? accepted.to : undefined);
    if (next === undefined || seen.has(next)) return job;
    seen.add(next);
    // accepted, and the thread has not caught up yet: it is waiting to start
    job = thread.find(m => m.id === next)?.imageJob ?? { jobId: next, state: "queued", ...(job.choice ? { choice: job.choice } : {}) };
  }
}

/**
 * Card messages drawn in another card's box, so the Timeline gives them no row: a retry (the first
 * card's box), and every picture of a several-picture send after its first (a tile of that card).
 */
export function retryRows(thread: readonly Message[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const m of thread) {
    if (m.imageJob?.retryJobId !== undefined) ids.add(m.imageJob.retryJobId);
    if (m.imageJob?.group !== undefined && m.imageJob.group.index > 0) ids.add(m.id);
  }
  return ids;
}

/** The cards of `first`'s group, in picture order; just `first` when it is a picture of its own. */
export function groupCards(first: Message, thread: readonly Message[]): readonly Message[] {
  const group = first.imageJob?.group;
  if (group === undefined) return [first];
  return thread.filter((m) => m.imageJob?.group?.id === group.id).toSorted((a, b) => a.imageJob!.group!.index - b.imageJob!.group!.index);
}

/** A several-picture card's top line: "1 of 2 making…" while any runs, "4 of 4 · 23 s" (ComfyUI's time for all) once none does. */
export function groupWords(jobs: readonly ImageEvent[], of: number): string {
  const done = jobs.filter((j) => j.state === "done");
  if (jobs.some((j) => j.state === "queued" || j.state === "running")) return `${done.length} of ${of} making…`;
  const ms = done.reduce((sum, j) => sum + (j.runMs ?? Number.NaN), 0);
  return Number.isNaN(ms) || done.length === 0 ? `${done.length} of ${of}` : `${done.length} of ${of} · ${Math.max(1, Math.round(ms / 1000))} s`;
}

/** One card per send: a picture of its own, or the tiles of a send that made several (2 side by side, 3 or 4 two by two). */
function ImageCard({ msg, thread, origin, token }: { msg: Message; thread: readonly Message[] } & Files) {
  const group = msg.imageJob!.group;
  if (group === undefined) return <ImageJob msg={msg} thread={thread} origin={origin} token={token} />;
  return <ImageGroup first={msg} thread={thread} origin={origin} token={token} />;
}

function ImageGroup({ first, thread, origin, token }: { first: Message; thread: readonly Message[] } & Files) {
  const cards = groupCards(first, thread);
  const of = first.imageJob!.group!.of;
  const jobs = cards.map((m) => chainEnd(m.imageJob!, thread));
  const choice = first.imageJob!.sent ?? first.imageJob!.choice;
  const model = useStore((s) => (choice === undefined ? undefined : presetName(s, choice.preset)));
  return (
    <div className="image-group" data-image-group={first.imageJob!.group!.id} data-n={of}>
      <p className="image-group-head">{model === undefined ? null : <>{model} · {sizeLabel(choice!.width, choice!.height)} · </>}{groupWords(jobs, of)}</p>
      <div className="image-tiles">
        {cards.map((m) => <ImageJob key={m.id} msg={m} thread={thread} origin={origin} token={token} tile />)}
      </div>
    </div>
  );
}

/** What a pending card is doing, as a screen reader hears it: steady words, not the ticking line. */
function jobWords(job: ImageEvent): string {
  if (job.phase === "freeing") return "Freeing memory";
  if (job.state === "queued") return "Waiting for the GPU";
  return "Making image";
}

/**
 * A pending card's stage, only as the engine reported it (WIN-MEM-06): its queue, a model load,
 * the prompt read, each sampling step, the decode. With nothing reported, only that it works.
 * A load before any sampling is the one place the first run's wait is explained.
 */
export function stageWords(job: ImageEvent, sampled: boolean): string {
  if (job.phase === "freeing") return "Freeing memory";
  if (job.state === "queued") return "Waiting for the GPU";
  switch (job.stage) {
    case "queued": return "In the queue";
    case "loading": return sampled ? "Loading the model" : "First run: loading the model";
    case "encoding": return "Reading the prompt";
    case "sampling": return job.steps === undefined ? "Sampling" : `Sampling ${job.steps.done}/${job.steps.total}`;
    case "decoding": return "Decoding";
    default: return "Working";
  }
}

/** A pending card's live line, in a chat reply's form: a lit dot, the stage, the running time. Only words and digits change. */
function JobLine({ job, since }: { job: ImageEvent; since: number }) {
  const now = useTicker(1000, true);
  const [sampled, setSampled] = useState(false);
  useEffect(() => { if (job.stage === "sampling" || job.stage === "decoding") setSampled(true); }, [job.stage]);
  const secs = Math.max(0, Math.floor((now - since) / 1000));
  return <p className="image-job-live" aria-hidden="true"><i className="lv-dot" /><span className="lv-w">{stageWords(job, sampled)}</span><span className="lv-t">{` · ${secs} s`}</span></p>;
}

/** The first card after the user message an Image turn sent: the card that turn's Stop cancels. */
function turnCard(thread: readonly Message[], userMessageId: string): string | undefined {
  const at = thread.findIndex((m) => m.id === userMessageId);
  return at < 0 ? undefined : thread.slice(at + 1).find((m) => m.imageJob !== undefined)?.id;
}

/** `tile`: one picture of a several-picture card, whose top line names the model and size once for all. */
function ImageJob({ msg, thread, origin, token, tile = false }: { msg: Message; thread: readonly Message[]; tile?: boolean } & Files) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<Accepted>();
  const job = chainEnd(msg.imageJob!, thread, accepted);
  const pending = job.state === "queued" || job.state === "running";
  // the picture's own size from the first moment, and the first card's for its whole retry chain:
  // a retry of a default can run another size (the default settles to the files ComfyUI has),
  // and the box never changes when a retry takes over; that picture is fitted inside. A job that
  // settles to another size keeps the shape it was first drawn with (`sent`) the same way.
  const choice = msg.imageJob!.sent ?? msg.imageJob!.choice ?? job.choice;
  const size = choice ? { aspectRatio: `${choice.width} / ${choice.height}`, ...tile ? {} : { width: `${choice.width}px` } } : undefined;
  // what the job runs (or ran): the end of its retry chain, after any settling
  const ran = job.choice ?? msg.imageJob!.choice;
  const model = useStore((s) => (ran === undefined ? undefined : presetName(s, ran.preset)));
  // An Image turn's own card is cancelled by the composer's Stop, so the card offers no second way;
  // a card the chat model's tool or a retry started has no Stop and keeps its Cancel.
  const turn = useStore((s) => turnOf(s, msg.threadId));
  const head = turn?.image === true && turn.end === undefined && turn.userMessageId !== undefined ? turnCard(thread, turn.userMessageId) : undefined;
  // every tile of the turn's card: Stop cancels those not done
  const stopCovers = pending && head !== undefined && (head === msg.id || (msg.imageJob!.group !== undefined && thread.find((m) => m.id === head)?.imageJob?.group?.id === msg.imageJob!.group.id));
  const since = thread.find((m) => m.id === job.jobId)?.createdAt ?? msg.createdAt;
  // A prompt the chat model wrote is said under its card; an Image turn's prompt is the person's own
  // message just above, so it is not said twice.
  const at = thread.findIndex((m) => m.id === msg.id);
  const asked = thread.slice(0, Math.max(0, at)).findLast((m) => m.role === "user")?.content;
  const caption = msg.content.trim() !== "" && msg.content !== asked ? msg.content : undefined;
  const action = async () => {
    setBusy(true);
    if (pending) setError(await cancelImage(job.jobId));
    else {
      const result = await retryImage(msg.threadId, msg.content, job.jobId);
      if (typeof result === "string") setError(result);
      else { setError(null); setAccepted({ from: job.jobId, to: result.jobId }); }
    }
    setBusy(false);
  };
  // No ComfyUI to draw with: one line says so, where a picture-sized box would promise a picture.
  const line = job.state === "error" && job.errorKind === "image-missing";
  const card = <div className={line ? "image-job line" : "image-job"} style={line ? undefined : size} data-job={job.jobId} data-image-job={job.state} data-fit={job.state === "error" && job.errorKind === "wont-fit" ? "refuse" : undefined}>
    {/* the model and size belong to the result: while it runs the composer already names them */}
    {ran === undefined || pending || line || tile ? null : <span className="image-job-model">{model} · {sizeLabel(ran.width, ran.height)}</span>}
    {job.state === "done" && job.imagePath ? <ImageOut path={job.imagePath} origin={origin} token={token} /> : <div className="image-job-state" role="status" aria-label={pending ? jobWords(job) : undefined}>
      {pending ? <JobLine job={job} since={since} /> : <><Icon id="alert" /><p>{job.message ?? "The image did not finish; try again."}</p></>}
      {stopCovers ? null : <button type="button" className="qa" data-testid="chat.image-job.action" disabled={busy} onClick={() => void action()}>{pending ? "Cancel image" : "Try again"}</button>}
      {error ? <p>{error}</p> : null}
    </div>}
  </div>;
  return caption === undefined ? card : <figure className="image-job-fig">{card}<figcaption className="image-job-prompt">{caption}</figcaption></figure>;
}

const UserTurn = memo(function UserTurn({ msg, noted }: { msg: Message; noted: boolean }) {
  countRender(msg.id);
  return <UserBubble text={msg.content} images={msg.images} files={msg.files} time={turnTime(msg.createdAt)} noted={noted} />;
});

/** The model never sees a stopped reply again; the stop square's tooltip and name are the one place that says so. */
const UNSEEN = "Stopped. The model won't see this reply.";

/** A stopped reply's mark: the stop square, then the seconds when the person pressed Stop. */
function StopMark({ secs }: { secs?: number | undefined }) {
  return (
    <span className="stop-mark">
      {/* focusable, so the keyboard reaches the one place that says the model won't see this reply */}
      <span role="img" data-testid="chat.reply.unseen-mark" tabIndex={0} aria-label={UNSEEN} data-tip={esc(UNSEEN)} />
      {secs === undefined ? null : <span className="s">{secs} s</span>}
    </span>
  );
}

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
  /** The thinking rounds and where each call came, from the server's record. */
  readonly rounds: Rounds | undefined;
  /** The work seconds once the reply has ended; undefined when not known. */
  readonly secs: number | undefined;
  readonly allowedLinks: ReadonlySet<string> | undefined;
  /** Why this session saw the reply stop: Stop's seconds go in the actions row, a reason's words in the timeline's note under the turn. */
  readonly note: StopNote | undefined;
  readonly meta: string;
  readonly regen: boolean;
  /** The thread's messages when an image card needs them, else EMPTY. */
  readonly thread: readonly Message[];
  /** The row was live on this screen: a reply with no fold keeps its line's slot once it ends, so the words under it do not move up. */
  readonly slot?: boolean;
}

/** Errors whose message is already the plain sentence to show. */
const SAYS_WHY = new Set(["context-too-small", "preempted", "runtime-changed"]);

/**
 * A reply that did not finish (decision 7): the alert, the short words and Retry; the runtime's own
 * text is in the tip. The server has already tried it a second time. Never the stop square.
 */
function FailLine({ words, why, retryable }: { words: string; why: string; retryable: boolean }) {
  return (
    <div className="err-line" data-testid="chat.reply.failed" data-tip={why === "" ? undefined : esc(why)}>
      <Icon id="alert" cls="s14" />
      <span>{words}</span>
      {retryable ? (
        <button type="button" className="qa" data-testid="chat.reply.retry" onClick={retry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

function Reply({ msg, live, text, paced, thinking, tools, rounds, secs, allowedLinks, note, meta, regen, thread, slot = false, origin, token }: ReplyView) {
  const end = live?.end;
  const interrupted = msg?.interrupted === true;
  // a reason in words has its own note under the turn; otherwise a saved stopped reply carries the square, with Stop's seconds when this session saw them
  const knownStop = note?.kind === "said";
  // the server's note (answered without tools) is not a call: it stays the plain line it was, outside the fold
  const notes = useMemo(() => tools.filter((t) => t.name === "note"), [tools]);
  const calls = useMemo(() => (notes.length === 0 ? tools : tools.filter((t) => t.name !== "note")), [tools, notes]);
  // stopped while thinking, with no calls and no words, the pill holds the time and the square has no second copy;
  // with calls the bulb keeps the thinking and the square keeps Stop's seconds
  const foldTimed = calls.length === 0 && text === "" && thinking !== "";
  // the same mark while the stopped turn is live and once its saved row takes over
  const stopSecs = end?.kind === "stopped" ? end.secs : note?.kind === "stopped" ? note.secs : undefined;
  const stop = stopSecs !== undefined ? (foldTimed ? null : stopSecs) : interrupted && note === undefined ? null : undefined;
  const streaming = live !== null && end === undefined;
  const pending = paced.length < text.length;
  const shown = reveal(paced, streaming || pending);
  const folded = thinking !== "" || calls.length > 0;
  return (
    <div className={`turn a${interrupted ? " interrupted" : streaming || pending ? "" : " done"}${knownStop ? " noted" : ""}`} data-testid="chat.reply.turn" tabIndex={0} aria-label={interrupted ? "Interrupted reply" : "Reply"} data-received={text.length} data-revealed={paced.length}>
      {/* one line at the top from the send to the saved row (decisions 1 and 33): "Writing" sits above the words (chat row 30) */}
      {folded ? (
        <Fold thinking={thinking} tools={calls} secs={secs} live={streaming ? live : null} stopped={end !== undefined || interrupted} rounds={rounds} />
      ) : streaming ? (
        <div className="fold-line"><div className="think fold run"><LiveLine turn={live} tools={calls} chevron={false} /></div></div>
      ) : slot ? <div className="fold-line slot" aria-hidden="true" /> : null}
      {notes.map((t) => <ToolRow key={t.callId} step={t} stopped={end !== undefined || interrupted} />)}
      {msg?.imageJob ? <ImageCard msg={msg} thread={thread} origin={origin} token={token} /> : shown !== "" ? <Markdown text={shown} live={streaming || pending} allowedLinks={allowedLinks} /> : null}
      {(msg?.imageJob ? [] : msg?.images ?? []).map((p) => <ImageOut key={p} path={p} origin={origin} token={token} />)}
      {end?.kind === "error" ? (
        <FailLine words={SAYS_WHY.has(end.code) ? end.message : end.code === "closed" ? "The connection dropped before this reply finished." : "The reply didn't finish."}
          why={end.message} retryable />
      ) : note?.kind === "failed" ? <FailLine words="The reply didn't finish." why={note.why} retryable={regen} /> : null}
      {!streaming && !pending && !msg?.imageJob && !(text === "" && msg?.tools?.every(t => t.name === "image")) ? (
        // a stopped turn draws the row its saved reply will draw; Regenerate is off until the server has ended the turn (W-02)
        <ActRow text={text} meta={meta} regen={regen} regenOff={live?.ending === true} stop={stop} />
      ) : null}
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
  // the saved row's times are the server's, the same in every window and after a reload (chat row 32)
  const saved = msg === undefined ? undefined : drawTimes(msg, catalog);
  const rounds = msg === undefined ? live?.reply : saved?.rounds;
  const text = msg?.content ?? live?.text ?? "";
  const tools = msg?.tools ?? live?.tools ?? NO_TOOLS;
  const queuedImage = tools.some(t => t.name === "image" && t.state === "done");
  const messages = useStore(s => queuedImage ? s.messages[threadId] ?? EMPTY : EMPTY);
  const allowedLinks = useMemo(() => imageTurnLinks(messages, tools), [messages, tools]);
  const note = saved?.note;
  // the server's work time: the saved row's, or the record held still where the turn ended here
  const workMs = live === null ? saved?.workMs : live.end === undefined ? undefined : workMsAt(live, Date.now());
  const paced = usePacedText(text, live !== null && live.end === undefined);
  if (msg === undefined && live === null) return null;
  // An Image turn's reply is its picture card, a row of its own with its progress and Cancel:
  // the turn shows its question until that is saved, and nothing of a chat reply.
  if (msg === undefined && live?.image === true) return live.pendingUser != null ? <UserBubble text={live.pendingUser} images={live.pendingImages} files={live.pendingFiles} time={turnTime(live.startedAt)} /> : null;
  if (msg !== undefined) countRender(msg.id);
  return (
    <>
      {live?.pendingUser != null ? <UserBubble text={live.pendingUser} images={live.pendingImages} files={live.pendingFiles} time={turnTime(live.startedAt)} /> : null}
      <Reply msg={msg} live={live} text={text} paced={paced} thinking={msg?.thinking ?? live?.thinking ?? ""} tools={tools} rounds={rounds} secs={workSecs(workMs)}
        allowedLinks={allowedLinks} note={note} meta={replyMeta(msg ?? {}, workMs)} slot={msg === undefined || msg.times !== undefined}
        regen={msg === undefined ? live?.end?.kind === "stopped" : last} thread={messages} origin={origin} token={token} />
    </>
  );
});

/** A saved reply: props only, so a keystroke or a token elsewhere runs nothing here. `times` is its row's, drawn once. */
const SavedReply = memo(function SavedReply({ msg, last, thread, times, origin, token }: RowProps & { times: Drawn }) {
  countRender(msg.id);
  const tools = msg.tools ?? NO_TOOLS;
  const allowedLinks = useMemo(() => imageTurnLinks(thread, tools), [thread, tools]);
  return (
    <Reply msg={msg} live={null} text={msg.content} paced={msg.content} thinking={msg.thinking ?? ""} tools={tools} rounds={times.rounds}
      secs={workSecs(times.workMs)} allowedLinks={allowedLinks}
      note={times.note} meta={replyMeta(msg, times.workMs)} regen={last} thread={thread} origin={origin} token={token} />
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
/** Turns added per step while the reader scrolls up: no more than the first commit mounts. */
const SLICE_TURNS = 40;
/**
 * Turns added per idle slice after the first. Each slice costs a render of every
 * mounted row, a layout and a frame that grow with the turns already in, on top
 * of the new turns themselves: in a 2,000-turn thread on the test machine,
 * 40-turn slices took 1.2 s to mount the rest, 120-turn slices 0.6 s, each still
 * about 20 ms. The first idle slice can run before the frame that shows the
 * opened thread, so it adds SLICE_TURNS, no more than the first commit.
 */
const FILL_TURNS = 120;
/**
 * The page holds only what the reader asked for (chat row 40, owner pick A, 2026-11-13): a
 * thread opens with a window of its latest turns, and a button at the top adds the turns
 * before them, this many a press. Turns that come in at the end widen the window there.
 */
const WINDOW_TURNS = 200;

/** The longest a slice waits for an idle moment before it mounts anyway. */
const IDLE_WAIT_MS = 100;
/** Idle time a further slice in the same callback needs: about what mounting FILL_TURNS turns takes. */
const SLICE_MS = 20;

/**
 * Runs `fn` once the browser is idle, or after IDLE_WAIT_MS at most, with how
 * much of the idle period is left; a 50 ms timer with none left where there is
 * no requestIdleCallback (Safari). On an idle page a callback mounts slices
 * while the deadline has room. On a page that is never idle (a reply
 * streaming), each slice waits the full 100 ms: 2,000 turns are 17 slices, so
 * the thread is fully mounted about 1.7 s after it opens, plus the time the
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

/** modelChanges with the live turn, given as "kind\nmodel\nquestion id" (the Timeline's selector answer). */
function liveChanges(messages: readonly Message[], liveBy: string | null) {
  if (liveBy === null) return modelChanges(messages);
  const [kind, name = "", question = ""] = liveBy.split("\n");
  const by: Answerer = kind === "image" ? { kind: "image", preset: name } : { kind: "chat", model: name };
  return modelChanges(messages, { questionId: question === "" ? undefined : question, by });
}

/** The open thread: `.tl > .col`. Follows the end while the reader is near it (120 px). */
export function Timeline({ threadId }: { threadId: string }) {
  const messages = useStore((s) => s.messages[threadId] ?? EMPTY);
  const loading = useStore((s) => s.messages[threadId] === undefined && turnOf(s, threadId) === undefined);
  const loadError = useStore((s) => s.loadErrors[threadId]);
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
  const origin = useStore((s) => s.serverOrigin);
  const token = useStore((s) => s.fileToken);
  const tl = useRef<HTMLDivElement>(null);
  const col = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Where the timeline last scrolled itself: a scroll event that lands there is its own, any other is the reader's.
  const own = useRef(-1);
  // The reader opened or closed something in a finished reply and has not scrolled since: the page follows the end only from exactly there.
  const toggled = useRef(false);
  // Image jobs have their own identity. The text reply belongs to its user
  // turn, even when a job is inserted between that user and the live reply.
  let owner: string | undefined;
  const turns: { msg: Message | undefined; key: string }[] = messages.map(msg => {
    if (msg.role === "user") owner = msg.id;
    return { msg, key: msg.role === "user" ? msg.id : msg.imageJob ? `image:${msg.id}` : `reply:${owner ?? msg.id}` };
  });
  if (liveOwner !== null) turns.push({ msg: undefined, key: `reply:${liveOwner}` });
  // A retry shows in the box of the card it retries, never as a second box.
  const retries = retryRows(messages);
  // What the live turn was sent to, as one string so the selector's answer compares by value.
  const liveBy = useStore((s) => {
    const turn = turnOf(s, threadId);
    return turn === undefined ? null : `${turn.image === true ? "image" : "chat"}\n${turn.model}\n${turn.userMessageId ?? ""}`;
  });
  // A line above each turn answered by another thing than the one before, from the turn's first frame.
  // One pass over the messages; the timeline renders when they or the live turn's owner change, not per token.
  const changes = liveChanges(messages, liveBy);
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
  // The earliest turn the reader asked for, by key: nothing in front of it mounts until they ask.
  // When it leaves the thread (deleted) the window starts at what is mounted, so nothing unmounts.
  const [floor, setFloor] = useState<string | null>(null);
  const floorNow = useRef(0);
  let floorAt = floor === null ? -1 : turns.findIndex((t) => t.key === floor);
  if (floorAt < 0) floorAt = Math.min(skip, Math.max(0, turns.length - WINDOW_TURNS));
  const floorKey = turns[floorAt]?.key ?? null;
  if (floorKey !== null && floorKey !== floor) setFloor(floorKey);
  turnsNow.current = turns;
  skipNow.current = skip;
  floorNow.current = floorAt;
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
  const grow = useCallback((count: number) => {
    if (skipNow.current <= floorNow.current) return;
    const key = turnsNow.current[Math.max(floorNow.current, skipNow.current - count)]?.key;
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
      if (moved !== 0) {
        el.scrollTop += moved;
        own.current = el.scrollTop;
      }
    }
    note();
  });

  // the rest of the window mounts in idle time, so find-in-page and select-all see all of it
  useEffect(() => (first === null || skip <= floorAt ? undefined : whenIdle((timeLeft) => {
    do grow(turnsNow.current.length - skipNow.current <= FIRST_TURNS ? SLICE_TURNS : FILL_TURNS); while (skipNow.current > floorNow.current && timeLeft() > SLICE_MS);
  })), [first, skip, floorAt, grow]);

  // Load earlier: the window takes the turns before it, mounted at once; the turn in view stays where it is
  const earlier = () => {
    const key = turnsNow.current[Math.max(0, floorNow.current - WINDOW_TURNS)]?.key;
    if (key === undefined) return;
    floorNow.current = Math.max(0, floorNow.current - WINDOW_TURNS);
    flushSync(() => setFloor(key));
    grow(Number.MAX_SAFE_INTEGER);
  };

  // a newly opened thread starts at its end
  useLayoutEffect(() => {
    const el = tl.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      own.current = el.scrollTop;
    }
    stick.current = true;
    toggled.current = false;
  }, [threadId]);

  useEffect(() => {
    const el = tl.current;
    const c = col.current;
    if (!el || !c) return;
    // near the end follows it as the reader scrolls; after the reader opens or closes something finished, only the end itself does
    const atEnd = () => el.scrollHeight - el.scrollTop - el.clientHeight < (toggled.current ? 2 : 120);
    const onScroll = () => {
      // a scroll the timeline did not make, the hold's last one included, is the reader's: the hold lets go
      if (Math.abs(el.scrollTop - own.current) > 1) {
        held = null;
        toggled.current = false;
      }
      stick.current = atEnd();
      note();
      // within a screen of the turns not mounted yet: mount them now, not when idle
      if (el.scrollTop < el.clientHeight) grow(SLICE_TURNS);
    };
    // a disclosure the reader opens or closes stays where it was through its ease: no following, no anchoring shift
    let held: { at: Element; top: number; until: number } | null = null;
    const keep = () => {
      if (held === null) return;
      // the hold ends where the disclosure left the page: following only if that is still the end
      if (performance.now() > held.until || !held.at.isConnected) { held = null; stick.current = atEnd(); return; }
      el.scrollTop += held.at.getBoundingClientRect().top - held.top;
      own.current = el.scrollTop;
      requestAnimationFrame(keep);
    };
    const onToggle = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Enter" && e.key !== " ") return;
      const disclosure = e.target instanceof Element ? e.target.closest("[aria-expanded]") : null;
      if (disclosure === null || !c.contains(disclosure)) return;
      const start = held === null;
      // what opens in a reply still being written is read as it grows, so the page keeps following near the end
      toggled.current = disclosure.closest(".turn.a:not(.done):not(.interrupted)") === null;
      stick.current = atEnd();
      own.current = el.scrollTop;
      held = { at: disclosure, top: disclosure.getBoundingClientRect().top, until: performance.now() + 400 };
      if (start) requestAnimationFrame(keep);
    };
    const ro = new ResizeObserver(() => {
      if (!stick.current || held !== null) return;
      el.scrollTop = el.scrollHeight;
      own.current = el.scrollTop;
    });
    ro.observe(c);
    ro.observe(el);
    el.addEventListener("scroll", onScroll, { passive: true });
    c.addEventListener("click", onToggle, true);
    c.addEventListener("keydown", onToggle, true);
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", onScroll);
      c.removeEventListener("click", onToggle, true);
      c.removeEventListener("keydown", onToggle, true);
    };
  }, [grow, note]);

  return (
    <div className="tl" ref={tl} aria-busy={loading && loadError === undefined}>
      <div className={messages.length >= LONG_THREAD ? "col long" : "col"} ref={col}>
        {loading && loadError === undefined ? <TurnSkel /> : null}
        {floorAt > 0 ? (
          // the arrow and the number say it (decision 5); the button's tip has how many there are before
          <button type="button" className="earlier" data-testid="chat.thread.earlier" onClick={earlier}
            aria-label={`Show ${Math.min(WINDOW_TURNS, floorAt).toLocaleString("en-US")} earlier`}
            data-tip={`${floorAt.toLocaleString("en-US")} earlier`}>
            <Icon id="up" />
            {Math.min(WINDOW_TURNS, floorAt).toLocaleString("en-US")}
          </button>
        ) : null}
        {turns.slice(skip).map(({ msg: m, key }, j) => {
          if (m !== undefined && retries.has(m.id)) return null;
          const last = skip + j === messages.length - 1;
          const times = m === undefined ? undefined : drawTimes(m, catalog);
          // a question's note waits while its ended turn still shows its own error line: said once
          const why = m?.role === "user" && m.id === liveOwner ? undefined : times?.note;
          // a question's line by its id; a live question not saved yet by LIVE_QUESTION, above its pending bubble
          const change = m?.role === "user" ? changes.get(m.id) : m === undefined ? changes.get(LIVE_QUESTION) : undefined;
          return (
            <Fragment key={key}>
              {change === undefined ? null : <ModelChange change={change} />}
              {m?.role === "user" ? <UserTurn msg={row(m)} noted={why !== undefined && why.kind !== "stopped"} />
                : m === undefined || times === undefined || wasLive.has(key) ? <LiveReply threadId={threadId} msg={m === undefined ? undefined : row(m)} last={last} origin={origin} token={token} />
                : <SavedReply msg={row(m)} last={last} thread={readsThread(m) ? messages : EMPTY} times={times} origin={origin} token={token} />}
              {/* a reason the person did not cause, in its own words; under a reply, the stop square says the model won't see it */}
              {m !== undefined && why?.kind === "said" ? (
                <div className={m.role === "user" ? "stop-note under-u" : "stop-note"} role="status">
                  {m.role === "assistant" ? <StopMark /> : null}
                  {why.words}
                </div>
              ) : m?.role === "user" && why?.kind === "failed" ? (
                // a question whose reply failed before its first word: the same line a failed reply has (decision 7)
                <div className="stop-note under-u"><FailLine words="The reply didn't finish." why={why.why} retryable={last} /></div>
              ) : null}
            </Fragment>
          );
        })}
        {loadError !== undefined ? (
          <div className="err-line" role="status" data-load-error>
            <Icon id="alert" cls="s14" />
            <span>{loadError}</span>
            <button type="button" className="qa" data-testid="chat.thread.reload" onClick={() => reloadThread(threadId)}>
              Retry
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
