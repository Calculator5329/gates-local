// A Measure run's steps and a model's measure in the store, as the row reads them.
import { expect, it } from "vitest";
import { MEASURE_VERSION, type MeasureRun, type MeasureTurn, type ModelMeasure } from "@gates-local/contracts";
import { NA, type State } from "../lib/store/store.ts";
import { measureOf, measureRefused, measureStarted, measureTurned, measuringChanged } from "./measures.ts";

const name = "qwen3.5:9b";
const steps = (measuring: State["measuring"]) => ({ measuring }) as State;

it("a run's steps: a push that came first stands over the click's answer, a refusal shows as a failed run, a failed run stays and a done one goes", () => {
  const waiting: MeasureRun = { model: name, state: "waiting", done: 0, total: 22 };
  const running: MeasureRun = { model: name, state: "running", done: 3, total: 22 };
  const other: MeasureRun = { model: "other", state: "error", done: 1, total: 22, message: "Stopped." };
  expect(measureStarted(steps({}), waiting)).toEqual({ measuring: { [name]: waiting } });
  expect(measureStarted(steps({ [name]: running }), waiting)).toEqual({});
  expect(measureRefused(steps({ other }), name, "One model at a time.")).toEqual({ measuring: { other, [name]: { model: name, state: "error", done: 0, total: 0, message: "One model at a time." } } });
  const failed: MeasureRun = { ...running, state: "error", message: "Measure stopped at check 4." };
  expect(measuringChanged(steps({ [name]: running, other }), failed)).toEqual({ measuring: { [name]: failed, other } });
  expect(measuringChanged(steps({ [name]: running, other }), { ...running, state: "done", done: 22 })).toEqual({ measuring: { other } });
});

const turn = (id: string, answer = ""): MeasureTurn => ({ id, part: "tools", n: 1, of: 5, prompt: id, thinking: "", answer, steps: [] });
const live = (s: Partial<State>) => s.measureLive;

it("a run's chat: a new run starts it empty, turns come in order or redraw in place, a lost push waits for the next read, and a stop keeps the turns and says so", () => {
  const begun = { measuring: {}, measureLive: live(measuringChanged(steps({}), { model: name, state: "waiting", done: 0, total: 22 })) } as State;
  expect(begun.measureLive).toEqual({ model: name, at: 0, turns: [] });
  const one = { ...begun, measureLive: live(measureTurned(begun, { model: name, at: 7, index: 0, turn: turn("a") })) } as State;
  expect(one.measureLive).toEqual({ model: name, at: 7, turns: [turn("a")] });
  const grown = { ...one, measureLive: live(measureTurned(one, { model: name, at: 7, index: 0, turn: turn("a", "It is") })) } as State;
  expect(grown.measureLive?.turns).toEqual([turn("a", "It is")]);
  expect(measureTurned(grown, { model: name, at: 7, index: 2, turn: turn("c") })).toEqual({});
  // why: a push from an earlier run of the same model starts no mixed chat
  expect(measureTurned(grown, { model: name, at: 9, index: 1, turn: turn("b") })).toEqual({});
  expect(live(measureTurned(grown, { model: name, at: 9, index: 0, turn: turn("b") }))?.turns).toEqual([turn("b")]);
  const running: MeasureRun = { model: name, state: "running", done: 2, total: 22 };
  const stopped = measuringChanged({ ...grown, measuring: { [name]: running } }, { ...running, state: "stopped", done: 0 });
  expect(stopped.measuring).toEqual({});
  expect(stopped.measureLive).toEqual({ model: name, at: 7, turns: [turn("a", "It is")], ended: "Stopped" });
});

it("a measure of other weights than those installed is not this model's", () => {
  const m: ModelMeasure = { model: name, digest: "sha256:a", at: 1, version: MEASURE_VERSION, numCtx: 4096, tokensPerSecond: 40, score: 90, checks: [] };
  const of = (measures: State["measures"], digest: string) => measureOf({ measures, models: [{ name, digest }] } as never, name);
  expect(of({ [name]: m }, "sha256:a")).toBe(m);
  expect(of({ [name]: m }, "sha256:b")).toBeUndefined();
  expect(of(NA, "sha256:a")).toBeUndefined();
});
