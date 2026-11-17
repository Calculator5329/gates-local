// Layout adapts T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.); full notice in LICENSES/T3-Code-MIT.txt.
// The thread timeline (shell.md F11, F40, F50, F56, F58, F60). A saved reply is
// props only and memoised by message, so a streaming token or a keystroke runs
// nothing in it; only the live reply reads the store and paces its text. A
// thread opens with its last turns mounted and adds the older ones when idle.
import { Fragment, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import type { AttachedFile, ImageEvent, Message, ToolStep } from "@gates-local/contracts";
import { useCopy } from "../lib/ui/copy.ts";
import { noGpu, replyMeta, replyWait, turnTime } from "../lib/words/format.ts";
import { Icon } from "../lib/ui/icons.tsx";
import { Markdown } from "./markdown.tsx";
import { imageTurnLinks } from "./image-links.ts";
import { presetName, sizeLabel } from "../image/image-choice.ts";
import { reveal } from "./reveal.ts";
import { usePacedText } from "./paced.ts";
import { focusComposer } from "../composer/focus.ts";
import { cancelImage, earlierOf, fileUrl, loadEarlier, onEarlier, reloadThread, retry, retryImage } from "../lib/session/index.ts";
import { AttachedFiles, AttachmentImages } from "../composer/attachment-images.tsx";
import { type LiveTurn, NA, type State, type StopNote, getState, turnOf, unsavedQuestion, useStore } from "../lib/store/store.ts";
import { drawsPicture, stopping, workMsAt } from "./turn.ts";
import { type Drawn, type Rounds, drawTimes } from "./times.ts";
import { currentDraftKey, replaceDraft } from "../lib/store/drafts.ts";
import { TurnSkel, closeTip, esc } from "../lib/ui/ui.tsx";
import { type Answerer, LIVE_QUESTION, modelChanges } from "./model-change.ts";
import { ModelChange } from "./ModelChange.tsx";
import { useNow } from "../lib/ui/kit/now.ts";
import { whenIdle } from "../lib/ui/kit/idle.ts";
import { frameLoop } from "../lib/ui/kit/frame.ts";

const EMPTY: readonly Message[] = [];
const NO_TOOLS: readonly ToolStep[] = [];
const catalogOf = (s: State) => (s.catalog === NA ? undefined : s.catalog);

declare global {
  interface Window {
    glRows?: { renders: Record<string, number>; bustMemo?: boolean };
  }
}

function countRender(id: string): void {
  const rows = window.glRows;
  if (rows !== undefined) rows.renders[id] = (rows.renders[id] ?? 0) + 1;
}

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

function ActRow({ text, meta, wait, regen, regenOff = false, stop, empty = false }: { text: string; meta: string; wait?: string | undefined; regen: boolean; regenOff?: boolean | undefined; stop?: number | null | undefined; empty?: boolean }) {
  // external: a browser on a touch screen has no hover, so hover-only details never show
  const [details, setDetails] = useState(false);
  return (
    <div className={`a-act${stop === undefined ? "" : " stop"}${details ? " det" : ""}`}>
      {stop === undefined ? null : <StopMark secs={stop ?? undefined} said={empty} />}
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
      <span className="meta">
        {wait === undefined ? null : <span className="wait" data-testid="chat.reply.wait" data-tip="Waited for the model"><Icon id="clock" cls="s12" />{wait}</span>}
        {wait !== undefined && meta !== "" ? " · " : null}
        {meta}
      </span>
    </div>
  );
}

function UserBubble({ text, time, images = [], files = [], noted = false }: { text: string; time: string; images?: readonly string[] | undefined; files?: readonly AttachedFile[] | undefined; noted?: boolean }) {
  return (
    <div className={noted ? "turn u noted" : "turn u"} data-testid="chat.user-message.turn" tabIndex={0} aria-label="Your message">
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

// why: the finished line is a pure view of its three numbers, with no store reads
interface ChipStep {
  readonly secs: number | undefined;
  readonly calls: number | null;
  readonly failed: number;
}

const workSecs = (ms: number | undefined) => (ms === undefined ? undefined : Math.max(1, Math.round(ms / 1000)));

function LiveLine({ turn, tools }: { turn: LiveTurn; tools: readonly ToolStep[] }) {
  const stage = turn.reply?.stage ?? "waiting";
  const now = useNow(250, stage === "waiting" || stage === "thinking" || stage === "tool");
  const cpu = useStore((s) => noGpu(s.gpu));
  // why: Send gets its turn id at once, so the wait behind a picture keys on the unsaved question
  const imageBusy = useStore((s) => turn.userMessageId === undefined && s.imageStatus !== NA && s.imageStatus?.state === "busy");
  const t = Math.max(now, Date.now());
  const r = turn.reply;
  const clocked = stage === "thinking" || stage === "tool" || tools.length > 0 || turn.thinking !== ""
    || (r !== undefined && (r.workMs > 0 || r.spans.length > 0 || Object.keys(r.callsAt).length > 0));
  const secs = clocked ? Math.floor((workMsAt(turn, t) ?? 0) / 1000) : 0;
  const words = stage === "loading" ? (cpu ? "Loading into memory…" : "Loading into GPU memory…")
    : stage === "thinking" ? "Thinking"
    : stage === "tool" ? (tools.findLast((s) => s.state === "running") ?? tools.at(-1))?.summary ?? "Thinking"
    : stage === "writing" || stage === "stopping" || stage === "ended" ? "Writing"
    : imageBusy ? "Waiting for an image" : t - turn.startedAt >= 1000 ? "Waiting" : "";
  return (
    <>
      <span className="run-dot" />
      {clocked ? <span className="lv-t" aria-hidden="true">{`${secs} s`}</span> : null}
      <span className="lv-w"><span>{words}</span></span>
    </>
  );
}

function doneWords(step: ChipStep): string {
  if (step.calls === null) return step.secs === undefined ? "Thought" : `Thought for ${step.secs} s`;
  return `${step.secs === undefined ? "" : `${step.secs} s · `}${step.calls} step${step.calls === 1 ? "" : "s"}`;
}

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
  readonly tools: readonly ToolStep[];
  readonly secs: number | undefined;
  readonly live: LiveTurn | null;
  readonly stopped: boolean;
  readonly rounds: Rounds | undefined;
}

function Fold({ thinking, tools, secs, live, stopped, rounds }: FoldProps) {
  const [open, setOpen] = useState(false);
  const [shut, setShut] = useState<Readonly<Record<number, boolean>>>({});
  const body = useId();
  const thinkingNow = live?.reply?.stage === "thinking";
  const items: ({ kind: "think"; from: number; to: number } | { kind: "call"; step: ToolStep })[] = [];
  let from = 0;
  for (const s of tools) {
    const at = Math.min(rounds?.callsAt[s.callId] ?? thinking.length, thinking.length);
    if (at > from) items.push({ kind: "think", from, to: at });
    from = Math.max(from, at);
    items.push({ kind: "call", step: s });
  }
  if (thinking.length > from) items.push({ kind: "think", from, to: thinking.length });
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

// why: builds before the stopped mark read a stopped call, saved as error, as failed
function cutByStop(step: ToolStep): boolean {
  return step.state === "error" && step.stopped === true;
}

function ToggleLine({ open, onToggle, body, step, live, tools }: { open: boolean; onToggle: () => void; body: string; step: ChipStep; live: LiveTurn | null; tools: readonly ToolStep[] }) {
  const n = tools.length;
  const name = live !== null ? (n === 0 ? undefined : `Working, ${n} tool ${n === 1 ? "call" : "calls"}`)
    : doneWords(step) + (step.failed > 0 ? `, ${step.failed} failed` : "");
  return (
    <div className={open ? "fold-line open" : "fold-line"}>
      <button type="button" className={live !== null ? "think fold run" : "think fold"} data-testid="chat.fold.toggle" aria-expanded={open} aria-controls={body}
        aria-label={name} data-think={live === null ? step.secs : undefined} onClick={onToggle}>
        {live !== null ? <LiveLine turn={live} tools={tools} /> : <DoneLine step={step} />}
      </button>
    </div>
  );
}

function ThoughtRound({ text, live, secs, open, onToggle }: { text: string; live: boolean; secs: number | undefined; open: boolean; onToggle: (open: boolean) => void }) {
  const id = useId();
  return (
    <>
      <button type="button" className="th-line" data-testid="chat.fold.thinking" aria-expanded={open} aria-controls={id}
        aria-label={live ? "Thinking" : secs === undefined ? "Thought" : `Thought for ${secs} s`} onClick={() => onToggle(!open)}>
        <span className="wr-st">
          <Icon id="bulb" />
        </span>
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

function callLine(line: string): { cmd: string; shell: boolean } {
  try {
    const call: unknown = JSON.parse(line);
    const input = typeof call === "object" && call !== null ? (call as { input?: unknown }).input : undefined;
    if (typeof input === "object" && input !== null) {
      const i = input as Record<string, unknown>;
      if (typeof i["command"] === "string") return { cmd: i["command"], shell: true };
      const prompts = Array.isArray(i["prompts"]) && i["prompts"].every((p) => typeof p === "string") ? i["prompts"].join("\n") : undefined;
      const arg = [i["query"], i["path"], i["prompt"], prompts].find((v) => typeof v === "string");
      if (typeof arg === "string") return { cmd: arg, shell: false };
    }
  } catch {}
  return { cmd: line, shell: true };
}

function ToolRow({ step, stopped }: { step: ToolStep; stopped?: boolean }) {
  const [open, setOpen] = useState(false);
  const cut = cutByStop(step) || (stopped === true && step.state === "running");
  const st = cut ? "cut" : step.state === "running" ? "run" : step.state === "error" ? "rej" : "done";
  const label = toolLabel(step.name);
  // why: the contract has no read-only field yet, so a -readonly flag in the call is the evidence
  const ro = /(^|\s)-readonly(\s|$)/.test(step.detail ?? "") ? "read-only" : "";
  const lead = ro === "" ? label : `${label} · ${ro}`;
  const dur = duration(step.durationMs);
  const named = step.summary.toLowerCase().startsWith(label.toLowerCase());
  const [line = "", ...rest] = (step.detail ?? "").split("\n");
  const { cmd, shell } = callLine(line);
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
          {st === "run" ? <span className="run-dot" /> : <Icon id={st === "done" ? "checkc" : "xc"} />}
        </span>
        <span className="wr-h">{heading}</span>
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

// why: the timeline reads where pictures come from once, not once per row
interface Files {
  readonly origin: string | null;
  readonly token: string | null;
}

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

interface Accepted { readonly from: string; readonly to: string }

export function chainEnd(first: ImageEvent, thread: readonly Message[], accepted?: Accepted): ImageEvent {
  let job = first;
  const seen = new Set([job.jobId]);
  for (;;) {
    const next = job.retryJobId ?? (accepted?.from === job.jobId ? accepted.to : undefined);
    if (next === undefined || seen.has(next)) return job;
    seen.add(next);
    job = thread.find(m => m.id === next)?.imageJob ?? { jobId: next, state: "queued", ...(job.choice ? { choice: job.choice } : {}) };
  }
}

export function retryRows(thread: readonly Message[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const m of thread) {
    if (m.imageJob?.retryJobId !== undefined) ids.add(m.imageJob.retryJobId);
    if (m.imageJob?.group !== undefined && m.imageJob.group.index > 0) ids.add(m.id);
  }
  return ids;
}

export function groupCards(first: Message, thread: readonly Message[]): readonly Message[] {
  const group = first.imageJob?.group;
  if (group === undefined) return [first];
  return thread.filter((m) => m.imageJob?.group?.id === group.id).toSorted((a, b) => a.imageJob!.group!.index - b.imageJob!.group!.index);
}

export function groupWords(jobs: readonly ImageEvent[], of: number): string {
  const done = jobs.filter((j) => j.state === "done");
  if (jobs.some((j) => j.state === "queued" || j.state === "running")) return `${done.length} of ${of} making…`;
  const ms = done.reduce((sum, j) => sum + (j.runMs ?? Number.NaN), 0);
  return Number.isNaN(ms) || done.length === 0 ? `${done.length} of ${of}` : `${done.length} of ${of} · ${Math.max(1, Math.round(ms / 1000))} s`;
}

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

function jobWords(job: ImageEvent): string {
  if (job.phase === "stopping") return "Stopping the picture";
  if (job.phase === "freeing") return "Freeing memory";
  if (job.state === "queued") return "Waiting for the GPU";
  return "Making image";
}

export function stageWords(job: ImageEvent, sampled: boolean): string {
  if (job.phase === "stopping") return "Stopping the picture";
  if (job.phase === "freeing") return "Freeing memory";
  if (job.state === "queued") return "Waiting for the GPU";
  switch (job.stage) {
    case "queued": return "In the queue";
    case "loading": return sampled ? "Loading the model" : "First run: loading the model";
    case "encoding": return "Reading the prompt";
    // external: ComfyUI's socket names no load while the sampler node moves models in
    case "sampling": return job.steps === undefined ? "Starting" : `Sampling ${job.steps.done}/${job.steps.total}`;
    case "decoding": return "Decoding";
    default: return "Working";
  }
}

function JobLine({ job, since }: { job: ImageEvent; since: number }) {
  const now = useNow(1000);
  const secs = Math.max(0, Math.floor((now - since) / 1000));
  return <p className="image-job-live" aria-hidden="true"><i className="lv-dot" /><span className="lv-w">{stageWords(job, job.sampled === true)}</span><span className="lv-t">{` · ${secs} s`}</span></p>;
}

function turnCard(thread: readonly Message[], userMessageId: string): string | undefined {
  const at = thread.findIndex((m) => m.id === userMessageId);
  return at < 0 ? undefined : thread.slice(at + 1).find((m) => m.imageJob !== undefined)?.id;
}

function ImageJob({ msg, thread, origin, token, tile = false }: { msg: Message; thread: readonly Message[]; tile?: boolean } & Files) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<Accepted>();
  const job = chainEnd(msg.imageJob!, thread, accepted);
  const pending = job.state === "queued" || job.state === "running";
  const choice = msg.imageJob!.sent ?? msg.imageJob!.choice ?? job.choice;
  const size = choice ? { aspectRatio: `${choice.width} / ${choice.height}`, ...tile ? {} : { width: `${choice.width}px` } } : undefined;
  const ran = job.choice ?? msg.imageJob!.choice;
  const model = useStore((s) => (ran === undefined ? undefined : presetName(s, ran.preset)));
  const turn = useStore((s) => turnOf(s, msg.threadId));
  const head = turn !== undefined && drawsPicture(turn) && turn.end === undefined && turn.userMessageId !== undefined ? turnCard(thread, turn.userMessageId) : undefined;
  const stopCovers = pending && head !== undefined && (head === msg.id || (msg.imageJob!.group !== undefined && thread.find((m) => m.id === head)?.imageJob?.group?.id === msg.imageJob!.group.id));
  const since = thread.find((m) => m.id === job.jobId)?.createdAt ?? msg.createdAt;
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
  const line = job.state === "error" && job.errorKind === "image-missing";
  const card = <div className={line ? "image-job line" : "image-job"} style={line ? undefined : size} data-job={job.jobId} data-image-job={job.state} data-fit={job.state === "error" && job.errorKind === "wont-fit" ? "refuse" : undefined}>
    {ran === undefined || pending || line || tile ? null : <span className="image-job-model">{model} · {sizeLabel(ran.width, ran.height)}</span>}
    {job.state === "done" && job.imagePath ? <ImageOut path={job.imagePath} origin={origin} token={token} /> : <div className="image-job-state" role="status" aria-label={pending ? jobWords(job) : undefined}>
      {pending ? <JobLine job={job} since={since} /> : <><Icon id="alert" /><p>{job.message ?? "The image did not finish; try again."}</p></>}
      {stopCovers || job.phase === "stopping" ? null : <button type="button" className="qa" data-testid="chat.image-job.action" disabled={busy} onClick={() => void action()}>{pending ? "Cancel image" : "Try again"}</button>}
      {error ? <p>{error}</p> : null}
    </div>}
  </div>;
  return caption === undefined ? card : <figure className="image-job-fig">{card}<figcaption className="image-job-prompt">{caption}</figcaption></figure>;
}

const UserTurn = memo(function UserTurn({ msg, noted }: { msg: Message; noted: boolean }) {
  countRender(msg.id);
  return <UserBubble text={msg.content} images={msg.images} files={msg.files} time={turnTime(msg.createdAt)} noted={noted} />;
});

const UNSEEN = "Stopped. The model won't see this reply.";

function StopMark({ secs, said = false }: { secs?: number | undefined; said?: boolean }) {
  return (
    <span className="stop-mark">
      <span role="img" data-testid="chat.reply.unseen-mark" tabIndex={0} aria-label={UNSEEN} data-tip={esc(UNSEEN)} />
      {said ? <span className="w" aria-hidden="true">Stopped</span> : null}
      {secs === undefined ? null : <span className="s">{secs} s</span>}
    </span>
  );
}

// why: store reads and pacing stay in LiveReply, so a saved row never re-renders per token
interface ReplyView extends Files {
  readonly msg: Message | undefined;
  readonly live: LiveTurn | null;
  readonly text: string;
  readonly paced: string;
  readonly thinking: string;
  readonly tools: readonly ToolStep[];
  readonly rounds: Rounds | undefined;
  readonly secs: number | undefined;
  readonly allowedLinks: ReadonlySet<string> | undefined;
  readonly note: StopNote | undefined;
  readonly meta: string;
  readonly wait: string | undefined;
  readonly regen: boolean;
  readonly thread: readonly Message[];
  readonly slot?: boolean;
}

const SAYS_WHY = new Set(["context-too-small", "preempted", "runtime-changed"]);
const failWords = (code: string | undefined): string => (code === undefined ? undefined : FAIL_WORDS[code]) ?? "The reply didn't finish.";

// why: a failure the person can act on says what to do; the runtime's own text stays out of sight
const FAIL_WORDS: Readonly<Record<string, string>> = {
  closed: "The connection dropped before this reply finished.",
  "connection-failed": "Ollama stopped answering. Retry once it's running.",
  "model-not-found": "This model isn't installed any more. Pick another in the model menu.",
  "num-ctx-invalid": "This model can't use that context size. Pick another in the model menu.",
};

function FailLine({ words, why, retryable }: { words: string; why: string; retryable: boolean }) {
  return (
    <div className="err-line" data-testid="chat.reply.failed" data-why={why === "" ? undefined : why}>
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

function Reply({ msg, live, text, paced, thinking, tools, rounds, secs, allowedLinks, note, meta, wait, regen, thread, slot = false, origin, token }: ReplyView) {
  const end = live?.end;
  const interrupted = msg?.interrupted === true;
  const knownStop = note?.kind === "said";
  const notes = useMemo(() => tools.filter((t) => t.name === "note"), [tools]);
  const calls = useMemo(() => (notes.length === 0 ? tools : tools.filter((t) => t.name !== "note")), [tools, notes]);
  const foldTimed = calls.length === 0 && text === "" && thinking !== "";
  const stopSecs = end?.kind === "stopped" ? end.secs : note?.kind === "stopped" ? note.secs : undefined;
  const stop = stopSecs !== undefined ? (foldTimed ? null : stopSecs) : interrupted && note === undefined ? null : undefined;
  const streaming = live !== null && end === undefined;
  const pending = paced.length < text.length;
  const shown = reveal(paced, streaming || pending);
  const folded = thinking !== "" || calls.length > 0;
  return (
    <div className={`turn a${interrupted ? " interrupted" : streaming || pending ? "" : " done"}${knownStop ? " noted" : ""}`} data-testid="chat.reply.turn" tabIndex={0} aria-label={interrupted ? "Interrupted reply" : "Reply"} data-received={text.length} data-revealed={paced.length}>
      {folded ? (
        <Fold thinking={thinking} tools={calls} secs={secs} live={streaming ? live : null} stopped={end !== undefined || interrupted} rounds={rounds} />
      ) : streaming ? (
        <div className="fold-line"><div className="think fold run"><LiveLine turn={live} tools={calls} /></div></div>
      ) : slot ? <div className="fold-line slot" aria-hidden="true" /> : null}
      {notes.map((t) => <ToolRow key={t.callId} step={t} stopped={end !== undefined || interrupted} />)}
      {msg?.imageJob ? <ImageCard msg={msg} thread={thread} origin={origin} token={token} /> : shown !== "" ? <Markdown text={shown} live={streaming || pending} allowedLinks={allowedLinks} /> : null}
      {(msg?.imageJob ? [] : msg?.images ?? []).map((p) => <ImageOut key={p} path={p} origin={origin} token={token} />)}
      {end?.kind === "error" ? (
        <FailLine words={SAYS_WHY.has(end.code) ? end.message : failWords(end.code)}
          why={end.message} retryable />
      ) : note?.kind === "failed" ? <FailLine words={failWords(note.code)} why={note.why} retryable={regen} /> : null}
      {!streaming && !pending && !msg?.imageJob && !(text === "" && msg?.tools?.every(t => t.name === "image")) ? (
        <ActRow text={text} meta={meta} wait={wait} regen={regen} regenOff={stopping(live ?? undefined)} stop={stop} empty={text === "" && !folded && notes.length === 0 && !msg?.images?.length} />
      ) : null}
    </div>
  );
}

interface RowProps extends Files {
  readonly msg: Message;
  readonly last: boolean;
  readonly thread: readonly Message[];
}

const LiveReply = memo(function LiveReply({ threadId, msg, last, origin, token }: { threadId: string; msg: Message | undefined; last: boolean } & Files) {
  const live = useStore((s) => (msg === undefined ? turnOf(s, threadId) ?? null : null));
  const asked = useStore((s) => (live === null ? undefined : unsavedQuestion(s, live)));
  const catalog = useStore(catalogOf);
  const saved = msg === undefined ? undefined : drawTimes(msg, catalog);
  const rounds = msg === undefined ? live?.reply : saved?.rounds;
  const text = msg?.content ?? live?.text ?? "";
  const tools = msg?.tools ?? live?.tools ?? NO_TOOLS;
  const queuedImage = tools.some(t => t.name === "image" && t.state === "done");
  const messages = useStore(s => queuedImage ? s.messages[threadId] ?? EMPTY : EMPTY);
  const allowedLinks = useMemo(() => imageTurnLinks(messages, tools), [messages, tools]);
  const note = saved?.note;
  const workMs = live === null ? saved?.workMs : live.end === undefined ? undefined : workMsAt(live, Date.now());
  const r = live?.reply;
  const waitMs = live === null ? saved?.waitMs : r?.readyAt === undefined ? undefined : r.readyAt - r.startedAt;
  const paced = usePacedText(text, live !== null && live.end === undefined);
  if (msg === undefined && live === null) return null;
  if (msg === undefined && live !== null && drawsPicture(live)) return asked !== undefined ? <UserBubble text={asked.text} images={asked.images ?? []} files={asked.files} time={turnTime(live.startedAt)} /> : null;
  if (msg !== undefined) countRender(msg.id);
  return (
    <>
      {live !== null && asked !== undefined ? <UserBubble text={asked.text} images={asked.images ?? []} files={asked.files} time={turnTime(live.startedAt)} /> : null}
      <Reply msg={msg} live={live} text={text} paced={paced} thinking={msg?.thinking ?? live?.thinking ?? ""} tools={tools} rounds={rounds} secs={workSecs(workMs)}
        allowedLinks={allowedLinks} note={note} meta={replyMeta(msg ?? {}, workMs)} wait={replyWait(waitMs)} slot={msg === undefined || msg.times !== undefined}
        regen={msg === undefined ? live?.end?.kind === "stopped" : last} thread={messages} origin={origin} token={token} />
    </>
  );
});

const SavedReply = memo(function SavedReply({ msg, last, thread, times, origin, token }: RowProps & { times: Drawn }) {
  countRender(msg.id);
  const tools = msg.tools ?? NO_TOOLS;
  const allowedLinks = useMemo(() => imageTurnLinks(thread, tools), [thread, tools]);
  return (
    <Reply msg={msg} live={null} text={msg.content} paced={msg.content} thinking={msg.thinking ?? ""} tools={tools} rounds={times.rounds}
      secs={workSecs(times.workMs)} allowedLinks={allowedLinks}
      note={times.note} meta={replyMeta(msg, times.workMs)} wait={replyWait(times.waitMs)} regen={last} thread={thread} origin={origin} token={token} />
  );
});

const readsThread = (m: Message) => m.imageJob !== undefined || (m.tools ?? NO_TOOLS).some(t => t.name === "image" && t.state === "done");

const LONG_THREAD = 50;
// why: 40 turns of about 70 px fill 1.7 screens of a 1,600 px window, leaving one to scroll
const FIRST_TURNS = 40;
const SLICE_TURNS = 40;
// why: each slice re-renders every mounted row; 120-turn slices took 0.6 s, 40-turn 1.2 s
const FILL_TURNS = 120;
const WINDOW_TURNS = 200;

function turnKeyAt(messages: readonly Message[], i: number): string | undefined {
  const m = messages[i];
  if (m === undefined) return undefined;
  if (m.role === "user") return m.id;
  if (m.imageJob) return `image:${m.id}`;
  for (let j = i - 1; j >= 0; j--) {
    const before = messages[j];
    if (before?.role === "user") return `reply:${before.id}`;
  }
  return `reply:${m.id}`;
}

// why: on a page that is never idle, a slice still mounts within 100 ms
const IDLE_WAIT_MS = 100;
// why: 20 ms is about what mounting 120 turns took on the test machine
const SLICE_MS = 20;

function liveChanges(messages: readonly Message[], liveBy: string | null) {
  if (liveBy === null) return modelChanges(messages);
  const [kind, name = "", question = ""] = liveBy.split("\n");
  const by: Answerer = kind === "image" ? { kind: "image", preset: name } : { kind: "chat", model: name };
  return modelChanges(messages, { questionId: question === "" ? undefined : question, by });
}

export function Timeline({ threadId }: { threadId: string }) {
  const messages = useStore((s) => s.messages[threadId] ?? EMPTY);
  const loading = useStore((s) => s.messages[threadId] === undefined && turnOf(s, threadId) === undefined);
  const loadError = useStore((s) => s.loadErrors[threadId]);
  // why: a reply whose question is not saved yet has no user ID; its record names it
  const liveOwner = useStore((s) => {
    const turn = turnOf(s, threadId);
    return turn === undefined ? null : turn.userMessageId ?? `pending:${turn.turnId}`;
  });
  const bust = useStore((s) => (window.glRows?.bustMemo === true ? (s.turns[threadId]?.text.length ?? 0) : 0));
  const row = (m: Message) => (bust === 0 ? m : { ...m });
  const catalog = useStore(catalogOf);
  const origin = useStore((s) => s.serverOrigin);
  const token = useStore((s) => s.fileToken);
  const tl = useRef<HTMLDivElement>(null);
  const col = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const own = useRef(-1);
  const toggled = useRef(false);
  let owner: string | undefined;
  const turns: { msg: Message | undefined; key: string }[] = messages.map(msg => {
    if (msg.role === "user") owner = msg.id;
    return { msg, key: msg.role === "user" ? msg.id : msg.imageJob ? `image:${msg.id}` : `reply:${owner ?? msg.id}` };
  });
  if (liveOwner !== null) turns.push({ msg: undefined, key: `reply:${liveOwner}` });
  const retries = retryRows(messages);
  // why: one string compares by value, so other store changes do not re-render the timeline
  const liveBy = useStore((s) => {
    const turn = turnOf(s, threadId);
    return turn === undefined ? null : `${drawsPicture(turn) ? "image" : "chat"}\n${turn.model}\n${turn.userMessageId ?? ""}`;
  });
  const changes = liveChanges(messages, liveBy);
  const [wasLive] = useState(() => new Set<string>());
  if (liveOwner !== null) wasLive.add(`reply:${liveOwner}`);

  const [first, setFirst] = useState<string | null>(null);
  const turnsNow = useRef(turns);
  const skipNow = useRef(0);
  const opening = Math.max(0, turns.length - FIRST_TURNS);
  let at = first === null ? -1 : turns.findIndex((t) => t.key === first);
  if (at < 0 && first !== null) {
    const now = new Map(turns.map((t, i) => [t.key, i]));
    at = turnsNow.current.slice(skipNow.current).map((t) => now.get(t.key)).find((i) => i !== undefined) ?? -1;
  }
  const skip = at < 0 ? opening : Math.min(at, opening);
  const firstKey = turns[skip]?.key ?? null;
  if (firstKey !== null && firstKey !== first) setFirst(firstKey);
  const [floor, setFloor] = useState<string | null>(null);
  const floorNow = useRef(0);
  let floorAt = floor === null ? -1 : turns.findIndex((t) => t.key === floor);
  if (floorAt < 0) floorAt = Math.min(skip, Math.max(0, messages.length - WINDOW_TURNS));
  const floorKey = turns[floorAt]?.key ?? null;
  if (floorKey !== null && floorKey !== floor) setFloor(floorKey);
  turnsNow.current = turns;
  skipNow.current = skip;
  floorNow.current = floorAt;
  // external: a browser's own scroll anchoring may already have held the view still
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

  // oxlint-disable-next-line gates/effect-needs-reason -- the view's scroll position against the turns just drawn, read and set before paint so the turn in view does not move
  useLayoutEffect(() => {
    const el = tl.current;
    const a = anchor.current;
    if (el !== null && a !== null && a.el !== col.current?.querySelector(".turn") && col.current?.contains(a.el) === true) {
      // why: running fades kept frames going and re-laid out every mounted turn
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

  // oxlint-disable-next-line gates/effect-needs-reason -- the whole window in the DOM lets find-in-page and select-all see every turn; each committed slice schedules the next in the browser's idle time until the window is mounted
  useEffect(() => (first === null || skip <= floorAt ? undefined : whenIdle((timeLeft) => {
    do grow(turnsNow.current.length - skipNow.current <= FIRST_TURNS ? SLICE_TURNS : FILL_TURNS); while (skipNow.current > floorNow.current && timeLeft() > SLICE_MS);
  }, IDLE_WAIT_MS)), [first, skip, floorAt, grow]);

  const unloadedOf = () => earlierOf(threadId);
  const unloaded = useSyncExternalStore(onEarlier, unloadedOf, unloadedOf);
  const unloadedNow = useRef(unloaded);
  unloadedNow.current = unloaded;
  const before = floorAt + unloaded;
  const fetching = useRef(false);
  const threadNow = useRef(threadId);
  threadNow.current = threadId;
  const earlier = () => {
    const stepTo = (to: number, key: string | undefined) => {
      if (key === undefined) return;
      floorNow.current = to;
      flushSync(() => setFloor(key));
      grow(Number.MAX_SAFE_INTEGER);
    };
    if (floorNow.current >= WINDOW_TURNS || unloadedNow.current === 0) {
      const to = Math.max(0, floorNow.current - WINDOW_TURNS);
      stepTo(to, turnsNow.current[to]?.key);
      return;
    }
    if (fetching.current) return;
    const asked = threadId;
    const from = turnsNow.current[floorNow.current]?.msg?.id;
    fetching.current = true;
    void loadEarlier(asked).then((came) => {
      fetching.current = false;
      if (!came || threadNow.current !== asked) return;
      const list = getState().messages[asked] ?? [];
      const to = Math.max(0, list.findIndex((m) => m.id === from) - WINDOW_TURNS);
      stepTo(to, turnKeyAt(list, to));
    });
  };

  // why: a thread opens at its end before it paints; each thread mounts its own view
  const follow = useRef((el: HTMLDivElement | null) => {
    tl.current = el;
    const c = col.current;
    if (el === null || c === null) return undefined;
    el.scrollTop = el.scrollHeight;
    own.current = el.scrollTop;
    stick.current = true;
    toggled.current = false;
    const atEnd = () => el.scrollHeight - el.scrollTop - el.clientHeight < (toggled.current ? 2 : 120);
    const onScroll = () => {
      if (Math.abs(el.scrollTop - own.current) > 1) {
        held = null;
        toggled.current = false;
      }
      stick.current = atEnd();
      note();
      if (el.scrollTop < el.clientHeight) grow(SLICE_TURNS);
    };
    let held: { at: Element; top: number; until: number } | null = null;
    let ease: (() => void) | undefined;
    // why: each frame of a disclosure's ease holds the page under it still
    const keep = (): boolean => {
      if (held === null) return false;
      if (performance.now() > held.until || !held.at.isConnected) { held = null; stick.current = atEnd(); return false; }
      el.scrollTop += held.at.getBoundingClientRect().top - held.top;
      own.current = el.scrollTop;
      return true;
    };
    const onToggle = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Enter" && e.key !== " ") return;
      const disclosure = e.target instanceof Element ? e.target.closest("[aria-expanded]") : null;
      if (disclosure === null || !c.contains(disclosure)) return;
      const start = held === null;
      toggled.current = disclosure.closest(".turn.a:not(.done):not(.interrupted)") === null;
      stick.current = atEnd();
      own.current = el.scrollTop;
      held = { at: disclosure, top: disclosure.getBoundingClientRect().top, until: performance.now() + 400 };
      if (start) ease = frameLoop(keep);
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
      tl.current = null;
      ease?.();
      ro.disconnect();
      el.removeEventListener("scroll", onScroll);
      c.removeEventListener("click", onToggle, true);
      c.removeEventListener("keydown", onToggle, true);
    };
  }).current;

  return (
    <div className="tl" ref={follow} aria-busy={loading && loadError === undefined}>
      <div className={messages.length >= LONG_THREAD ? "col long" : "col"} ref={col}>
        {loading && loadError === undefined ? <TurnSkel /> : null}
        {before > 0 ? (
          <button type="button" className="earlier" data-testid="chat.thread.earlier" onClick={earlier}
            aria-label={`Show ${Math.min(WINDOW_TURNS, before).toLocaleString("en-US")} earlier`}
            data-tip={`${before.toLocaleString("en-US")} earlier`}>
            <Icon id="up" />
            {Math.min(WINDOW_TURNS, before).toLocaleString("en-US")}
          </button>
        ) : null}
        {turns.slice(skip).map(({ msg: m, key }, j) => {
          if (m !== undefined && retries.has(m.id)) return null;
          const last = skip + j === messages.length - 1;
          const times = m === undefined ? undefined : drawTimes(m, catalog);
          const why = m?.role === "user" && m.id === liveOwner ? undefined : times?.note;
          const change = m?.role === "user" ? changes.get(m.id) : m === undefined ? changes.get(LIVE_QUESTION) : undefined;
          return (
            <Fragment key={key}>
              {change === undefined ? null : <ModelChange change={change} />}
              {m?.role === "user" ? <UserTurn msg={row(m)} noted={why !== undefined && why.kind !== "stopped"} />
                : m === undefined || times === undefined || wasLive.has(key) ? <LiveReply threadId={threadId} msg={m === undefined ? undefined : row(m)} last={last} origin={origin} token={token} />
                : <SavedReply msg={row(m)} last={last} thread={readsThread(m) ? messages : EMPTY} times={times} origin={origin} token={token} />}
              {m !== undefined && why?.kind === "said" ? (
                <div className={m.role === "user" ? "stop-note under-u" : "stop-note"} role="status">
                  {m.role === "assistant" ? <StopMark /> : null}
                  {why.words}
                </div>
              ) : m?.role === "user" && why?.kind === "failed" ? (
                <div className="stop-note under-u"><FailLine words={failWords(why.code)} why={why.why} retryable={last} /></div>
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
