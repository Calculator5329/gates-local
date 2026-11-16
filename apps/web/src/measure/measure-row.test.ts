// A model row's Measure cells, rendered as the row renders them, with each useState kept between
// renders as on a mounted row.
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { MEASURE_VERSION, type MeasureRun, type ModelMeasure } from "@gates-local/contracts";

const h = vi.hoisted(() => ({ state: undefined as unknown, slot: 0, slots: [] as { current: unknown }[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (init: unknown) => {
      const s = (h.slots[h.slot++] ??= { current: init });
      return [s.current, (v: unknown) => { s.current = v; }];
    },
  };
});
vi.mock("../lib/store/store.ts", async (original) => ({ ...(await original<typeof import("../lib/store/store.ts")>()), useStore: (pick: (s: unknown) => unknown) => pick(h.state) }));
vi.mock("../lib/session/index.ts", () => ({ measureModel: () => undefined }));
vi.mock("./MeasureDetail.tsx", async (original) => ({ ...(await original<typeof import("./MeasureDetail.tsx")>()), MeasureDetail: () => "the detail" }));
const { NA } = await import("../lib/store/store.ts");
const { MeasureCells, MeasureMeta, canMeasure, useMeasureItem } = await import("./ModelMeasure.tsx");

const name = "qwen3.5:9b";
const measured = (digest: string): ModelMeasure => ({ model: name, digest, at: 1, version: MEASURE_VERSION, numCtx: 4096, tokensPerSecond: 40, score: 90, checks: [] });
const at = (measure: string | undefined, installed: string, measuring: Record<string, MeasureRun> = {}) =>
  ({ measures: measure === undefined ? {} : { [name]: measured(measure) }, models: [{ name, digest: installed }], measuring, unavailable: {} });
const row = (el: FunctionComponent<{ name: string; label: string }>) => {
  h.slot = 0;
  return renderToStaticMarkup(createElement(el, { name, label: "Qwen 3.5 9B" }));
};
const run = (model: string, done: number): MeasureRun => ({ model, state: "running", done, total: 22 });

beforeEach(() => { h.slots = []; });

it.each([["the row's cells", MeasureCells], ["the phone's line", MeasureMeta]] as const)("%s: a measure that went away closes its detail, and the next measure does not open it", (_, el) => {
  h.state = at("sha256:a", "sha256:a");
  row(el);
  h.slots[0]!.current = true;
  expect(row(el), "opened").toContain("the detail");
  h.state = at("sha256:a", "sha256:b");
  expect(row(el), "the weights changed").not.toContain("the detail");
  h.state = at("sha256:b", "sha256:b");
  expect(row(el), "measured again").not.toContain("the detail");
});

it("the Measure button says the pages wait at the last step, and why it is off while another model measures; the menu offers nothing while a run goes", () => {
  h.state = at(undefined, "a", { [name]: run(name, 5) });
  expect(row(MeasureCells)).toContain("Measuring 5 of 22");
  h.state = at(undefined, "a", { [name]: run(name, 21) });
  expect(row(MeasureCells)).toContain("Pages wait for the window");
  h.state = at(undefined, "a", { other: run("other", 5) });
  const off = row(MeasureCells);
  expect(off).toContain('data-tip="One model at a time"');
  expect(off).toContain('disabled=""');
  expect(useMeasureItem(name)).toBeUndefined();
  h.state = at(undefined, "a");
  expect(row(MeasureCells)).not.toContain("data-tip");
  expect(useMeasureItem(name)?.text).toBe("Measure");
});

it("an older server shows no Speed or Score: no measures read, or no Measure to call", () => {
  expect(canMeasure({ measures: {}, unavailable: {} } as never)).toBe(true);
  expect(canMeasure({ measures: NA, unavailable: {} } as never)).toBe(false);
  expect(canMeasure({ measures: {}, unavailable: { "models.measure": true } } as never)).toBe(false);
});
