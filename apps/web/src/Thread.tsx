// Layout adapts T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.); full notice in LICENSES/T3-Code-MIT.txt.
// The thread timeline (shell.md F11, F40, F50, F56, F58, F60). A saved reply is
// props only and memoised by message, so a streaming token or a keystroke runs
// nothing in it; only the live reply reads the store and paces its text. A
// thread opens with its last turns mounted and adds the older ones when idle.
import { Fragment, memo, type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { CatalogEntry, ImageEvent, Message, ToolStep } from "@gates-local/contracts";
import { useCopy } from "./copy.ts";
import { describeModel, noGpu, replyMeta, turnTime } from "./format.ts";
import { Icon } from "./icons.tsx";
import { Markdown } from "./markdown.tsx";
import { imageTurnLinks } from "./image-links.ts";
import { presetName, sizeLabel } from "./image-choice.ts";
import { reveal } from "./reveal.ts";
import { usePacedText } from "./paced.ts";
import { focusComposer } from "./Sidebar.tsx";
import { cancelImage, fileUrl, reloadThread, retry, retryImage } from "./session.ts";
import { AttachmentImages } from "./attachment-images.tsx";
import { type LiveTurn, NA, type State, type StopNote, turnOf, useStore } from "./store.ts";
import { thoughtOrigin, thoughtSecs, thoughtSecsAt, type WorkClock } from "./session/turn.ts";
import { currentDraftKey, replaceDraft } from "./drafts.ts";
import { TurnSkel, closeTip, esc } from "./ui.tsx";

const EMPTY: readonly Message[] = [];
const NO_TOOLS: readonly ToolStep[] = [];
const catalogOf = (s: State) => (s.catalog === NA ? undefined : s.catalog);

/** The times this session kept for finished replies, as one subscription: the same object until either map changes. */
let times: Pick<State, "firstToken" | "thought" | "clocks"> = { firstToken: {}, thought: {}, clocks: {} };
const replyTimes = (s: State) => (s.firstToken === times.firstToken && s.thought === times.thought && s.clocks === times.clocks ? times
  : (times = { firstToken: s.firstToken, thought: s.thought, clocks: s.clocks }));

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
      <CopyButton text={text} />
      {regen ? (
        <button
          type="button"
          className="ibtn xs"
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
      {/* the bubble, then its actions under it at its right edge; their row's space is always kept, so showing it moves nothing */}
      <div className="u-row">
        <div className="bubble">{images.length ? <div className="user-images"><AttachmentImages images={images} /></div> : null}{text}</div>
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
      </div>
    </div>
  );
}

/** What a reply's chip shows at this moment; the face draws it and knows nothing else. */
interface ChipStep {
  /** Seconds of thinking so far; null when the reply has no thinking part, undefined when the time is not known (an older thread). */
  readonly think: number | null | undefined;
  /** Tool calls so far; null when the reply has none. */
  readonly calls: number | null;
  /** The part at work while the reply runs. */
  readonly lit: "think" | "calls" | null;
  /** The last call failed. */
  readonly failed: boolean;
  /** The current step in words, said beside the chip until the answer starts. */
  readonly words: string;
}

/**
 * The chip's face (owner's option 3 of four, 2026-11-11): the finished shape
 * from the first moment, bulb and seconds, a divider, wrench and calls, a
 * chevron; the part at work is lit and its number climbs. The box changes only
 * by digits. Another option is a change to this part and ChipWords.
 */
function ChipFace({ step }: { step: ChipStep }) {
  return (
    <>
      {step.think !== null ? (
        <span className={step.lit === "think" ? "ch-p on" : "ch-p"}>
          <Icon id="bulb" />
          {step.think === undefined ? null : <span className="ch-n">{step.think}</span>}
          {step.think === undefined ? null : <span className="ch-u">s</span>}
        </span>
      ) : null}
      {step.think !== null && step.calls !== null ? <span className="ch-sep" /> : null}
      {step.calls !== null ? (
        <span className={step.lit === "calls" ? "ch-p on" : step.failed ? "ch-p bad" : "ch-p"}>
          <Icon id={step.failed ? "xc" : "wrench"} />
          <span className="ch-n">{step.calls}</span>
        </span>
      ) : null}
      <span className="th-x">
        <Icon id="down" />
      </span>
    </>
  );
}

function ChipWords({ step }: { step: ChipStep }) {
  return <span className="fold-now">{step.words}</span>;
}

/** The screen reader's one name for the chip: what is inside, never a count that ticks. */
function chipName(step: ChipStep, busy: boolean): string {
  const calls = step.calls === null ? "" : `${step.calls} tool ${step.calls === 1 ? "call" : "calls"}`;
  if (busy) return `Working, ${calls}`;
  const think = step.think === null ? "" : step.think === undefined ? "Thinking" : `Thinking ${step.think} ${step.think === 1 ? "second" : "seconds"}`;
  return [think, calls].filter(Boolean).join(", ") + (step.failed ? ", last call failed" : "");
}

interface FoldProps {
  readonly thinking: string;
  /** The reply's calls; the server's notes are not calls and are not here. */
  readonly tools: readonly ToolStep[];
  /** Seconds before the answer, for the thought line of a reply with no calls; undefined when not known. */
  readonly secs: number | undefined;
  /** When the turn started, while a reply with no calls is still thinking. */
  readonly since: number | undefined;
  /** A thinking-only reply still thinking: the thought line reads "Thinking". */
  readonly thinkingNow: boolean;
  /** The turn has not ended. */
  readonly busy: boolean;
  /** The answer's words have started (they may still lead to a call). */
  readonly answering: boolean;
  /** Steps still running are stopped: Stop, an error or an interrupted save. */
  readonly stopped: boolean;
  /** How long it thought, kept as the turn's events arrived; undefined when this session did not watch it from its start. */
  readonly clock: WorkClock | undefined;
}

/**
 * Everything a reply did before its answer, as one control from its first
 * piece of thinking to the saved reply. A reply with no tool call is the thought
 * line as it was; with calls it is the chip. Closed, nothing is added under it;
 * open (only when asked, and it stays as left), it is one list in the order
 * things happened: thinking rounds and one line per call. Where each call came
 * in the thinking is the turn's clock's; a reply it did not watch (a reload)
 * lists its thought first, then its calls.
 */
function Fold({ thinking, tools, secs, since, thinkingNow, busy, answering, stopped, clock }: FoldProps) {
  const [open, setOpen] = useState(false);
  const [rounds, setRounds] = useState<Readonly<Record<number, boolean>>>({});
  const body = useId();
  const running = busy ? tools.find((t) => t.state === "running") : undefined;
  const now = useTicker(250, busy && tools.length > 0);
  const t = busy ? Math.max(now, Date.now()) : Date.now();
  // the list in the order things happened: a thinking round before each call it led to
  const items: ({ kind: "think"; from: number; to: number } | { kind: "call"; step: ToolStep })[] = [];
  let from = 0;
  for (const s of tools) {
    const at = Math.min(clock?.at[s.callId] ?? thinking.length, thinking.length);
    if (at > from) items.push({ kind: "think", from, to: at });
    from = Math.max(from, at);
    items.push({ kind: "call", step: s });
  }
  if (thinking.length > from) items.push({ kind: "think", from, to: thinking.length });
  /** A round's seconds: its closed spans on the clock; none when the clock did not watch it. */
  const roundSecs = (a: number, b: number) => {
    const spans = clock?.spans.filter((s) => s.from >= a && s.from < b) ?? [];
    return spans.length === 0 ? undefined : Math.max(1, Math.round(spans.reduce((n, s) => n + s.ms, 0) / 1000));
  };
  const line = (
    <ToggleLine open={open} onToggle={() => setOpen(!open)} body={body} chip={tools.length > 0} live={thinkingNow}
      step={tools.length === 0 ? null : chipStep(thinking, tools, clock, t, running, answering, busy)} busy={busy}>
      {thinkingNow && since !== undefined ? <ThinkingLabel since={since} /> : <ThoughtLabel secs={secs} />}
    </ToggleLine>
  );
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
                live={busy && i === items.length - 1 && (clock === undefined ? running === undefined && !answering : clock.thinking)}
                secs={roundSecs(it.from, it.to)}
                open={rounds[it.from] ?? i === items.length - 1} onToggle={(o) => setRounds({ ...rounds, [it.from]: o })} />
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

/** The last call failed: it ended as "error" and no Stop cut it. */
function lastFailed(tools: readonly ToolStep[]): boolean {
  const last = tools.at(-1);
  return last !== undefined && last.state === "error" && !cutByStop(last);
}

/**
 * The chip's state. Thinking seconds are the turn's clock, never rebuilt here:
 * a reply the clock did not watch shows the bulb with no number. The red mark
 * means one thing, the last call failed, and only once the turn has ended.
 *
 * While the reply is busy one part is always lit (owner, chat row 24): the wrench while a
 * call runs, the bulb while it thinks, and the bulb again from a call's end to the next
 * word, when the model is reading the result (minutes on a crowded GPU). A model that
 * never thinks has no bulb, so its wrench stays lit then. The answer's own words are the
 * motion once they stream.
 */
export function chipStep(thinking: string, tools: readonly ToolStep[], clock: WorkClock | undefined, now: number,
  running: ToolStep | undefined, answering: boolean, busy: boolean): ChipStep {
  const thinkingNow = clock === undefined ? thinking !== "" && !answering : clock.thinking;
  const reading = running === undefined && !thinkingNow && !answering;
  return {
    think: thinking === "" ? null : clock === undefined ? undefined : thoughtSecs(clock, now),
    calls: tools.length,
    lit: !busy ? null : running !== undefined ? "calls" : thinkingNow ? "think" : reading ? (thinking === "" ? "calls" : "think") : null,
    failed: !busy && lastFailed(tools),
    words: !busy ? "" : running !== undefined ? running.summary : thinkingNow ? "Thinking" : reading ? "Reading the result" : "",
  };
}

/** The control that opens a reply's fold: the thought line as it was, or the chip with the current step beside it. */
function ToggleLine({ open, onToggle, body, chip, live, step, busy, children }: { open: boolean; onToggle: () => void; body: string; chip: boolean; live: boolean; step: ChipStep | null; busy: boolean; children: ReactNode }) {
  return (
    <div className={open ? "fold-line open" : "fold-line"}>
      <button type="button" className={chip ? "think fold" : live ? "think live" : "think"} aria-expanded={open} aria-controls={body}
        aria-label={step === null ? undefined : chipName(step, busy)} onClick={onToggle}>
        {step === null ? (
          <>
            <span className="th-i">
              <Icon id="bulb" />
            </span>
            {children}
            <span className="th-x">
              <Icon id="down" />
            </span>
          </>
        ) : <ChipFace step={step} />}
      </button>
      {/* kept mounted while busy, so a step change swaps words in place and never adds or drops a node */}
      {step !== null && (busy || step.words !== "") ? <ChipWords step={step} /> : null}
    </div>
  );
}

/** One thinking round in the open fold: its text, growing live; once the next step starts it closes to "Thought · 6 s" and reopens on a click. */
function ThoughtRound({ text, live, secs, open, onToggle }: { text: string; live: boolean; secs: number | undefined; open: boolean; onToggle: (open: boolean) => void }) {
  const id = useId();
  return (
    <>
      <button type="button" className="th-line" aria-expanded={open} aria-controls={id} onClick={() => onToggle(!open)}>
        <span className="wr-st">
          <Icon id="bulb" />
        </span>
        <span className="wr-h">{live ? "Thinking" : secs === undefined ? "Thought" : `Thought · ${secs} s`}</span>
        <span className="wr-x">
          <Icon id="down" />
        </span>
      </button>
      <div className="think-body" id={id}>{text}</div>
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
  const st = cut ? "rej" : step.state === "running" ? "run" : step.state === "error" ? "rej" : "done";
  const label = toolLabel(step.name);
  // the contract has no read-only flag yet; a `-readonly` flag in the call is the evidence the design's word rests on
  const ro = /(^|\s)-readonly(\s|$)/.test(step.detail ?? "") ? "read-only" : "";
  const lead = ro === "" ? label : `${label} · ${ro}`;
  const dur = duration(step.durationMs);
  // the summary is said once: "Read notes.md" needs no "Read ·" after it
  const named = step.summary.toLowerCase().startsWith(label.toLowerCase());
  const meta = st === "run" ? (named ? "running" : `${label} · running`) : cut ? (named ? "stopped" : `${label} · stopped`) : step.state === "error" ? (named ? "failed" : `${label} · failed`) : dur === "" ? lead : null;
  const [line = "", ...rest] = (step.detail ?? "").split("\n");
  const { cmd, shell } = callLine(line);
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
      <div className="wr-body" tabIndex={open ? 0 : -1} aria-label={`${step.summary}: details`}>
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

/** What a pending card is doing, as a screen reader hears it; on screen a running job is the spinner and its numbers. */
function jobWords(job: ImageEvent): string {
  if (job.phase === "freeing") return "Freeing memory";
  if (job.state === "queued") return "Waiting for the GPU";
  const pct = Math.round((job.progress ?? 0) * 100);
  return pct > 0 ? `Making image · ${pct}%` : "Making image";
}

/** A running job beside its spinner: the percent once there is one, and the seconds since it was asked for. */
function RunningNumbers({ job, since }: { job: ImageEvent; since: number }) {
  const now = useTicker(1000, true);
  const pct = Math.round((job.progress ?? 0) * 100);
  const secs = Math.max(0, Math.floor((now - since) / 1000));
  return <p aria-hidden="true">{pct > 0 ? `${pct}% · ${secs} s` : `${secs} s`}</p>;
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
  const card = <div className="image-job" style={size} data-job={job.jobId} data-image-job={job.state} data-fit={job.state === "error" && job.errorKind === "wont-fit" ? "refuse" : undefined}>
    {/* the model and size belong to the result: while it runs the composer already names them */}
    {ran === undefined || pending || tile ? null : <span className="image-job-model">{model} · {sizeLabel(ran.width, ran.height)}</span>}
    {job.state === "done" && job.imagePath ? <ImageOut path={job.imagePath} origin={origin} token={token} /> : <div className="image-job-state" role="status" aria-label={pending ? jobWords(job) : undefined}>
      <Icon id={pending ? "spin" : "alert"} cls={pending ? "spin" : undefined} />
      {job.state === "running" && job.phase === undefined ? <RunningNumbers job={job} since={since} /> : <p>{pending ? jobWords(job) : job.message ?? "The image did not finish; try again."}</p>}
      {stopCovers ? null : <button type="button" className="qa" disabled={busy} onClick={() => void action()}>{pending ? "Cancel image" : "Try again"}</button>}
      {error ? <p>{error}</p> : null}
    </div>}
  </div>;
  return caption === undefined ? card : <figure className="image-job-fig">{card}<figcaption className="image-job-prompt">{caption}</figcaption></figure>;
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
/** The model never sees a stopped reply again; the stop square's tooltip and name are the one place that says so. */
const UNSEEN = "Stopped. The model won't see this reply.";

/** A stopped reply's mark: the stop square, then the seconds when the person pressed Stop. */
function StopMark({ secs }: { secs?: number | undefined }) {
  return (
    <span className="stop-mark">
      {/* focusable, so the keyboard reaches the one place that says the model won't see this reply */}
      <span role="img" tabIndex={0} aria-label={UNSEEN} data-tip={esc(UNSEEN)} />
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
  /** How long it thought, from the turn's events; undefined when this session did not watch it. */
  readonly clock: WorkClock | undefined;
  readonly secs: number | undefined;
  readonly allowedLinks: ReadonlySet<string> | undefined;
  /** Why this session saw the reply stop: Stop's seconds go in the actions row, a reason's words in the timeline's note under the turn. */
  readonly note: StopNote | undefined;
  readonly meta: string;
  readonly regen: boolean;
  /** The thread's messages when an image card needs them, else EMPTY. */
  readonly thread: readonly Message[];
  readonly loading: boolean;
}

function Reply({ msg, live, text, paced, thinking, tools, clock, secs, allowedLinks, note, meta, regen, thread, loading, origin, token }: ReplyView) {
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
  // the model is thinking: the thought is the pill, and no status row says so again
  const thinkingNow = streaming && text === "" && calls.length === 0 && thinking !== "";
  const pending = paced.length < text.length;
  const shown = reveal(paced, streaming || pending);
  return (
    <div className={`turn a${interrupted ? " interrupted" : streaming || pending ? "" : " done"}${knownStop ? " noted" : ""}`} tabIndex={0} aria-label={interrupted ? "Interrupted reply" : "Reply"} data-received={text.length} data-revealed={paced.length}>
      {thinking !== "" || calls.length > 0 ? (
        <Fold thinking={thinking} tools={calls} secs={secs} since={thinkingNow ? thoughtOrigin(live) : undefined} thinkingNow={thinkingNow}
          busy={streaming} answering={text !== ""} stopped={end !== undefined || interrupted} clock={clock} />
      ) : null}
      {notes.map((t) => <ToolRow key={t.callId} step={t} stopped={end !== undefined || interrupted} />)}
      {msg?.imageJob ? <ImageCard msg={msg} thread={thread} origin={origin} token={token} /> : shown !== "" ? <Markdown text={shown} live={streaming || pending} allowedLinks={allowedLinks} /> : null}
      {(msg?.imageJob ? [] : msg?.images ?? []).map((p) => <ImageOut key={p} path={p} origin={origin} token={token} />)}
      {(streaming || pending) && text !== "" ? (
        <div className="working writing" role="status">
          <span className="ph">Writing</span>
        </div>
      ) : null}
      {streaming && text === "" && calls.length === 0 && !thinkingNow ? <Working startedAt={live.startedAt} loading={loading} thinking={thinking !== ""} /> : null}
      {end?.kind === "error" ? (
        <div className="err-line" data-tip={esc(end.message)}>
          <Icon id="alert" cls="s14" />
          <span>{SAYS_WHY.has(end.code) ? end.message : end.code === "closed" ? "The connection dropped before this reply finished." : "The reply didn't finish."}</span>
          <button type="button" className="qa" onClick={retry}>
            Retry
          </button>
        </div>
      ) : null}
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
  const ft = useStore((s) => (msg === undefined ? undefined : s.firstToken[msg.id]));
  const tt = useStore((s) => (msg === undefined ? undefined : s.thought[msg.id]));
  const clock = useStore((s) => (msg === undefined ? live?.clock : s.clocks[msg.id]));
  const loading = useStore((s) => live !== null && s.loads[live.model]?.state === "loading");
  const name = describeModel(msg?.model ?? live?.model ?? "", catalog).name;
  const text = msg?.content ?? live?.text ?? "";
  const tools = msg?.tools ?? live?.tools ?? NO_TOOLS;
  const queuedImage = tools.some(t => t.name === "image" && t.state === "done");
  const messages = useStore(s => queuedImage ? s.messages[threadId] ?? EMPTY : EMPTY);
  const allowedLinks = useMemo(() => imageTurnLinks(messages, tools), [messages, tools]);
  const note = useStore(s => msg === undefined ? undefined : s.stopNotes[msg.id]);
  const secs = live === null
    ? savedThoughtSecs(tt, ft, note, text, msg?.thinking ?? "")
    // set at the first word or at Stop; until then the time so far, from the model being ready
    // stopped while thinking with no thought time kept: the thought lasted until Stop, not until this render
    : live.thinkingSecs ?? (live.firstTokenAt === undefined && live.end?.kind === "stopped" ? Math.max(1, live.end.secs)
      : thoughtSecsAt(live, live.firstTokenAt ?? Date.now()));
  const paced = usePacedText(text, live !== null && live.end === undefined);
  if (msg === undefined && live === null) return null;
  // An Image turn's reply is its picture card, a row of its own with its progress and Cancel:
  // the turn shows its question until that is saved, and nothing of a chat reply.
  if (msg === undefined && live?.image === true) return live.pendingUser != null ? <UserBubble text={live.pendingUser} images={live.pendingImages} time={turnTime(live.startedAt)} /> : null;
  if (msg !== undefined) countRender(msg.id);
  return (
    <>
      {live?.pendingUser != null ? <UserBubble text={live.pendingUser} images={live.pendingImages} time={turnTime(live.startedAt)} /> : null}
      <Reply msg={msg} live={live} text={text} paced={paced} thinking={msg?.thinking ?? live?.thinking ?? ""} tools={tools} clock={clock} secs={secs}
        allowedLinks={allowedLinks} note={note}
        meta={msg === undefined ? replyMeta(name, {}, live?.end?.kind === "stopped" && live.firstTokenAt !== undefined ? live.firstTokenAt - live.startedAt : undefined) : replyMeta(name, msg, ft)}
        regen={msg === undefined ? live?.end?.kind === "stopped" : last} thread={messages} loading={loading} origin={origin} token={token} />
    </>
  );
});

/**
 * A saved reply's "Thought for N s", as the live turn showed it: from the model being ready until its
 * first word, or, stopped while thinking, until Stop. Without that, from the send to the first word.
 */
function savedThoughtSecs(thought: number | undefined, ft: number | undefined, note: StopNote | undefined, text: string, thinking: string): number | undefined {
  if (thought !== undefined) return thought;
  if (ft !== undefined) return Math.max(1, Math.round(ft / 1000));
  return note?.kind === "stopped" && text === "" && thinking !== "" ? Math.max(1, note.secs) : undefined;
}

/** A saved reply: props only, so a keystroke or a token elsewhere runs nothing here. */
const SavedReply = memo(function SavedReply({ msg, last, thread, catalog, ft, tt, clock, note, origin, token }: RowProps & { catalog: readonly CatalogEntry[] | undefined; ft: number | undefined; tt: number | undefined; clock: WorkClock | undefined; note: StopNote | undefined }) {
  countRender(msg.id);
  const tools = msg.tools ?? NO_TOOLS;
  const allowedLinks = useMemo(() => imageTurnLinks(thread, tools), [thread, tools]);
  return (
    <Reply msg={msg} live={null} text={msg.content} paced={msg.content} thinking={msg.thinking ?? ""} tools={tools} clock={clock}
      secs={savedThoughtSecs(tt, ft, note, msg.content, msg.thinking ?? "")} allowedLinks={allowedLinks}
      note={note} meta={replyMeta(describeModel(msg.model ?? "", catalog).name, msg, ft)} regen={last} thread={thread} loading={false} origin={origin} token={token} />
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
  const { firstToken, thought, clocks } = useStore(replyTimes);
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
  const grow = useCallback((count: number) => {
    if (skipNow.current === 0) return;
    const key = turnsNow.current[Math.max(0, skipNow.current - count)]?.key;
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

  // the rest of the thread mounts in idle time, so find-in-page and select-all see all of it
  useEffect(() => (first === null || skip === 0 ? undefined : whenIdle((timeLeft) => {
    do grow(turnsNow.current.length - skipNow.current <= FIRST_TURNS ? SLICE_TURNS : FILL_TURNS); while (skipNow.current > 0 && timeLeft() > SLICE_MS);
  })), [first, skip, grow]);

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
        {turns.slice(skip).map(({ msg: m, key }, j) => {
          if (m !== undefined && retries.has(m.id)) return null;
          const last = skip + j === messages.length - 1;
          const why = m === undefined ? undefined : stopNotes[m.id];
          return (
            <Fragment key={key}>
              {m?.role === "user" ? <UserTurn msg={row(m)} noted={why?.kind === "said"} />
                : m === undefined || wasLive.has(key) ? <LiveReply threadId={threadId} msg={m === undefined ? undefined : row(m)} last={last} origin={origin} token={token} />
                : <SavedReply msg={row(m)} last={last} thread={readsThread(m) ? messages : EMPTY} catalog={catalog} ft={firstToken[m.id]} tt={thought[m.id]} clock={clocks[m.id]} note={why} origin={origin} token={token} />}
              {/* a reason the person did not cause, in its own words; under a reply, the stop square says the model won't see it */}
              {m !== undefined && why?.kind === "said" ? (
                <div className={m.role === "user" ? "stop-note under-u" : "stop-note"} role="status">
                  {m.role === "assistant" ? <StopMark /> : null}
                  {why.words}
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
