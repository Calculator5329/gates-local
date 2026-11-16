// Settings › Instructions mounted for real (react-dom on the fake DOM): what comes first, what a save
// leaves where it was, which controls carry a unit line, and how the model menu takes the keyboard.
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { FakeDocument, FakeElement, FakeIFrame, type FakeNode } from "../../test/fake-dom.ts";

const calls = vi.hoisted(() => ({
  update: { fn: null as unknown as (patch: object) => Promise<string | null> },
  model: [] as [string, object][],
}));
vi.mock("../lib/session/index.ts", async (original) => ({
  ...await original<typeof import("../lib/session/index.ts")>(),
  updateSettings: (patch: object) => calls.update.fn(patch),
  updateModelSettings: (model: string, patch: object) => { calls.model.push([model, patch]); return Promise.resolve(null); },
  call: (method: string) => method === "settings.modelDefaults" ? Promise.resolve({ system: "", parameters: "temperature 0.7" }) : Promise.reject(new Error(method)),
}));

const doc = new FakeDocument();
const win = { document: doc, HTMLIFrameElement: FakeIFrame, addEventListener() {}, removeEventListener() {} };
let root: Root;
let store: typeof import("../lib/store/store.ts");
let SettingsView: typeof import("./Settings.tsx")["SettingsView"];
const settings = { defaultNumCtx: 16384, thinking: true, theme: "dark", runtimeMode: "system", tools: true, imageGen: true } as const;
const MODELS = ["alpha:1b", "beta:2b", "gamma:3b"].map((name) => ({ name, capabilities: ["completion"] }));

beforeAll(async () => {
  doc.defaultView = win;
  Object.assign(doc, { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" });
  const { createRoot } = await import("react-dom/client");
  store = await import("../lib/store/store.ts");
  ({ SettingsView } = await import("./Settings.tsx"));
  root = createRoot(doc.body.appendChild(doc.createElement("div")) as unknown as Element);
});
afterAll(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
beforeEach(() => {
  calls.update.fn = () => Promise.resolve(null);
  calls.model.length = 0;
  doc.activeElement = null;
});
afterEach(() => { act(() => root.render(null)); });

const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
function all(pred: (el: FakeElement) => boolean, from: FakeNode = doc.body): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (n: FakeNode) => { for (const c of n.childNodes) if (c instanceof FakeElement) { if (pred(c)) out.push(c); walk(c); } };
  walk(from);
  return out;
}
const byTestId = (id: string) => all((el) => el.getAttribute("data-testid") === id)[0] ?? null;
const props = (el: FakeElement | null): Record<string, unknown> => {
  if (el === null) throw new Error("no such element");
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  return (key === undefined ? {} : (el as unknown as Record<string, Record<string, unknown>>)[key]) ?? {};
};
const fire = async (el: FakeElement | null, handler: string, event: unknown = {}) => {
  await act(async () => { (props(el)[handler] as (e: unknown) => void)(event); });
  await settle();
};
const key = (k: string) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {}, stopPropagation() {} });
async function mount(over: Partial<import("../lib/store/store.ts").State> = {}) {
  store.setState({ conn: { kind: "open" }, view: "settings", section: "instructions", settings, models: MODELS as never, model: "beta:2b", unavailable: {}, ...over });
  act(() => root.render(createElement(SettingsView)));
  await settle();
}
// The page's own controls in document order.
const controls = () => all((el) => /^settings\.(instructions|reply-controls|model-defaults)\./.test(el.getAttribute("data-testid") ?? "") && el.getAttribute("data-testid") !== "settings.instructions.model-menu")
  .map((el) => el.getAttribute("data-testid"));

it("the scope tabs come first on Instructions, in either scope", async () => {
  await mount();
  expect(controls().slice(0, 3)).toEqual(["settings.instructions.scope-all", "settings.instructions.scope-model", "settings.instructions.custom"]);
  await fire(byTestId("settings.instructions.scope-model"), "onClick");
  expect(controls().slice(0, 3)).toEqual(["settings.instructions.scope-all", "settings.instructions.scope-model", "settings.instructions.model"]);
});

