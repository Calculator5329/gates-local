// The composer's model button, while the chosen model would run partly in system memory right now:
// its tip says why, in the fit table's own words, and says nothing of it when the model fits.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { fitWords, type FitRow, type FitTable } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import type { State } from "../lib/store/store.ts";

vi.mock("../lib/store/store.ts", async (original) => {
  const actual = await original<typeof import("../lib/store/store.ts")>();
  return { ...actual, useStore: <T>(selector: (s: State) => T) => selector(actual.getState()) };
});
import { setState } from "../lib/store/store.ts";

const GIB = 1024 ** 3;
const sample = methodSamples["fit.table"].result;
const row = sample.rows[0]!;
const MODEL = row.model;
const CTX = 16384;
const words = (r: FitRow, basis: "card" | "now") => fitWords(r, basis, false);
/** The row right now and, when given, the card's own verdict beside it. */
const table = (now: Partial<FitRow>, card?: Partial<NonNullable<FitRow["card"]>>): FitTable => {
  const r: FitRow = { ...row, numCtx: CTX, stops: [], verdict: "fits", spillRamBytes: 0, ...now };
  const c = card === undefined ? undefined : { verdict: "fits" as const, freeVramBytes: r.freeVramBytes, spillRamBytes: 0, ...card };
  return { ...sample, rows: [{ ...r, words: words(r, "now"), ...(c === undefined ? {} : { card: { ...c, words: words({ ...r, ...c }, "card") } }) }] };
};

let Composer: typeof import("./Composer.tsx")["Composer"];
const tip = () => renderToStaticMarkup(createElement(Composer)).match(/id="modelBtn"[^>]*data-tip="([^"]*)"/)?.[1] ?? "";

beforeAll(async () => {
  vi.stubGlobal("window", {});
  Composer = (await import("./Composer.tsx")).Composer;
});
beforeEach(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  setState({
    conn: { kind: "open" }, runtime: methodSamples["runtime.status"].result, gpu: methodSamples["gpu.status"].result,
    model: MODEL, numCtx: CTX, models: [{ ...methodSamples["models.list"].result.models[0]!, name: MODEL }], pop: null, notice: null,
  });
});
afterEach(() => vi.unstubAllGlobals());

it("the card holds the model and right now another program is in the way: the tip names it", () => {
  setState({ fitTable: table({ verdict: "spills", spillRamBytes: 2 * GIB }, { inTheWay: [{ label: "whisper", bytes: 3 * GIB, kind: "whisper", protected: false }] }) });
  expect(tip()).toContain("Slower now · Whisper in the way");
});

it("the model spills on the card itself: the tip says so in the table's words", () => {
  setState({ fitTable: table({ verdict: "spills", spillRamBytes: 2 * GIB }, { verdict: "spills", spillRamBytes: 2 * GIB }) });
  expect(tip()).toContain("Partly in system memory, slower");
});

it("a model that fits says nothing of system memory", () => {
  setState({ fitTable: table({}, {}) });
  const button = renderToStaticMarkup(createElement(Composer)).match(/<button\b[^>]*id="modelBtn"[^>]*>/)?.[0] ?? "";
  expect(button, "the model button was drawn").toContain("data-tipt=");
  expect(tip(), "nothing beside the name").toBe("");
  expect(button).not.toMatch(/system memory|slower/i);
});
