// The Usage pop-up's content, its own chunk: the range and Tokens / Speed
// switches, five numbers, a hand-drawn line per model from a zero baseline,
// and one row per model that follows the point in focus. The rows are the
// chart's text for screen readers. Figures change in place when a turn ends.
import { type KeyboardEvent, type PointerEvent, useMemo, useState, useSyncExternalStore } from "react";
import { PanelClose } from "./Panel.tsx";
import { pickerLabels } from "./picker-models.ts";
import { closeUsage, usageData } from "./session.ts";
import { NA, useStore } from "./store.ts";
import { esc } from "./ui.tsx";
import {
  METRICS, RANGES, type UsageLine, type UsageMetric, type UsagePrefs, type UsageRange, type UsageView,
  compact, duration, figuresAt, readPrefs, usageView, writePrefs,
} from "./usage-data.ts";
import "./usage.css";

const storage = () => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};
const memory = { getItem: () => null, setItem: () => {} };

/** The chart's drawing box; the SVG stretches to the panel and its strokes keep their width. */
const W = 1000;
const H = 160;

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const spanDayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const hourFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const exact = (n: number) => Math.round(n).toLocaleString();
const speedText = (v: number | null) => (v === null ? "–" : String(Math.round(v)));

/** 1, 2, 2.5 or 5 times a power of ten at or above v: the chart's top line. */
function niceCeil(v: number): number {
  if (v <= 0) return 0;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function periodName(view: UsageView, at: number): string {
  const start = view.periods[at]!.start;
  return view.hourly ? hourFmt.format(start) : dayFmt.format(start);
}

function spanName(view: UsageView): string {
  const first = view.periods[0]!.start;
  const last = view.periods.at(-1)!.start;
  const fmt = view.hourly ? hourFmt : spanDayFmt;
  return `${fmt.format(first)} – ${fmt.format(last)}`;
}

function values(l: UsageLine, metric: UsageMetric): (number | null)[] {
  return metric === "speed" ? l.speed : l.prompt.map((p, i) => p + l.completion[i]!);
}

/** One path per run of points with a value; a lone point is a dot. A null breaks the line. */
function pathOf(ys: readonly (number | null)[], top: number): { line: string; dots: string } {
  const n = ys.length;
  const x = (i: number) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number) => (top === 0 ? H : H - (v / top) * H);
  let line = "";
  let dots = "";
  for (let i = 0; i < n; i++) {
    const v = ys[i];
    if (v === null || v === undefined) continue;
    const prev = ys[i - 1];
    const next = ys[i + 1];
    const startsRun = prev === null || prev === undefined;
    const p = `${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    if (startsRun && (next === null || next === undefined)) dots += `M${p}h0`;
    else line += `${startsRun ? "M" : "L"}${p}`;
  }
  return { line, dots };
}

function Seg<T extends string>({ value, options, onPick, label }: { value: T; options: readonly (readonly [T, string])[]; onPick: (v: T) => void; label: string }) {
  return (
    <span className="mini-seg" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" className={v === value ? "on" : ""} aria-pressed={v === value} onClick={() => onPick(v)}>
          {text}
        </button>
      ))}
    </span>
  );
}

/** A total, with its exact figure as a tip when the face rounds it ("19.1k" is 19,134; "3" replies is said once). */
function Num({ value, label, tip, ph }: { value: string; label: string; tip: string; ph: boolean }) {
  return (
    <div className="us-num" data-tip={ph || tip === `${value} ${label}` ? undefined : esc(tip)}>
      <b>{ph ? <span className="us-ph" /> : value}</b>
      <span>{label}</span>
    </div>
  );
}

export function Usage() {
  const data = useSyncExternalStore(usageData.subscribe, usageData.get, usageData.get);
  const catalog = useStore((s) => (s.catalog === NA ? undefined : s.catalog));
  const [prefs, setPrefs] = useState<UsagePrefs>(() => readPrefs(storage() ?? memory));
  const [at, setAt] = useState<number | null>(null);
  const pick = (next: Partial<UsagePrefs>) => {
    const merged = { ...prefs, ...next };
    setPrefs(merged);
    writePrefs(storage() ?? memory, merged);
    setAt(null);
  };
  const read = data.read ?? { rows: [], models: [] };
  const ph = data.read === null;
  const view = useMemo(() => usageView(read, prefs.range, Date.now()), [read, prefs.range]);
  const labels = useMemo(() => pickerLabels(view.lines.flatMap((l) => (l.model === null ? [] : [l.model])), catalog), [view, catalog]);
  const drawn = prefs.metric === "speed" ? view.lines.filter((l) => l.model !== null) : view.lines;
  const top = niceCeil(Math.max(0, ...drawn.flatMap((l) => values(l, prefs.metric).filter((v): v is number => v !== null))));
  const n = view.periods.length;
  const rows = view.lines.map((l) => ({ l, f: figuresAt(l, at) }));
  const t = view.totals;

  const onChartKey = (e: KeyboardEvent) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (step !== undefined) {
      e.preventDefault();
      setAt((i) => (i === null ? (step < 0 ? n - 1 : 0) : Math.min(n - 1, Math.max(0, i + step))));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setAt(e.key === "Home" ? 0 : n - 1);
    }
  };
  const onChartMove = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const f = box.width === 0 ? 0 : (e.clientX - box.left) / box.width;
    setAt(n === 1 ? 0 : Math.min(n - 1, Math.max(0, Math.round(f * (n - 1)))));
  };
  const markX = at === null ? null : n === 1 ? W / 2 : (at / (n - 1)) * W;

  return (
    <div className="us">
      <div className="us-bar">
        <h2>Usage</h2>
        <div className="us-ctl">
          <Seg label="Range" value={prefs.range} options={RANGES} onPick={(range: UsageRange) => pick({ range })} />
          <Seg label="Chart" value={prefs.metric} options={METRICS} onPick={(metric: UsageMetric) => pick({ metric })} />
        </div>
        <PanelClose onClose={() => closeUsage()} />
      </div>
      <div className="us-nums">
        <Num ph={ph} value={compact(t.promptTokens + t.completionTokens)} label="tokens" tip={`${exact(t.promptTokens + t.completionTokens)} tokens`} />
        <Num ph={ph} value={compact(t.promptTokens)} label="in" tip={`${exact(t.promptTokens)} tokens in`} />
        <Num ph={ph} value={compact(t.completionTokens)} label="out" tip={`${exact(t.completionTokens)} tokens out`} />
        <Num ph={ph} value={compact(t.replies)} label="replies" tip={`${exact(t.replies)} replies`} />
        <Num ph={ph} value={duration(t.decodeMs)} label="generating" tip={`${exact(t.decodeMs / 1000)} s generating`} />
      </div>
      <div
        className="us-chart"
        tabIndex={0}
        role="group"
        aria-label="Chart"
        aria-describedby="us-at"
        onKeyDown={onChartKey}
        onPointerMove={onChartMove}
        onPointerLeave={() => setAt(null)}
        onBlur={() => setAt(null)}
      >
        <span className="us-top" aria-hidden="true">{prefs.metric === "speed" ? `${compact(top)} tok/s` : compact(top)}</span>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          <path className="us-base" d={`M0 ${H - 0.5}H${W}`} />
          {top > 0 ? <path className="us-grid" d={`M0 0.5H${W}`} /> : null}
          {markX === null ? null : <path className="us-mark" d={`M${markX} 0V${H}`} />}
          {drawn.map((l) => {
            const { line, dots } = pathOf(values(l, prefs.metric), top);
            const stroke = l.colour === "other" ? "var(--muted-foreground)" : `var(--u${l.colour})`;
            return (
              <g key={l.model ?? "other"} stroke={stroke}>
                {line === "" ? null : <path d={line} />}
                {dots === "" ? null : <path className="us-dot" d={dots} />}
              </g>
            );
          })}
        </svg>
      </div>
      <h3 className="us-at" id="us-at" aria-live="polite">
        {data.failed ? <span role="alert">Couldn't read usage.</span> : at === null ? spanName(view) : periodName(view, at)}
      </h3>
      <table className="us-rows">
        {rows.length > 0 && <thead>
          <tr>
            <th scope="col"><span className="vh">Model</span></th>
            <th scope="col">In</th>
            <th scope="col">Out</th>
            <th scope="col">tok/s</th>
            <th scope="col">Replies</th>
          </tr>
        </thead>}
        <tbody>
          {rows.map(({ l, f }) => {
            const name = l.model === null ? "Other" : labels.get(l.model) ?? l.model;
            return (
              <tr key={l.model ?? "other"}>
                <th scope="row">
                  {/* a name cut by its row reads in full in a tip, and only then (data-tipt measures the .t) */}
                  <span className="us-name" data-tipt={name}>
                    <i className="us-key" style={{ background: l.colour === "other" ? "var(--muted-foreground)" : `var(--u${l.colour})` }} />
                    <span className="us-label t">{name}</span>
                  </span>
                </th>
                <td data-tip={esc(`${exact(f.prompt)} tokens in`)}>{compact(f.prompt)}</td>
                <td data-tip={esc(`${exact(f.completion)} tokens out`)}>{compact(f.completion)}</td>
                <td data-tip={f.readSpeed === null ? undefined : esc(`Reads prompts at ${exact(f.readSpeed)} tok/s`)}>{speedText(f.speed)}</td>
                <td>{exact(f.replies)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
