import { type KeyboardEvent, useRef, useState } from "react";
import { focusOnDraw } from "../lib/ui/kit/focus.ts";
import { createPortal } from "react-dom";
import { MEASURE_VERSION, type MeasureCheck, type MeasurePart, type ModelMeasure } from "@gates-local/contracts";
import { k } from "../lib/words/format.ts";
import { Icon } from "../lib/ui/icons.tsx";
import { tpsText } from "../models/model-speed.tsx";
import { measureModel } from "../lib/session/index.ts";
import { measureOf, measuringNow } from "./measures.ts";
import { useStore } from "../lib/store/store.ts";

const PART: Readonly<Record<MeasurePart, string>> = { tools: "Tools", files: "Files", database: "Database", instructions: "Follows instructions", pages: "Pages" };
const ORDER: readonly MeasurePart[] = ["tools", "files", "database", "instructions", "pages"];
const partOf = (c: MeasureCheck): MeasurePart => (c.kind === "sql" ? "database" : c.kind);

export const SLOW_WORDS: Readonly<Record<NonNullable<ModelMeasure["slow"]>, string>> = {
  decode: "Slower than you read: under 10 tok/s",
  "first-token": "Slow to start: over 10 s to the first word",
};

const seconds = (ms: number) => `${ms < 10_000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000)} s`;
export const samplingText = (m: ModelMeasure) => m.sampling ? `Temperature ${m.sampling.temperature}, seed ${m.sampling.seed}, model defaults` : "Your chat's sampling settings";
export const isOlder = (m: ModelMeasure) => m.version === undefined;
export const isEarlier = (m: ModelMeasure) => m.version !== undefined && m.version !== MEASURE_VERSION;
export const EARLIER_WORDS = "Earlier checks";
export const earlierWords = (m: ModelMeasure): string => {
  if (!isEarlier(m)) return "";
  const what = m.version === 3 ? "a check the model cut short was skipped; it fails now" : "fewer tasks, and some replies graded differently";
  return `${EARLIER_WORDS}: ${what}. Measure again to set it beside newer scores.`;
};

