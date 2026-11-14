// Settings › Models, Measure (row 29, proposal 06 A): a model's speed and score measured on this
// computer when the person asks, kept on its row. Until then the row has a Measure button across
// both cells; while it runs, the button is the progress. The check runs on the server
// (apps/server/src/measure); nothing here starts one without a click.
import { handleKey } from "./handles.ts";
import { Icon } from "./icons.tsx";
import { tpsText } from "./model-speed.tsx";
import { measureModel } from "./session.ts";
import { measureOf, measuringNow } from "./session/measures.ts";
import { Fail } from "./settings-ui.tsx";
import { NA, type State, useStore } from "./store.ts";

/** The Speed and Score columns show unless the server has no Measure (an older server). */
export const canMeasure = (s: State): boolean => s.measures !== NA && s.unavailable["models.measure"] !== true;

const running = (s: State, name: string) => {
  const run = s.measuring[name];
  return run !== undefined && (run.state === "waiting" || run.state === "running") ? run : undefined;
};

/** The phone's words for a measured model, a grey line of their own under the size and mark. */
export function MeasureMeta({ name }: { name: string }) {
  const m = useStore((s) => measureOf(s, name));
  if (m === undefined) return null;
  return (
    <div className="mp-mline">
      {tpsText(m.tokensPerSecond) ?? "–"} · score {m.score}
    </div>
  );
}

/** Why the last Measure of this model failed, under its name, until the next try. */
export function MeasureFail({ name }: { name: string }) {
  const err = useStore((s) => (s.measuring[name]?.state === "error" ? s.measuring[name]?.message ?? "Couldn't measure this model." : null));
  return err === null ? null : <Fail err={err} line />;
}

/** The row's Speed and Score cells: the numbers once measured, else one Measure button across both. */
export function MeasureCells({ name, label }: { name: string; label: string }) {
  const m = useStore((s) => measureOf(s, name));
  const run = useStore((s) => running(s, name));
  const other = useStore((s) => {
    const now = measuringNow(s);
    return now !== undefined && now !== name;
  });
  if (m !== undefined && run === undefined) {
    return (
      <>
        <span className="mp-spd">{tpsText(m.tokensPerSecond) ?? "–"}</span>
        <span className="mp-score" aria-label={`Score ${m.score} of 100`}>{m.score}</span>
      </>
    );
  }
  return <MeasureButton name={name} label={label} run={run} other={other} />;
}

function MeasureButton({ name, label, run, other }: { name: string; label: string; run: ReturnType<typeof running>; other: boolean }) {
  const text = run === undefined ? "Measure" : run.state === "running" ? `Measuring ${run.done} of ${run.total}` : "Starting";
  return (
    <span className="mp-meas">
      <button
        type="button"
        className={`btn outline fill-btn mp-mbtn${run ? " running" : ""}`}
        data-testid={`settings.models.measure-${handleKey(name)}`}
        style={{ "--f": run && run.total > 0 ? run.done / run.total : 0 } as React.CSSProperties}
        disabled={run !== undefined || other}
        aria-busy={run !== undefined || undefined}
        aria-label={run ? `${text}, ${label}` : `Measure ${label}`}
        // a button with words has no tooltip; disabled, it says why in a few words (docs/design.md)
        data-tip={run === undefined && other ? "One model at a time" : undefined}
        onClick={() => void measureModel(name)}
      >
        <span className="fill" aria-hidden="true" />
        {run ? null : <Icon id="speed" cls="s14" />}
        {text}
      </button>
    </span>
  );
}

/** "Measure" or "Measure again" in the row menu, the phone's way in; nothing while a run goes. */
export function useMeasureItem(name: string): { text: string; act: () => void } | undefined {
  const measured = useStore((s) => measureOf(s, name) !== undefined);
  const busy = useStore((s) => measuringNow(s) !== undefined);
  if (busy) return undefined;
  return { text: measured ? "Measure again" : "Measure", act: () => void measureModel(name) };
}
