import { useLayoutEffect, useRef, useState } from "react";
import { type MeasureCheck, type MeasureRun, type MeasureTurn, type ModelMeasure, pageBlocks, pageTitle } from "@gates-local/contracts";
import { Icon } from "../lib/ui/icons.tsx";
import { TurnSkel } from "../lib/ui/ui.tsx";
import { useStore } from "../lib/store/store.ts";
import { tpsText } from "../models/model-speed.tsx";
import { Markdown } from "../thread/markdown.tsx";
import { ThoughtRound, ToolRow } from "../thread/Thread.tsx";
import { stopMeasure } from "../lib/session/index.ts";
import { ScoreTop, gradeOf, seconds, whyShown } from "./MeasureScore.tsx";
import { checksOf, gradedOf } from "./MeasureLive.tsx";
import { measureOf, runOf } from "./measures.ts";

// why: a page draws as a still chip, as outside a thread there is no page panel for it to open
function pieces(text: string): ({ kind: "text"; text: string } | { kind: "page"; title: string; open: boolean })[] {
  const out: ({ kind: "text"; text: string } | { kind: "page"; title: string; open: boolean })[] = [];
  let at = 0;
  for (const b of pageBlocks(text)) {
    if (b.start > at) out.push({ kind: "text", text: text.slice(at, b.start) });
    out.push({ kind: "page", title: pageTitle(b.code), open: !b.closed });
    at = b.end;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });
  return out.filter((p) => p.kind === "page" || p.text.trim() !== "");
}

function Answer({ text, live, check }: { text: string; live: boolean; check: MeasureCheck | undefined }) {
  const mark = check === undefined ? undefined : gradeOf(check);
  return (
    <>
      {pieces(text).map((p, i) => p.kind === "page" ? (
        <div key={i} className="pg-chip mc-page" data-testid="measure.chat.page">
          <Icon id="page" />
          <span className="pg-t">{p.title}</span>
          {live && p.open ? <span className="run-dot" aria-hidden="true" /> : mark === undefined ? null : <span className={`mc-mk ${mark.tone}`} role="img" aria-label={mark.word}><Icon id={mark.icon} cls="s14" /></span>}
        </div>
      ) : live ? (
        // why: plain text while it streams; a reply's markdown is drawn once, when it is whole
        <div key={i} className="md mc-plain" data-testid="measure.chat.plain">{p.text}</div>
      ) : (
        <Markdown key={i} text={p.text} />
      ))}
    </>
  );
}

function Grade({ check, why }: { check: MeasureCheck | undefined; why: boolean }) {
  if (check === undefined) return <div className="mc-grade" aria-hidden="true" />;
  const { icon, word, tone } = gradeOf(check);
  const cost = [check.tokens === undefined ? "" : `${check.tokens} tokens${check.cut ? " cut" : ""}`, check.ms === undefined ? "" : seconds(check.ms)].filter((x) => x !== "").join(" · ");
  return (
    <>
      <div className={`mc-grade ${tone}`} data-testid="measure.chat.grade">
        <span className="mc-mk" role="img" aria-label={word}><Icon id={icon} cls="s14" /></span>
        <span className="mc-needs">{check.needs ?? check.id}</span>
        {cost === "" ? null : <span className="mc-cost">{cost}</span>}
      </div>
      {why && check.why !== undefined ? <div className="mc-why" data-testid="measure.chat.why">{check.why}</div> : null}
    </>
  );
}

function Ask({ text }: { text: string }) {
  return (
    <div className="turn u" aria-label="Question">
      <div className="u-row"><div className="bubble">{text}</div></div>
    </div>
  );
}

function Turn({ turn, check, live, why }: { turn: MeasureTurn; check: MeasureCheck | undefined; live: boolean; why: boolean }) {
  const [open, setOpen] = useState(false);
  const streaming = live && check === undefined;
  return (
    <>
      {turn.history?.map((h, i) => h.role === "user" ? <Ask key={i} text={h.content} /> : (
        <div key={i} className="turn a done"><Markdown text={h.content} /></div>
      ))}
      {turn.prompt === undefined ? null : <Ask text={turn.prompt} />}
      <div className={`turn a${streaming ? "" : " done"}`} data-testid="measure.chat.turn" data-check={turn.id} aria-label="Answer">
        {turn.thinking === "" ? null : <ThoughtRound text={turn.thinking} live={streaming && turn.answer === "" && turn.steps.length === 0} secs={undefined} open={open} onToggle={setOpen} />}
        {turn.steps.length === 0 ? null : <div className="mc-steps">{turn.steps.map((s) => <ToolRow key={s.callId} step={s} />)}</div>}
        <Answer text={turn.answer} live={streaming} check={check} />
        <Grade check={check} why={why} />
      </div>
    </>
  );
}

