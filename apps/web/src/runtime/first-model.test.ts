// A fresh install's first model starts downloading the moment the app's own Ollama can take a
// pull, with no click: the person already chose to set up, and a second ask would only wait.
// Anyone else (an Ollama that was already there, a model already on disk, a download already
// running, a fit check still reading) is left to the offer and its button.
import { afterEach, expect, it } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";
import type { RuntimeStatus } from "@gates-local/contracts";
import { type State, getState, setState, subscribe } from "../lib/store/store.ts";
import { watchFirstModel } from "./first-model.ts";

const initial = getState();
const catalog = methodSamples["models.catalog"].result.map((c, i) => ({ ...c, installed: false, recommended: i === 0, rank: i }));
const offered = catalog[0]!;
const ready: RuntimeStatus = { state: "ready", owner: "app", baseUrl: "http://127.0.0.1:1", version: "test" };
const installing: RuntimeStatus = { ...ready, state: "installing", install: { receivedBytes: 1, totalBytes: 2 } };
const fit = (verdict: "fits" = "fits"): State["fitTable"] => ({
  reading: { boot: "b", seq: 1, measuredAt: 0 }, memory: { kind: "gpu", freeBytes: 2 ** 34, usableBytes: 2 ** 34 },
  rows: catalog.map((c) => ({ model: c.name, numCtx: 16384, freeVramBytes: 2 ** 34, needVramBytes: 2 ** 30, spillRamBytes: 0, shortfallBytes: 0, verdict, source: "estimate", stops: [] })),
});

let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; setState(initial); });

function watch(start: Partial<State>): string[] {
  setState({ ...initial, conn: { kind: "open" }, models: [], catalog, pulls: {}, ...start });
  const pulled: string[] = [];
  stop = watchFirstModel({ getState, subscribe, pull: (name) => { pulled.push(name); return Promise.resolve(null); } });
  return pulled;
}

it("the app's own Ollama finishing its install starts the recommended model at once, once", () => {
  const pulled = watch({ runtime: installing, fitTable: fit() });
  expect(pulled, "nothing while Ollama installs").toEqual([]);
  setState({ runtime: ready });
  expect(pulled).toEqual([offered.name]);
  setState({ runtime: { ...ready, version: "again" } });
  setState({ pulls: {} });
  expect(pulled, "a cancelled first download is not started again").toEqual([offered.name]);
});

it("an Ollama that was ready when the window opened is left to the offer's button", () => {
  const pulled = watch({ runtime: ready, fitTable: fit() });
  setState({ runtime: { ...ready, version: "again" } });
  expect(pulled).toEqual([]);
});

it("waits for the fit check, so a model the card cannot hold is never the one started", () => {
  const pulled = watch({ runtime: installing, fitTable: undefined });
  setState({ runtime: ready });
  expect(pulled, "the fit check has not answered").toEqual([]);
  setState({ fitTable: fit() });
  expect(pulled).toEqual([offered.name]);
});

it("a model already on disk, or a download already running, starts nothing", () => {
  const pulling = watch({ runtime: installing, fitTable: fit(), pulls: { "other:1b": { name: "other:1b", state: "downloading", completedBytes: 1, totalBytes: 9 } } });
  setState({ runtime: ready });
  expect(pulling).toEqual([]);
  stop?.();
  const have = watch({ runtime: installing, fitTable: fit(), models: [{ name: offered.name, digest: "d", sizeBytes: 1, modifiedAt: "", capabilities: ["completion"] }] });
  setState({ runtime: ready });
  expect(have).toEqual([]);
});
