import { type CSSProperties, type KeyboardEvent, type PointerEvent, useMemo, useState, useSyncExternalStore } from "react";
import { DialogHead } from "../lib/ui/Panel.tsx";
import { pickerLabels } from "../picker/picker-models.ts";
import { closeUsage, usageData } from "../lib/session/index.ts";
import { NA, useStore } from "../lib/store/store.ts";
import {
  RANGES, type UsageLine, type UsagePrefs, type UsageRange, type UsageView,
  compact, duration, readPrefs, speedText, usageView, writePrefs,
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

const PLOT_H = 140;
const GAP = 2;

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const hourFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const tickDayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const tickHourFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const exact = (n: number) => Math.round(n).toLocaleString();
const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
const keyColour = (l: UsageLine) => (l.colour === "other" ? "var(--muted-foreground)" : `var(--u${l.colour})`);
const tokensAt = (l: UsageLine, i: number) => l.prompt[i]! + l.completion[i]!;

function niceCeil(v: number): number {
  if (v <= 0) return 0;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

// why: two or three grid lines at round figures, the top one at or above the tallest column
function gridOf(max: number): { top: number; step: number } {
  if (max <= 0) return { top: 0, step: 0 };
  const step = Math.max(1, niceCeil(max / 3));
  return { top: step * Math.ceil(max / step), step };
}

// why: first, last and a whole number of periods apart between; odd ones give way at 320 px
function ticksOf(n: number): { i: number; kind: "first" | "mid" | "odd" | "last" }[] {
  const every = Math.max(1, Math.ceil((n - 1) / 4));
  const between = Array.from({ length: Math.ceil((n - 1) / every) }, (_, j) => j * every).filter((i) => i > 0 && n - 1 - i >= every / 2);
  return [
    { i: 0, kind: "first" as const },
    ...between.map((i, j) => ({ i, kind: j % 2 === 0 ? ("odd" as const) : ("mid" as const) })),
    ...(n > 1 ? [{ i: n - 1, kind: "last" as const }] : []),
  ];
}

function periodName(view: UsageView, at: number): string {
  const start = view.periods[at]!.start;
  return view.hourly ? hourFmt.format(start) : dayFmt.format(start);
}

function Seg<T extends string>({ value, options, onPick, label }: { value: T; options: readonly (readonly [T, string])[]; onPick: (v: T) => void; label: string }) {
  return (
    <span className="mini-seg" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" className={v === value ? "on" : ""} data-testid={`usage.option.${v}`} aria-pressed={v === value} onClick={() => onPick(v)}>
          {text}
        </button>
      ))}
    </span>
  );
}

function Num({ value, label, ph }: { value: string; label: string; ph: boolean }) {
  return (
    <div className="us-num">
      <b>{ph ? <span className="us-ph" /> : value}</b>
      <span>{label}</span>
    </div>
  );
}

function Column({ lines, i, top, on }: { lines: readonly UsageLine[]; i: number; top: number; on: boolean }) {
  let below = 0;
  return (
    <div className={on ? "us-col on" : "us-col"}>
      {lines.map((l) => {
        const v = tokensAt(l, i);
        if (v <= 0) return null;
        const px = (v / top) * PLOT_H - (below++ > 0 ? GAP : 0);
        return <i key={l.model ?? "other"} style={{ height: Math.max(2, px), background: keyColour(l) }} />;
      })}
    </div>
  );
}

function Track({ l, top }: { l: UsageLine; top: number }) {
  if (top === 0 || l.speedTotal === null || l.speedLow === null || l.speedHigh === null) return <span className="us-trk" />;
  return (
    <span className="us-trk">
      <u style={{ left: pct(l.speedLow / top), width: pct((l.speedHigh - l.speedLow) / top) }} />
      <s style={{ left: pct(l.speedTotal / top) }} />
    </span>
  );
}