const statusRow = () => all((el) => el.classList.includes("inst-actions"))[0]!;
it("a save's Saving, Saved and error take the one status slot, which holds its line when empty, and the buttons keep their words", async () => {
  await mount();
  const shape = () => statusRow().childNodes.map((c) => c instanceof FakeElement ? `${c.getAttribute("class")}|${c.textContent}` : "");
  expect(shape()).toEqual(["inst-status| ", "btn ghost|Reset", "btn outline|Save instructions"]);
  const saving: { answer?: (error: string | null) => void } = {};
  calls.update.fn = () => new Promise((r) => { saving.answer = r; });
  await fire(byTestId("settings.instructions.custom"), "onClick");
  await fire(byTestId("settings.instructions.prompt"), "onChange", { target: { value: "Be brief." } });
  expect(shape()[0]).toBe("inst-status| ");
  await fire(byTestId("settings.instructions.save"), "onClick");
  expect(shape()).toEqual(["inst-status|Saving…", "btn ghost|Reset", "btn outline|Save instructions"]);
  await act(async () => { saving.answer?.("Couldn't save the instructions."); });
  await settle();
  expect(shape()).toEqual(["inst-status act-err|Couldn't save the instructions.", "btn ghost|Reset", "btn outline|Save instructions"]);
  const status = statusRow().childNodes[0];
  expect(status instanceof FakeElement && status.getAttribute("role")).toBe("alert");
  calls.update.fn = () => Promise.resolve(null);
  await fire(byTestId("settings.instructions.save"), "onClick");
  expect(shape()).toEqual(["inst-status|Saved", "btn ghost|Reset", "btn outline|Save instructions"]);
});

it("only Maximum reply length and Keep loaded carry a unit line, and no reply control has a tooltip", async () => {
  await mount();
  await fire(byTestId("settings.instructions.scope-model"), "onClick");
  const form = byTestId("settings.reply-controls.form")!;
  const rows = all((el) => el.classList.includes("srow"), form).map((row) => {
    const label = all((el) => el.tagName === "B", row)[0]?.textContent;
    const unit = all((el) => el.classList.includes("d"), row)[0]?.textContent ?? null;
    return [label, unit];
  });
  expect(Object.fromEntries(rows)).toEqual({
    Temperature: null, "Top p": null, "Top k": null, "Repeat penalty": null, Seed: null,
    "Maximum reply length": "Tokens", "Keep loaded": "Seconds after a reply",
  });
  expect(all((el) => el.getAttribute("data-tip") !== null, form)).toEqual([]);
});

const focused = () => doc.activeElement;
it("the model menu opens on the chosen model, walks with the arrows and letters, picks with Enter, and Escape gives the focus back to its button", async () => {
  await mount();
  await fire(byTestId("settings.instructions.scope-model"), "onClick");
  const button = () => byTestId("settings.instructions.model");
  const menu = byTestId("settings.instructions.model-menu");
  const option = (name: string) => byTestId(`settings.instructions.model-${name.replace(/[^a-z0-9]+/g, "-")}`);
  await fire(button(), "onClick");
  expect(focused()).toBe(option("beta:2b"));
  await fire(menu, "onKeyDown", key("ArrowDown"));
  expect(focused()).toBe(option("gamma:3b"));
  await fire(menu, "onKeyDown", key("ArrowDown"));
  expect(focused(), "the list wraps").toBe(option("alpha:1b"));
  await fire(menu, "onKeyDown", key(option("gamma:3b")!.getAttribute("aria-label")![0]!));
  expect(focused(), "a letter finds the model whose name starts with it").toBe(option("gamma:3b"));
  const gamma = option("gamma:3b")!.getAttribute("aria-label");
  await fire(option("gamma:3b"), "onKeyDown", key("Enter"));
  expect(option("gamma:3b"), "Enter picks and closes").toBeNull();
  expect(focused()).toBe(button());
  expect(button()!.getAttribute("aria-label")).toBe(`Installed model: ${gamma}`);
  await fire(button(), "onClick");
  expect(focused()).toBe(option("gamma:3b"));
  await fire(menu, "onKeyDown", key("Escape"));
  expect(option("alpha:1b")).toBeNull();
  expect(focused()).toBe(button());
  expect(button()!.getAttribute("aria-label")).toBe(`Installed model: ${gamma}`);
});
