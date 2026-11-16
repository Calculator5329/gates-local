// A Measure run's steps and a model's measure in the store, as the row reads them.
import { expect, it } from "vitest";
import { MEASURE_VERSION, type MeasureRun, type ModelMeasure } from "@gates-local/contracts";
import { NA, type State } from "../lib/store/store.ts";
import { measureOf, measureRefused, measureStarted, measuringChanged } from "./measures.ts";

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

it("a measure of other weights than those installed is not this model's", () => {
  const m: ModelMeasure = { model: name, digest: "sha256:a", at: 1, version: MEASURE_VERSION, numCtx: 4096, tokensPerSecond: 40, score: 90, checks: [] };
  const of = (measures: State["measures"], digest: string) => measureOf({ measures, models: [{ name, digest }] } as never, name);
  expect(of({ [name]: m }, "sha256:a")).toBe(m);
  expect(of({ [name]: m }, "sha256:b")).toBeUndefined();
  expect(of(NA, "sha256:a")).toBeUndefined();
});