// why: within this many pixels of the end, the view keeps to the end as the answer grows
const NEAR_END = 48;

function useKeptAtEnd(grows: unknown, live: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const kept = useRef(true);
  // oxlint-disable-next-line gates/effect-needs-reason -- a live run stays at the end it was at; a finished one opens on its score at the top
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (!live) el.scrollTop = 0;
    else if (kept.current) el.scrollTop = el.scrollHeight;
  }, [grows, live]);
  const onScroll = () => {
    const el = ref.current;
    if (el !== null) kept.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END;
  };
  return { ref, onScroll };
}

function Strip({ model, graded }: { model: string; graded: number }) {
  const run = useStore((s) => runOf(s, model));
  const ended = useStore((s) => (s.measureLive?.model === model ? s.measureLive.ended : undefined));
  const [asked, setAsked] = useState(false);
  return (
    <div className={`mc-strip${run === undefined ? " ended" : ""}`} data-testid="measure.chat.strip" role="status">
      {run === undefined ? (
        <>
          <Icon id={ended === "Stopped" ? "x" : "alert"} cls="s14" />
          <span className="mc-end">{ended === "Stopped" ? "Stopped. No score kept; the last one stays." : ended}</span>
        </>
      ) : <Going model={model} run={run} graded={graded} asked={asked} onStop={() => setAsked(true)} />}
    </div>
  );
}

function Going({ model, run, graded, asked, onStop }: { model: string; run: MeasureRun; graded: number; asked: boolean; onStop: () => void }) {
  const of = checksOf(run);
  const loading = run.state === "waiting" || run.done === 0;
  // why: once every check is graded the measure is saved, and only its pages are left to wait on
  const pages = run.done >= run.total - 1;
  return (
    <>
      <span className="mc-n">{loading ? "Loading model" : `${graded} of ${of}`}</span>
      <span className="mc-bar" aria-hidden="true"><span style={{ width: `${of > 0 ? (graded / of) * 100 : 0}%` }} /></span>
      <span className="mc-tps">{tpsText(run.tokensPerSecond) ?? ""}</span>
      <button type="button" className="btn outline mc-stop" data-testid="measure.chat.stop" disabled={asked || pages} style={pages ? { visibility: "hidden" } : undefined}
        onClick={() => { onStop(); void stopMeasure(model); }}>
        <span className="sqr" aria-hidden="true" />Stop
      </button>
    </>
  );
}

function Chat({ turns, grades, live, top, model }: { turns: readonly MeasureTurn[]; grades: (t: MeasureTurn) => MeasureCheck | undefined; live: boolean; top?: ModelMeasure; model: string }) {
  const checks = turns.flatMap((t) => { const c = grades(t); return c ? [c] : []; });
  const why = whyShown(checks, top !== undefined);
  const { ref, onScroll } = useKeptAtEnd(live ? turns : top, live);
  return (
    <>
      <div className="tl" ref={ref} onScroll={live ? onScroll : undefined}>
        <div className="col">
          {top === undefined ? null : <ScoreTop m={top} />}
          {turns.map((t) => {
            const c = grades(t);
            return <Turn key={t.id} turn={t} check={c} live={live} why={c !== undefined && why.has(c.id)} />;
          })}
          {live && turns.length === 0 ? <TurnSkel /> : null}
        </div>
      </div>
      {live ? <div className="cw"><Strip model={model} graded={gradedOf(turns)} /></div> : null}
    </>
  );
}

function Shown({ model }: { model: string }) {
  const live = useStore((s) => (s.measureLive?.model === model && (runOf(s, model) !== undefined || s.measureLive.ended !== undefined) ? s.measureLive : undefined));
  const m = useStore((s) => measureOf(s, model));
  const kept = useStore((s) => s.measureChats[model]);
  if (live !== undefined) return <Chat model={model} turns={live.turns} grades={(t) => t.check} live />;
  if (m !== undefined && kept?.at === m.at) return <Chat model={model} turns={kept.turns} grades={(t) => m.checks.find((c) => c.id === t.id)} live={false} top={m} />;
  return <div className="tl" aria-busy={m !== undefined || undefined}>{m === undefined ? null : <div className="col"><TurnSkel /></div>}</div>;
}

export function MeasureChat({ model }: { model: string }) {
  return <div className="mc" data-testid="measure.chat"><Shown model={model} /></div>;
}