export function MeasureDetail({ name, label, onClose }: { name: string; label: string; onClose: () => void }) {
  const m = useStore((s) => measureOf(s, name));
  const busy = useStore((s) => measuringNow(s) !== undefined);
  const box = useRef<HTMLDivElement>(null);
  if (m === undefined) return null;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Tab") {
      const els = [...(box.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [])];
      const at = els.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      els[(at + (e.shiftKey ? -1 : 1) + els.length) % els.length]?.focus();
    }
  };
  const older = isOlder(m);
  return createPortal(
    <div className="mp-scrim" data-testid="models.measure.scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mp-dlg md" role="dialog" aria-modal="true" aria-labelledby="md-t" data-testid="models.measure.detail" ref={box} tabIndex={-1} onKeyDown={onKey}>
        <div className="md-head">
          <h3 id="md-t">{label}</h3>
          <span className="md-score" aria-label={older ? `Older score: ${m.checks.filter((c) => c.ok).length} of ${m.checks.length} checks` : `Score ${m.score} of 100`}>
            {older ? `${m.checks.filter((c) => c.ok).length}/${m.checks.length}` : m.score}
          </span>
        </div>
        <div className="md-facts">
          <span><Icon id="gauge" cls="s14" />{k(m.numCtx)}</span>
          {older ? null : <span><Icon id="bulb" cls="s14" />{m.think === undefined ? "No thinking" : m.think ? "Thinking on" : "Thinking off"}</span>}
          <span><Icon id="speed" cls="s14" />{tpsText(m.tokensPerSecond) ?? "–"}</span>
          {m.firstTokenMs === undefined ? null : <span><Icon id="clock" cls="s14" />{seconds(m.firstTokenMs)} to first word</span>}
          {older ? null : <span data-testid="models.measure.sampling"><Icon id="sliders" cls="s14" />{samplingText(m)}</span>}
        </div>
        {m.slow ? <p className="md-slow" data-testid="models.measure.slow"><Icon id="snail" cls="s14" />{SLOW_WORDS[m.slow]}</p> : null}
        {older ? <p className="md-old" data-testid="models.measure.older">Older measure: eight checks of tools and a database, before Files, Instructions and Pages. Measure again for the five parts.</p> : null}
        {isEarlier(m) ? <p className="md-old" data-testid="models.measure.earlier"><Icon id="clock" cls="s14" />{earlierWords(m)}</p> : null}
        {older ? null : <Parts m={m} />}
        <MeasureNotes m={m} />
        <MeasureChecks m={m} />
        <div className="mp-r2">
          <button type="button" className="btn outline" data-testid="models.measure.again" disabled={busy} onClick={() => { void measureModel(name); onClose(); }}>
            <Icon id="speed" cls="s14" />Measure again
          </button>
          <button ref={focusOnDraw} type="button" className="btn" data-testid="models.measure.close" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export interface ShortPart { part: MeasurePart; counted: number; total: number; waiting: boolean }

export function shortParts(m: ModelMeasure): ShortPart[] {
  if (isOlder(m)) return [];
  return ORDER.flatMap((part) => {
    const mine = m.checks.filter((c) => partOf(c) === part);
    const counted = mine.filter((c) => c.state === undefined).length;
    return counted < mine.length ? [{ part, counted, total: mine.length, waiting: mine.some((c) => c.state === "pending") }] : [];
  });
}

const and = (words: readonly string[]) => words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;

export function shortWords(m: ModelMeasure): string | undefined {
  const short = shortParts(m);
  if (short.length === 0) return undefined;
  const whole = short.filter((p) => p.counted === 0).map((p) => PART[p.part]);
  return [...(whole.length ? [`Without ${and(whole)}`] : []), ...short.filter((p) => p.counted > 0).map((p) => `${PART[p.part]} ${p.counted} of ${p.total}`)].join(" · ");
}

export function MeasureNotes({ m }: { m: ModelMeasure }) {
  const pending = m.checks.filter((c) => c.state === "pending").length;
  const short = shortParts(m).filter((p) => !(p.waiting && p.counted === 0));
  const left = short.filter((p) => p.counted === 0).map((p) => PART[p.part]);
  const fewer = short.filter((p) => p.counted > 0).map((p) => `${PART[p.part]} over ${p.counted} of its ${p.total} checks`);
  const { across } = skipsSaid(m.checks);
  return (
    <>
      {pending ? <p className="md-old" data-testid="models.measure.pending">{pending === 1 ? "1 page waits" : `${pending} pages wait`} for this app's window to run {pending === 1 ? "it" : "them"}; the score leaves Pages out until then.</p> : null}
      {across.map((why) => <p key={why} className="md-old" data-testid="models.measure.skipped">Skipped: {why}</p>)}
      {left.length || fewer.length ? (
        <p className="md-old" data-testid="models.measure.left-out">
          The score {left.length ? `leaves ${and(left)} out` : ""}{left.length && fewer.length ? ", and counts " : fewer.length ? "counts " : ""}{and(fewer)}.
        </p>
      ) : null}
    </>
  );
}

export function skipsSaid(checks: readonly MeasureCheck[]) {
  const by = new Map<string, MeasureCheck[]>();
  for (const c of checks) if (c.state === "skipped" && c.why) by.set(c.why, [...by.get(c.why) ?? [], c]);
  const across: string[] = [];
  const under = new Map<MeasurePart, string[]>();
  for (const [why, mine] of by) {
    const parts = new Set(mine.map(partOf));
    if (parts.size > 1) across.push(why);
    else if (mine.length > 1) under.set(partOf(mine[0]!), [...under.get(partOf(mine[0]!)) ?? [], why]);
  }
  return { across, under, said: (c: MeasureCheck) => c.state === "skipped" && c.why !== undefined && by.get(c.why)!.length > 1 };
}

export function MeasureChecks({ m }: { m: ModelMeasure }) {
  const { under, said } = skipsSaid(m.checks);
  return (
    <div className="md-checks">
      {ORDER.map((part) => {
        const mine = m.checks.filter((c) => partOf(c) === part);
        return mine.length === 0 ? null : (
          <section key={part} aria-label={PART[part]}>
            <h4>{PART[part]}</h4>
            {under.get(part)?.map((why) => <div key={why} className="md-why" data-testid={`models.measure.skipped-${part}`}>{why}</div>)}
            {mine.map((c) => <Check key={c.id} c={c} quiet={said(c)} />)}
          </section>
        );
      })}
    </div>
  );
}

function Parts({ m }: { m: ModelMeasure }) {
  const parts = m.parts ?? [];
  return (
    <div className="md-parts" role="table" aria-label="Parts of the score">
      <div className="md-prow md-ph" role="row">
        <span role="columnheader">Part</span>
        <span role="columnheader">Passed</span>
        <span role="columnheader">Weight</span>
      </div>
      {ORDER.map((part) => {
        const p = parts.find((x) => x.part === part);
        return (
          <div key={part} className={p ? "md-prow" : "md-prow none"} role="row" data-testid={`models.measure.part-${part}`}>
            <span role="cell">{PART[part]}</span>
            <span role="cell" className="md-n">{p ? `${p.passed}/${p.total}` : "–"}</span>
            <span role="cell" className="md-n">{p ? p.weight : "–"}</span>
          </div>
        );
      })}
    </div>
  );
}

function Check({ c, quiet = false }: { c: MeasureCheck; quiet?: boolean }) {
  const [open, setOpen] = useState(false);
  const evidence = c.reply !== undefined || c.calls !== undefined || c.result !== undefined || c.tokens !== undefined;
  const mark = c.state === "pending" ? "clock" : c.state === "skipped" ? "lock" : c.ok ? "check" : c.cutThinking ? "bulb" : "x";
  const word = c.state === "pending" ? "Waiting" : c.state === "skipped" ? "Skipped" : c.ok ? "Passed" : c.cutThinking ? "Cut while thinking" : "Failed";
  return (
    <div className={`md-check ${c.state ?? (c.ok ? "ok" : "no")}`} data-testid={`models.measure.check-${c.id}`}>
      <button type="button" className="md-cl" aria-expanded={evidence ? open : undefined} disabled={!evidence} onClick={() => setOpen((o) => !o)}>
        <span className="md-mk" role="img" aria-label={word}><Icon id={mark} cls="s14" /></span>
        <span className="md-needs">{c.needs ?? c.id}</span>
        {c.tokens === undefined ? null : <span className="md-n">{c.tokens}{c.cut ? " cut" : ""}</span>}
      </button>
      {c.why && !c.ok && !quiet ? <div className="md-why">{c.why}</div> : null}
      {open ? (
        <div className="md-ev">
          {c.calls?.map((call, i) => <pre key={i} className="md-call">{call}</pre>)}
          {c.reply ? <pre className="md-reply">{c.reply}</pre> : null}
          {c.result ? <pre className="md-call">{c.result}</pre> : null}
          {c.ms === undefined ? null : <div className="md-n">{seconds(c.ms)}</div>}
        </div>
      ) : null}
    </div>
  );
}
