// The offer above the composer when Ollama answers with no chat model. After a first download that
// failed it says so once, in the words the Models chip uses, and keeps its one button.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";
import type { State } from "../lib/store/store.ts";

vi.mock("../lib/store/store.ts", async (original) => {
  const actual = await original<typeof import("../lib/store/store.ts")>();
  return { ...actual, useStore: <T>(selector: (s: State) => T) => selector(actual.getState()) };
});
const { getState, setState } = await import("../lib/store/store.ts");
const initial = getState();

beforeEach(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});
afterEach(() => { setState(initial); vi.unstubAllGlobals(); });

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const catalog = methodSamples["models.catalog"].result.map((c, i) => ({ ...c, installed: false, recommended: i === 0, rank: i }));
const offered = catalog[0]!;

async function offer(pulls: State["pulls"]): Promise<string> {
  const { Banner } = await import("./Banner.tsx");
  setState({ ...initial, conn: { kind: "open" }, runtime: methodSamples["runtime.status"].result, models: [], catalog, pulls, view: "new", threadId: null });
  return renderToStaticMarkup(createElement(Banner));
}

it("a first offer names the model and its size, with one button", async () => {
  const html = await offer({});
  expect(text(html)).toContain("Download your first model");
  expect(text(html)).not.toMatch(/did not finish|failed/i);
  expect(html.match(/<button/g)).toHaveLength(1);
});

it("after the offered model's download failed, the offer says so once and keeps its one button", async () => {
  const html = await offer({ [offered.name]: { name: offered.name, state: "error", completedBytes: 0, message: "connection reset" } });
  const words = text(html);
  expect(words).toContain("did not finish downloading");
  expect(words.match(/did not finish/g)).toHaveLength(1);
  expect(words.match(/fail/gi) ?? []).toHaveLength(0);
  expect(html.match(/<button/g)).toHaveLength(1);
  expect(html).toContain('data-testid="chat.banner.first-model"');
});

it("a failure of some other model is not said on this model's offer", async () => {
  const words = text(await offer({ "other:1b": { name: "other:1b", state: "error", completedBytes: 0 } }));
  expect(words).not.toMatch(/did not finish/);
});

it("first run, the two-second boot and a runtime not read yet each keep the banner empty", async () => {
  const { Banner } = await import("./Banner.tsx");
  const render = (extra: Partial<State>) => {
    setState({ ...initial, conn: { kind: "open" }, runtime: methodSamples["runtime.status"].result, models: [], catalog, pulls: {}, view: "new", threadId: null, ...extra });
    return renderToStaticMarkup(createElement(Banner));
  };
  expect(text(render({})), "the offer shows on a new chat").toContain("Download your first model");
  expect(render({ view: "firstrun" }), "first run").toBe("");
  expect(render({ runtime: undefined, hydrationSettled: false, bootWaited: false }), "booting").toBe("");
  expect(render({ runtime: undefined, hydrationSettled: true, bootWaited: true }), "nothing read").toBe("");
});

const at = (extra: Partial<State>) => ({ ...initial, conn: { kind: "open" }, runtime: methodSamples["runtime.status"].result, models: [], catalog, pulls: {}, view: "new", threadId: null, ...extra }) as State;

it("no first model is offered by an Ollama too old to say which models chat, or by a build that cannot download", async () => {
  const { firstModelOffer } = await import("./first-offer.ts");
  expect(firstModelOffer(at({}))?.name).toBe(offered.name);
  const unreported = { name: "qwen3.5:9b", digest: "q", sizeBytes: 1, modifiedAt: "", capabilities: ["unknown", "unreported"] } as const;
  expect(firstModelOffer(at({ models: [unreported] })), "too old").toBeUndefined();
  expect(firstModelOffer(at({ unavailable: { "models.pull": true } })), "cannot download").toBeUndefined();
});
