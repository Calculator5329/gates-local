// Settings › Models, Measure's detail (row 29): what a model's score is made of. Opened from the
// score on its row (the phone's measure line on a phone). The run's window, thinking, speed and
// first word; the five parts with their weights; and each check with what a pass needs, what
// went wrong, and on a click what the model wrote and which tools it called.
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MeasureCheck, MeasurePart, ModelMeasure } from "@gates-local/contracts";
import { k } from "./format.ts";
import { Icon } from "./icons.tsx";
import { tpsText } from "./model-speed.tsx";
import { measureModel } from "./session.ts";
import { measureOf, measuringNow } from "./session/measures.ts";
import { useStore } from "./store.ts";

const PART: Readonly<Record<MeasurePart, string>> = { tools: "Tools", files: "Files", database: "Database", instructions: "Follows instructions", pages: "Pages" };
/** The parts in the order the detail lists them; older checks (kind "sql") are the database's. */
const ORDER: readonly MeasurePart[] = ["tools", "files", "database", "instructions", "pages"];
const partOf = (c: MeasureCheck): MeasurePart => (c.kind === "sql" ? "database" : c.kind);

/** Below this the model writes slower than a person reads; past that first word a person stops waiting (server suite.ts). */
export const SLOW_WORDS: Readonly<Record<NonNullable<ModelMeasure["slow"]>, string>> = {
  decode: "Slower than you read: under 10 tok/s",
  "first-token": "Slow to start: over 10 s to the first word",
};

const seconds = (ms: number) => `${ms < 10_000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000)} s`;
/** A measure from before the five parts: eight checks, kept as they were. */
export const isOlder = (m: ModelMeasure) => m.version === undefined;

export function MeasureDetail({ name, label, onClose }: { name: string; label: string; onClose: () => void }) {
  const m = useStore((s) => measureOf(s, name));
  const busy = useStore((s) => measuringNow(s) !== undefined);
  const box = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => close.current?.focus(), []);
  // The measure went away (the model's weights changed): nothing is left to show.
  useEffect(() => {
    if (m === undefined) onClose();
  }, [m, onClose]);
  if (m === undefined) return null;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Tab") {
      // keep focus inside the dialog
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
        </div>
        {m.slow ? <p className="md-slow" data-testid="models.measure.slow"><Icon id="snail" cls="s14" />{SLOW_WORDS[m.slow]}</p> : null}
        {older ? <p className="md-old" data-testid="models.measure.older">Older measure: eight checks of tools and a database, before Files, Instructions and Pages. Measure again for the five parts.</p> : null}
        {older ? null : <Parts m={m} />}
        <MeasureNotes m={m} />
        <MeasureChecks m={m} />
        <div className="mp-r2">
          <button type="button" className="btn outline" data-testid="models.measure.again" disabled={busy} onClick={() => { void measureModel(name); onClose(); }}>
            <Icon id="speed" cls="s14" />Measure again
          </button>
          <button ref={close} type="button" className="btn" data-testid="models.measure.close" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** What the score leaves out: pages still waiting for a window, and parts whose every check was skipped. */
export function MeasureNotes({ m }: { m: ModelMeasure }) {
  const pending = m.checks.filter((c) => c.state === "pending").length;
  // Parts whose every check was skipped: the score is over the others, so it says which it left out.
  const left = isOlder(m) ? [] : ORDER.filter((part) => {
    const mine = m.checks.filter((c) => partOf(c) === part);
    return mine.length > 0 && mine.every((c) => c.state === "skipped");
  });
  return (
    <>
      {pending ? <p className="md-old" data-testid="models.measure.pending">{pending === 1 ? "1 page waits" : `${pending} pages wait`} for this app's window to run {pending === 1 ? "it" : "them"}; the score leaves Pages out until then.</p> : null}
      {left.length ? <p className="md-old" data-testid="models.measure.left-out">The score leaves {left.map((p) => PART[p]).join(" and ")} out.</p> : null}
    </>
  );
}

/** The one reason every check of a part was skipped for (Run commands off, the sandbox off), if one. */
const skippedFor = (mine: readonly MeasureCheck[]): string | undefined => {
  const why = mine[0]?.why;
  return why !== undefined && mine.every((c) => c.state === "skipped" && c.why === why) ? why : undefined;
};

/** Each part's checks under its name; a part skipped for one reason says it once, under the name. */
export function MeasureChecks({ m }: { m: ModelMeasure }) {
  return (
    <div className="md-checks">
      {ORDER.map((part) => {
        const mine = m.checks.filter((c) => partOf(c) === part);
        const why = skippedFor(mine);
        return mine.length === 0 ? null : (
          <section key={part} aria-label={PART[part]}>
            <h4>{PART[part]}</h4>
            {why ? <div className="md-why" data-testid={`models.measure.skipped-${part}`}>{why}</div> : null}
            {mine.map((c) => <Check key={c.id} c={c} quiet={why !== undefined} />)}
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

/** `quiet`: its part already said why it was skipped. */
function Check({ c, quiet = false }: { c: MeasureCheck; quiet?: boolean }) {
  const [open, setOpen] = useState(false);
  const evidence = c.reply !== undefined || c.calls !== undefined || c.result !== undefined || c.tokens !== undefined;
  const mark = c.state === "pending" ? "clock" : c.state === "skipped" ? "lock" : c.ok ? "check" : "x";
  const word = c.state === "pending" ? "Waiting" : c.state === "skipped" ? "Skipped" : c.ok ? "Passed" : "Failed";
  return (
    <div className={`md-check ${c.state ?? (c.ok ? "ok" : "no")}`} data-testid={`models.measure.check-${c.id}`}>
      <button type="button" className="md-cl" aria-expanded={evidence ? open : undefined} disabled={!evidence} onClick={() => setOpen((o) => !o)}>
        <span className="md-mk" role="img" aria-label={word}><Icon id={mark} cls="s14" /></span>
        <span className="md-needs">{c.needs ?? c.id}</span>
        {c.tokens === undefined ? null : <span className="md-n md-tok">{c.tokens}{c.cut ? " cut" : ""}</span>}
      </button>
      {c.why && !c.ok && !quiet ? <div className="md-why">{c.why}</div> : null}
      {open ? (
        <div className="md-ev">
          {c.calls?.map((call, i) => <pre key={i} className="md-call">{call}</pre>)}
          {c.reply ? <pre className="md-reply">{c.reply}</pre> : null}
          {c.result ? <pre className="md-call">{c.result}</pre> : null}
          {c.ms === undefined ? null : <div className="md-n md-ms">{seconds(c.ms)}</div>}
        </div>
      ) : null}
    </div>
  );
}
