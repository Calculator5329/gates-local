// A model row's Measure cells, rendered as the row renders them.
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { MEASURE_VERSION, type MeasureRun, type ModelMeasure } from "@gates-local/contracts";

const h = vi.hoisted(() => ({ state: undefined as unknown }));
vi.mock("../lib/store/store.ts", async (original) => ({ ...(await original<typeof import("../lib/store/store.ts")>()), useStore: (pick: (s: unknown) => unknown) => pick(h.state) }));
vi.mock("../lib/session/index.ts", () => ({ measureModel: () => undefined, openMeasure: () => undefined }));
const { NA } = await import("../lib/store/store.ts");
const { MeasureCells, canMeasure, useMeasureItem } = await import("./ModelMeasure.tsx");

const name = "qwen3.5:9b";
const measured = (digest: string): ModelMeasure => ({ model: name, digest, at: 1, version: MEASURE_VERSION, numCtx: 4096, tokensPerSecond: 40, score: 90, checks: [] });
const at = (measure: string | undefined, installed: string, measuring: Record<string, MeasureRun> = {}) =>
  ({ measures: measure === undefined ? {} : { [name]: measured(measure) }, models: [{ name, digest: installed }], measuring, unavailable: {} });
const row = (el: FunctionComponent<{ name: string; label: string }>) => renderToStaticMarkup(createElement(el, { name, label: "Qwen 3.5 9B" }));
const run = (model: string, done: number, state: MeasureRun["state"] = "running"): MeasureRun => ({ model, state, done, total: 22 });

it("the Measure button says the model loads, then the pages wait at the last step, and why it is off while another model measures; the menu offers nothing while a run goes", () => {
  h.state = at(undefined, "a", { [name]: run(name, 0, "waiting") });
  expect(row(MeasureCells)).toContain("Loading model");
  h.state = at(undefined, "a", { [name]: run(name, 0) });
  expect(row(MeasureCells)).toContain("Loading model");
  h.state = at(undefined, "a", { [name]: run(name, 5) });
  const going = row(MeasureCells);
  expect(going).toContain("5 / 22");
  // why: pressed while its own run goes, it opens the run's chat
  expect(going).not.toContain('disabled=""');
  h.state = at(undefined, "a", { [name]: run(name, 21) });
  expect(row(MeasureCells)).toContain("Grading pages");
  h.state = at(undefined, "a", { other: run("other", 5) });
  const off = row(MeasureCells);
  expect(off).toContain('data-tip="One model at a time"');
  expect(off).toContain('disabled=""');
  expect(useMeasureItem(name)).toBeUndefined();
  h.state = at(undefined, "a");
  expect(row(MeasureCells)).toContain('data-tip="Measure"');
  expect(useMeasureItem(name)?.text).toBe("Measure");
});

it("an older server shows no Speed or Score: no measures read, or no Measure to call", () => {
  expect(canMeasure({ measures: {}, unavailable: {} } as never)).toBe(true);
  expect(canMeasure({ measures: NA, unavailable: {} } as never)).toBe(false);
  expect(canMeasure({ measures: {}, unavailable: { "models.measure": true } } as never)).toBe(false);
});