export function Usage() {
  const data = useSyncExternalStore(usageData.subscribe, usageData.get, usageData.get);
  const catalog = useStore((s) => (s.catalog === NA ? undefined : s.catalog));
  const [prefs, setPrefs] = useState<UsagePrefs>(() => readPrefs(storage() ?? memory));
  const [at, setAt] = useState<number | null>(null);
  const pickRange = (range: UsageRange) => {
    setPrefs({ range });
    writePrefs(storage() ?? memory, { range });
    setAt(null);
  };
  const read = data.read ?? { rows: [], models: [] };
  const ph = data.read === null;
  const view = useMemo(() => usageView(read, prefs.range, Date.now()), [read, prefs.range]);
  const labels = useMemo(() => pickerLabels(view.lines.flatMap((l) => (l.model === null ? [] : [l.model])), catalog), [view, catalog]);
  const nameOf = (l: UsageLine) => (l.model === null ? "Other" : labels.get(l.model) ?? l.model);
  const n = view.periods.length;
  const { top, step } = gridOf(Math.max(0, ...view.periods.map((_, i) => view.lines.reduce((a, l) => a + tokensAt(l, i), 0))));
  const speedTop = niceCeil(Math.max(0, ...view.lines.map((l) => l.speedHigh ?? 0)));
  const t = view.totals;
  const here = at === null ? [] : view.lines.filter((l) => tokensAt(l, at) > 0);
  const live = at === null ? "" : `${periodName(view, at)}: ${here.length === 0 ? "No replies" : here.map((l) => `${nameOf(l)} ${compact(tokensAt(l, at))}`).join(", ")}`;

  const onChartKey = (e: KeyboardEvent) => {
    const move = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (move !== undefined) {
      e.preventDefault();
      setAt((i) => (i === null ? (move < 0 ? n - 1 : 0) : Math.min(n - 1, Math.max(0, i + move))));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setAt(e.key === "Home" ? 0 : n - 1);
    }
  };
  const onPlotMove = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const f = box.width === 0 ? 0 : (e.clientX - box.left) / box.width;
    setAt(Math.min(n - 1, Math.max(0, Math.floor(f * n))));
  };
  // why: the readout opens toward the wider side, capped there, so it never leaves the pop-up
  const side: CSSProperties | null = at === null ? null : at < n / 2
    ? { left: `calc(${pct((at + 1) / n)} + 8px)`, maxWidth: `calc(${pct((n - at - 1) / n)} - 8px)` }
    : { right: `calc(${pct((n - at) / n)} + 8px)`, maxWidth: `calc(${pct(at / n)} + 32px)` };

  return (
    <>
    <DialogHead title="Usage" onClose={() => closeUsage()}>
      <div className="us-ctl">
        <Seg label="Range" value={prefs.range} options={RANGES} onPick={pickRange} />
      </div>
    </DialogHead>
    <div className="dlg-body">
    <div className="us">
      <div className="us-nums">
        <Num ph={ph} value={compact(t.promptTokens)} label="in" />
        <Num ph={ph} value={compact(t.completionTokens)} label="out" />
        <Num ph={ph} value={compact(t.replies)} label="replies" />
        <Num ph={ph} value={duration(t.wallMs)} label="waiting" />
      </div>
      <div
        className="us-chart"
        data-testid="usage.chart.plot"
        tabIndex={0}
        role="group"
        aria-label="Chart"
        aria-describedby="us-read"
        onKeyDown={onChartKey}
        onBlur={() => setAt(null)}
      >
        <div className="us-plot" style={{ height: PLOT_H }} onPointerMove={onPlotMove} onPointerLeave={() => setAt(null)}>
          {step === 0 ? null : Array.from({ length: Math.round(top / step) }, (_, k) => (
            <span key={k} className="us-gl" style={{ bottom: pct(((k + 1) * step) / top) }} aria-hidden="true"><i>{compact((k + 1) * step)}</i></span>
          ))}
          <div className="us-bars" style={{ "--n": n } as CSSProperties}>
            {view.periods.map((p, i) => <Column key={p.start} lines={view.lines} i={i} top={top} on={at === i} />)}
          </div>
          {data.failed ? <p className="us-fail" role="alert">Couldn't read usage.</p> : null}
          {at === null ? null : (
            <div className="us-read" style={side ?? undefined} aria-hidden="true">
              <b>{periodName(view, at)}</b>
              {here.length === 0 ? <span className="us-none">No replies</span> : here.map((l) => (
                <span key={l.model ?? "other"} className="us-rl">
                  <i className="us-key" style={{ background: keyColour(l) }} />
                  <span className="us-label">{nameOf(l)}</span>
                  <em>{compact(tokensAt(l, at))}</em>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="us-xs" aria-hidden="true">
          {ticksOf(n).map(({ i, kind }) => (
            <span key={i} className={`us-x us-x-${kind}`} style={kind === "first" ? { left: 0 } : kind === "last" ? { right: 0 } : { left: pct((i + 0.5) / n) }}>
              {(view.hourly ? tickHourFmt : tickDayFmt).format(view.periods[i]!.start)}
            </span>
          ))}
        </div>
        <span className="vh" id="us-read" aria-live="polite">{live}</span>
      </div>
      <table className="us-rows">
        {view.lines.length > 0 && <thead>
          <tr>
            <th scope="col"><span className="vh">Model</span></th>
            <th scope="col">In</th>
            <th scope="col">Out</th>
            <th scope="col" className="us-sp">tok/s</th>
            <th scope="col">Replies</th>
          </tr>
        </thead>}
        <tbody>
          {view.lines.map((l) => {
            const name = nameOf(l);
            return (
              <tr key={l.model ?? "other"}>
                <th scope="row">
                  <span className="us-name" data-tipt={name}>
                    <i className="us-key" style={{ background: keyColour(l) }} />
                    <span className="us-label t">{name}</span>
                  </span>
                </th>
                <td>{compact(l.promptTotal)}</td>
                <td>{compact(l.completionTotal)}</td>
                <td className="us-sp"><span className="us-spd"><Track l={l} top={speedTop} /><em>{speedText(l)}</em></span></td>
                <td>{exact(l.repliesTotal)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    </div>
    </>
  );
}
