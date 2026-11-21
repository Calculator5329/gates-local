import type { MeasureList, MeasureRun, MeasureTurnChange, ModelMeasure, Payload } from "@gates-local/contracts";
import { NA, type State } from "../lib/store/store.ts";

const table = (list: readonly ModelMeasure[]): Readonly<Record<string, ModelMeasure>> => Object.fromEntries(list.map((m) => [m.model, m]));

export const measuresRead = (read: MeasureList | typeof NA | undefined): Partial<State> =>
  read === undefined ? {} : read === NA ? { measures: NA } : {
    measures: table(read.measures), measuring: read.run === undefined ? {} : { [read.run.model]: read.run },
    ...(read.live === undefined ? {} : { measureLive: read.live }),
  };

export const measuresChanged = (list: Payload<"models.measures">): Partial<State> => ({ measures: table(list) });

const STOPPED = "Stopped";

export function measuringChanged(s: State, run: MeasureRun): Partial<State> {
  const { [run.model]: _old, ...rest } = s.measuring;
  const ended = run.state === "stopped" ? STOPPED : run.state === "error" ? run.message : undefined;
  const live = s.measureLive;
  return {
    measuring: run.state === "done" || run.state === "stopped" ? rest : { ...rest, [run.model]: run },
    // why: a new run starts its chat empty; one that ended short keeps its turns and says why
    ...(run.state === "waiting" ? { measureLive: { model: run.model, at: 0, turns: [] } }
      : ended !== undefined && live?.model === run.model ? { measureLive: { ...live, ended } } : {}),
  };
}

// why: a turn past the next means a lost push; the next read of the measures brings it
export function measureTurned(s: State, { model, at, index, turn }: MeasureTurnChange): Partial<State> {
  const live = s.measureLive;
  const turns = live?.model === model && (live.at === at || live.at === 0) ? live.turns : [];
  if (index > turns.length) return {};
  return { measureLive: { model, at, turns: index === turns.length ? [...turns, turn] : turns.with(index, turn) } };
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

export const runOf = (s: State, name: string): MeasureRun | undefined => {
  const run = s.measuring[name];
  return run !== undefined && (run.state === "waiting" || run.state === "running") ? run : undefined;
};
