import type { MeasureList, MeasureRun, ModelMeasure, Payload } from "@gates-local/contracts";
import { NA, type State } from "../lib/store/store.ts";

const table = (list: readonly ModelMeasure[]): Readonly<Record<string, ModelMeasure>> => Object.fromEntries(list.map((m) => [m.model, m]));

export const measuresRead = (read: MeasureList | typeof NA | undefined): Partial<State> =>
  read === undefined ? {} : read === NA ? { measures: NA } : { measures: table(read.measures), measuring: read.run === undefined ? {} : { [read.run.model]: read.run } };

export const measuresChanged = (list: Payload<"models.measures">): Partial<State> => ({ measures: table(list) });

export function measuringChanged(s: State, run: MeasureRun): Partial<State> {
  const { [run.model]: _old, ...rest } = s.measuring;
  return { measuring: run.state === "done" ? rest : { ...rest, [run.model]: run } };
}

export const measureStarted = (s: State, run: MeasureRun): Partial<State> => (s.measuring[run.model] === undefined ? { measuring: { ...s.measuring, [run.model]: run } } : {});

export const measureRefused = (s: State, model: string, message: string): Partial<State> =>
  ({ measuring: { ...s.measuring, [model]: { model, state: "error", done: 0, total: 0, message } } });

export function measureOf(s: State, name: string): ModelMeasure | undefined {
  const m = s.measures === undefined || s.measures === NA ? undefined : s.measures[name];
  const digest = s.models?.find((x) => x.name === name)?.digest;
  return m !== undefined && m.digest === digest ? m : undefined;
}

export const measuringNow = (s: State): string | undefined => Object.values(s.measuring).find((r) => r.state === "waiting" || r.state === "running")?.model;
