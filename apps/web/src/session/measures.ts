// Measured models (Settings › Models, Measure; row 29): one read after the first frame, the
// server's models.measures push when a run finishes, and models.measuring while one runs.
import type { MeasureRun, ModelMeasure, Payload } from "@gates-local/contracts";
import { NA, type State } from "../store.ts";

const table = (list: readonly ModelMeasure[]): Readonly<Record<string, ModelMeasure>> => Object.fromEntries(list.map((m) => [m.model, m]));

/** The second hydrate batch's read: NA from a server without it, unchanged when the read failed. */
export const measuresRead = (read: readonly ModelMeasure[] | typeof NA | undefined): Partial<State> =>
  read === undefined ? {} : { measures: read === NA ? NA : table(read) };

export const measuresChanged = (list: Payload<"models.measures">): Partial<State> => ({ measures: table(list) });

/** A run's step: kept while it waits or runs and when it failed (its words show), gone once done. */
export function measuringChanged(s: State, run: MeasureRun): Partial<State> {
  const { [run.model]: _old, ...rest } = s.measuring;
  return { measuring: run.state === "done" ? rest : { ...rest, [run.model]: run } };
}

/** The click's own answer: the run, unless a push about it already arrived. */
export const measureStarted = (s: State, run: MeasureRun): Partial<State> => (s.measuring[run.model] === undefined ? { measuring: { ...s.measuring, [run.model]: run } } : {});

/** A click the server refused: the row shows why, as a failed run. */
export const measureRefused = (s: State, model: string, message: string): Partial<State> =>
  ({ measuring: { ...s.measuring, [model]: { model, state: "error", done: 0, total: 0, message } } });

/** This model's measure, while it is of the weights installed now. */
export function measureOf(s: State, name: string): ModelMeasure | undefined {
  const m = s.measures === undefined || s.measures === NA ? undefined : s.measures[name];
  const digest = s.models?.find((x) => x.name === name)?.digest;
  return m !== undefined && m.digest === digest ? m : undefined;
}

/** The model being measured now, if any: one at a time. */
export const measuringNow = (s: State): string | undefined => Object.values(s.measuring).find((r) => r.state === "waiting" || r.state === "running")?.model;
