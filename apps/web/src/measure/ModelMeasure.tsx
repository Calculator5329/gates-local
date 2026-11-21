import type { ModelMeasure } from "@gates-local/contracts";
import { handleKey } from "../lib/ui/handles.ts";
import { EARLIER_WORDS, SLOW_WORDS, isEarlier, isOlder, shortWords } from "./MeasureScore.tsx";
import { Icon } from "../lib/ui/icons.tsx";
import { speedNumber, tpsText } from "../models/model-speed.tsx";
import { measureModel, openMeasure } from "../lib/session/index.ts";
import { measureOf, measuringNow, runOf } from "./measures.ts";
import { Fail } from "../lib/ui/settings-ui.tsx";
import { NA, type State, useStore } from "../lib/store/store.ts";
import { esc } from "../lib/ui/ui.tsx";

export const canMeasure = (s: State): boolean => s.measures !== NA && s.unavailable["models.measure"] !== true;

const scoreText = (m: ModelMeasure) => (isOlder(m) ? `${m.checks.filter((c) => c.ok).length}/${m.checks.length}` : String(m.score));
const scoreWords = (m: ModelMeasure) => {
  const short = shortWords(m);
  return `${isOlder(m) ? `Older score, ${scoreText(m)} checks` : `Score ${m.score} of 100`}${isEarlier(m) ? `, ${EARLIER_WORDS}` : ""}${short ? `, ${short}` : ""}${m.think ? ", Thinking on" : ""}${m.slow ? `, ${SLOW_WORDS[m.slow]}` : ""}`;
};

export function ScoreMarks({ m }: { m: ModelMeasure }) {
  const short = shortWords(m);
  return (
    <>
      {isEarlier(m) ? <span data-tip={EARLIER_WORDS} data-testid="settings.models.score-earlier"><Icon id="clock" cls="s14" /></span> : null}
      {short ? <span className="mp-slow" data-tip={esc(short)} data-testid="settings.models.score-short"><Icon id="bars" cls="s14" /></span> : null}
    </>
  );
}

export function MeasureMeta({ name, label }: { name: string; label: string }) {
  const m = useStore((s) => measureOf(s, name));
  if (m === undefined) return null;
  return (
    <button type="button" className="mp-mline" data-testid={`settings.models.measure-line-${handleKey(name)}`} aria-label={`${scoreWords(m)}, ${label}: details`} onClick={() => openMeasure(name)}>
      {tpsText(m.tokensPerSecond) ?? "–"} · score {scoreText(m)}
      <ScoreMarks m={m} />
      {m.slow ? <Icon id="snail" cls="s14 mp-slow" /> : null}
    </button>
  );
}

export function MeasureFail({ name }: { name: string }) {
  const err = useStore((s) => (s.measuring[name]?.state === "error" ? s.measuring[name]?.message ?? "Couldn't measure this model." : null));
  return err === null ? null : <Fail err={err} line />;
}

export function MeasureCells({ name, label }: { name: string; label: string }) {
  const m = useStore((s) => measureOf(s, name));
  const run = useStore((s) => runOf(s, name));
  const other = useStore((s) => {
    const now = measuringNow(s);
    return now !== undefined && now !== name;
  });
  if (m !== undefined && run === undefined) {
    return (
      <>
        <span className="mp-spd">{speedNumber(m.tokensPerSecond) ?? "–"}</span>
        <button
          type="button"
          className={`mp-score${isOlder(m) || isEarlier(m) ? " old" : ""}`}
          data-testid={`settings.models.score-${handleKey(name)}`}
          aria-label={`${scoreWords(m)}, ${label}: details`}
          onClick={() => openMeasure(name)}
        >
          {m.slow ? <Icon id="snail" cls="s14 mp-slow" /> : null}
          <ScoreMarks m={m} />
          {scoreText(m)}
        </button>
      </>
    );
  }
  return <MeasureButton name={name} label={label} run={run} other={other} />;
}

// why: pressed while its own run goes, the button opens that run's chat rather than starting one
function MeasureButton({ name, label, run, other }: { name: string; label: string; run: ReturnType<typeof runOf>; other: boolean }) {
  // why: idle is an icon whose tip says Measure; running words must fit the two 64px cells
  const text = run === undefined ? "" : run.state !== "running" || run.done === 0 ? "Loading model" : run.done === run.total - 1 ? "Grading pages" : `${run.done} / ${run.total}`;
  return (
    <span className="mp-meas">
      <button
        type="button"
        className={`btn outline fill-btn mp-mbtn${run ? " running" : ""}`}
        data-testid={`settings.models.measure-${handleKey(name)}`}
        style={{ "--f": run && run.total > 0 ? run.done / run.total : 0 } as React.CSSProperties}
        disabled={other}
        aria-busy={run !== undefined || undefined}
        aria-label={run ? `Measuring ${label}: ${text.replace(" / ", " of ")}, open` : `Measure ${label}`}
        data-tip={run === undefined ? (other ? "One model at a time" : "Measure") : undefined}
        onClick={() => (run === undefined ? void measureModel(name) : openMeasure(name))}
      >
        <span className="fill" aria-hidden="true" />
        {run ? null : <Icon id="speed" cls="s14" />}
        {text}
      </button>
    </span>
  );
}

export function useMeasureItem(name: string): { text: string; act: () => void } | undefined {
  const measured = useStore((s) => measureOf(s, name) !== undefined);
  const busy = useStore((s) => measuringNow(s) !== undefined);
  if (busy) return undefined;
  return { text: measured ? "Measure again" : "Measure", act: () => void measureModel(name) };
}
