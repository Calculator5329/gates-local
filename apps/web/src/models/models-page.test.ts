// Settings › Models mounted for real (react-dom on the fake DOM): the row menu, the remove dialog
// and its focus, what a removal leaves behind, and where each row and its speed sit.
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { FakeDocument, FakeElement, FakeIFrame, type FakeNode } from "../../test/fake-dom.ts";

type Answer = (error: string | null) => void;
const calls = vi.hoisted(() => ({
  remove: { fn: null as unknown as (name: string) => Promise<string | null>, count: 0 },
  update: { fn: null as unknown as (patch: object) => Promise<string | null> },
}));
vi.mock("../lib/session/index.ts", async (original) => ({
  ...await original<typeof import("../lib/session/index.ts")>(),
  removeModel: (name: string) => { calls.remove.count++; return calls.remove.fn(name); },
  updateSettings: (patch: object) => calls.update.fn(patch),
}));

const doc = new FakeDocument();
const win = { document: doc, HTMLIFrameElement: FakeIFrame, addEventListener() {}, removeEventListener() {} };
let root: Root;
let store: typeof import("../lib/store/store.ts");
let ModelsPage: typeof import("./Models.tsx")["ModelsPage"];

const GIB = 1024 ** 3;
const installed = (name: string, capabilities: readonly string[] = ["completion"]) => ({ name, digest: name, sizeBytes: 5 * GIB, modifiedAt: "", capabilities });
const curated = (name: string, label: string) => ({ name, label, purpose: "General chat", downloadBytes: 5 * GIB, installed: false, recommended: false });
const CATALOG = [curated("alpha:1b", "Alpha"), curated("beta:2b", "Beta"), curated("gamma:3b", "Gamma")];
const report = (model: string, verdict: "fits" | "spills" | "refuse", card?: object) => ({
  model, numCtx: 16384, freeVramBytes: 8 * GIB, needVramBytes: 4 * GIB, spillRamBytes: verdict === "spills" ? GIB : 0, verdict, source: "estimate", stops: [],
  ...(card === undefined ? {} : { card }),
});
const table = (...rows: readonly object[]) => ({ reading: { boot: "b", seq: 1, measuredAt: 0 }, memory: { kind: "gpu", freeBytes: 8 * GIB, usableBytes: 8 * GIB, totalBytes: 16 * GIB }, rows });

beforeAll(async () => {
  doc.defaultView = win;
  Object.assign(doc, { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" });
  vi.stubGlobal("requestAnimationFrame", (f: () => void) => setTimeout(f, 0));
  const { createRoot } = await import("react-dom/client");
  store = await import("../lib/store/store.ts");
  ({ ModelsPage } = await import("./Models.tsx"));
  root = createRoot(doc.body.appendChild(doc.createElement("div")) as unknown as Element);
});
afterAll(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
beforeEach(() => {
  calls.remove.fn = () => Promise.resolve(null);
  calls.remove.count = 0;
  calls.update.fn = () => Promise.resolve(null);
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
const byTestId = (id: string, from: FakeNode = doc.body) => all((el) => el.getAttribute("data-testid") === id, from)[0] ?? null;
const byClass = (cls: string, from: FakeNode = doc.body) => all((el) => el.classList.includes(cls), from);
const rowOf = (name: string) => {
  const row = all((el) => el.getAttribute("data-dm") === name || el.getAttribute("data-em") === name)[0];
  if (row === undefined) throw new Error(`no row for ${name}`);
  return row;
};
const elementsIn = (el: FakeElement) => el.childNodes.filter((c): c is FakeElement => c instanceof FakeElement);
const props = (el: FakeElement | null): Record<string, unknown> => {
  if (el === null) throw new Error("no such element");
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  return (key === undefined ? {} : (el as unknown as Record<string, Record<string, unknown>>)[key]) ?? {};
};
const fire = async (el: FakeElement | null, handler: string, event: unknown = {}) => {
  await act(async () => { (props(el)[handler] as (e: unknown) => void)(event); });
  await settle();
};
const tab = (shiftKey = false) => {
  const e = { key: "Tab", shiftKey, ctrlKey: false, metaKey: false, altKey: false, prevented: false, preventDefault() { e.prevented = true; }, stopPropagation() {} };
  return e;
};
async function mount(over: Partial<import("../lib/store/store.ts").State> = {}) {
  store.setState({
    conn: { kind: "open" }, view: "settings", section: "models", addPage: false, catalog: CATALOG as never,
    models: [installed("alpha:1b"), installed("beta:2b"), installed("gamma:3b")] as never, model: "alpha:1b",
    settings: { defaultModel: "alpha:1b" } as never, fitTable: undefined, pulls: {}, speeds: undefined, measures: undefined, measuring: {}, unavailable: {}, runtime: undefined,
    ...over,
  });
  act(() => root.render(createElement(ModelsPage)));
  await settle();
}
const menuOf = (name: string) => all((el) => el.getAttribute("role") === "menu", rowOf(name))[0] ?? null;
async function openMenu(name: string) {
  await fire(byTestId("models.row-menu.open", rowOf(name)), "onClick");
  const menu = menuOf(name);
  if (menu === null) throw new Error(`no menu for ${name}`);
  return menu;
}
async function openRemove(name: string) {
  const menu = await openMenu(name);
  await fire(byTestId("models.row-menu.remove", menu), "onClick");
  return byTestId("models.remove.dialog");
}
const disabled = (el: FakeElement | null) => el?.hasAttribute("disabled") === true;

it("a row's menu, as it opens, puts the focus on its first item", async () => {
  await mount();
  const menu = await openMenu("beta:2b");
  const first = all((el) => el.getAttribute("role") === "menuitem", menu)[0];
  expect(first).toBeDefined();
  expect(doc.activeElement).toBe(first);
});

it("wider than a phone, the page is one list under the pop-up's header, with no tabs, and only the list scrolls", async () => {
  await mount();
  const body = byClass("dlg-body")[0]!;
  expect(byClass("dlg-head")[0]!.textContent).toBe("Models");
  expect(all((el) => el.getAttribute("role") === "tablist" || el.getAttribute("role") === "tab")).toHaveLength(0);
  expect(byTestId("models.list.installed", body)).not.toBeNull();
  const css = readFileSync(new URL("../lib/ui/panel.css", import.meta.url), "utf8");
  expect(css).toMatch(/\n\.dlg-head\{flex:none;/);
  expect(css).toMatch(/\n\.dlg-body\{[^}]*min-height:0;overflow-y:auto/);
});

// council climb-025 Q14: Remove on a system Ollama deletes from a store other apps read too
it.each([["external", true], ["none", true], ["app", false]] as const)("Remove on a runtime owned by %s says other apps lose the model: %s", async (owner, says) => {
  await mount({ runtime: { state: "ready", owner, baseUrl: "http://127.0.0.1:11434" } as never });
  const dialog = await openRemove("beta:2b");
  const words = dialog?.textContent ?? "";
  expect(words).toContain("Chats you made with Beta stay");
  expect(words.includes("Other apps that use this Ollama lose it too."), words).toBe(says);
});

it("a removal that worked but whose next default could not be saved closes the dialog, says so once, and is not tried again", async () => {
  await mount();
  calls.remove.fn = () => {
    store.setState({ models: [installed("beta:2b"), installed("gamma:3b")] as never });
    return Promise.resolve(null);
  };
  calls.update.fn = () => Promise.resolve("Couldn't save the default model.");
  const dialog = await openRemove("alpha:1b");
  await fire(byTestId("models.remove.confirm", dialog!), "onClick");
  expect(byTestId("models.remove.dialog")).toBeNull();
  expect(calls.remove.count).toBe(1);
  expect(byClass("mp-note").map((el) => el.textContent)).toEqual(["Alpha was removed. Couldn't save the default model. Set one from a row's menu."]);
});

it("the note that the next default could not be saved ends for good once another default is saved", async () => {
  await mount();
  calls.remove.fn = () => {
    store.setState({ models: [installed("beta:2b"), installed("gamma:3b")] as never });
    return Promise.resolve(null);
  };
  calls.update.fn = () => Promise.resolve("Couldn't save the default model.");
  const dialog = await openRemove("alpha:1b");
  await fire(byTestId("models.remove.confirm", dialog!), "onClick");
  expect(byClass("mp-note")).toHaveLength(1);
  await act(async () => { store.setState({ settings: { defaultModel: "beta:2b" } as never }); });
  await settle();
  expect(byClass("mp-note")).toHaveLength(0);
  await act(async () => { store.setState({ settings: { defaultModel: "gone:9b" } as never }); });
  await settle();
  expect(byClass("mp-note"), "the old note does not come back when the saved default is gone again").toHaveLength(0);
});

it("a download sits in the Installed list at the sorted place its installed row will take", async () => {
  await mount({
    models: [installed("alpha:1b"), installed("gamma:3b")] as never,
    pulls: { "beta:2b": { name: "beta:2b", state: "downloading", completedBytes: GIB, totalBytes: 5 * GIB } },
  });
  const card = byClass("mp-card")[0]!;
  const order = all((el) => el.hasAttribute("data-dm") || el.hasAttribute("data-pull"), card).map((el) => el.getAttribute("data-dm") ?? el.getAttribute("data-pull"));
  expect(order).toEqual(["alpha:1b", "beta:2b", "gamma:3b"]);
});

const measure = (model: string) => ({ model, digest: model, at: 0, numCtx: 16384, tokensPerSecond: 101.6, score: 80, checks: [] });
const speed = (model: string) => ({ model, tokensPerSecond: 101.6, replies: 3 });

it("a measured model's speed shows only in its Speed column, not on its name line too", async () => {
  await mount({ speeds: { "alpha:1b": speed("alpha:1b"), "beta:2b": speed("beta:2b") } as never, measures: { "alpha:1b": measure("alpha:1b") } as never });
  const nameLine = (name: string) => byClass("mp-l1", rowOf(name))[0]!;
  expect(byClass("tps", nameLine("beta:2b")), "an unmeasured model's speed is on its name line").toHaveLength(1);
  expect(byClass("tps", nameLine("alpha:1b"))).toHaveLength(0);
  expect(nameLine("alpha:1b").textContent).not.toContain("tok/s");
  expect(elementsIn(rowOf("alpha:1b")).find((el) => el.classList.includes("mp-spd"))?.textContent).toBe("102 tok/s");
});

it("a model with no purpose has no second line under its name", async () => {
  await mount({ models: [installed("alpha:1b"), installed("mine:7b")] as never });
  const nameBlock = (name: string) => byClass("mp-nm", rowOf(name))[0]!;
  expect(byClass("mp-p", nameBlock("alpha:1b")).map((el) => el.textContent)).toEqual(["General chat"]);
  expect(byClass("mp-p", nameBlock("mine:7b"))).toHaveLength(0);
});

it("the slower-now line on an installed row names who is in the way and carries no speed", async () => {
  const whisper = { label: "whisper", bytes: 2 * GIB, kind: "whisper", protected: true };
  await mount({
    speeds: { "alpha:1b": speed("alpha:1b") } as never,
    measures: { "alpha:1b": measure("alpha:1b") } as never,
    fitTable: table(report("alpha:1b", "spills", { verdict: "fits", freeVramBytes: 8 * GIB, spillRamBytes: 0, inTheWay: [whisper] })) as never,
  });
  const slow = byTestId("models.fit.slow-now", rowOf("alpha:1b"));
  expect(slow).not.toBeNull();
  expect(byClass("mm-why", rowOf("alpha:1b"))[0]?.childNodes.map((c) => c.textContent).join("|")).toMatch(/^\|Slower now · Whisper in the way\|/);
  expect(slow!.textContent).not.toMatch(/tok|102/);
});

const fitCell = (name: string) => elementsIn(rowOf(name)).find((el) => el.classList.includes("mp-fitc"));

it("an installed row's fit cell is a fixed-size wait slot, its column a fixed width", async () => {
  await mount();
  expect(fitCell("alpha:1b")?.getAttribute("data-wait")).toBe("");
  await act(async () => { store.setState({ fitTable: table(report("alpha:1b", "fits")) as never }); });
  await settle();
  expect(fitCell("alpha:1b")?.getAttribute("data-wait")).toBe("");
  const css = readFileSync(new URL("../app/styles.css", import.meta.url), "utf8");
  const columns = [...css.matchAll(/--mp-cols:([^;}]+)/g)].map((m) => m[1]!.split(" ")[2]);
  expect(columns.length).toBeGreaterThan(0);
  for (const fitColumn of columns) expect(fitColumn).toMatch(/^\d+px$/);
});

it("a separator line sits before Remove, the row menu's last item", async () => {
  await mount();
  const items = elementsIn(await openMenu("beta:2b"));
  expect(items.at(-1)?.getAttribute("data-testid")).toBe("models.row-menu.remove");
  expect(items.at(-2)?.getAttribute("role")).toBe("separator");
});

it("the remove dialog puts focus on Cancel as it opens and after a failed removal, and holds it on the dialog while removing with both buttons disabled", async () => {
  await mount();
  const answer: { fn?: Answer } = {};
  calls.remove.fn = () => new Promise((r) => { answer.fn = r; });
  const dialog = await openRemove("beta:2b");
  const cancel = byTestId("models.remove.cancel", dialog!);
  const confirm = byTestId("models.remove.confirm", dialog!);
  expect(doc.activeElement).toBe(cancel);
  await fire(confirm, "onClick");
  expect(disabled(cancel)).toBe(true);
  expect(disabled(confirm)).toBe(true);
  expect(doc.activeElement).toBe(dialog);
  await act(async () => { answer.fn?.("Couldn't remove the model."); });
  await settle();
  expect(byTestId("models.remove.dialog")).toBe(dialog);
  expect(disabled(cancel)).toBe(false);
  expect(doc.activeElement).toBe(cancel);
});

it("Tab and Shift+Tab cycle among the remove dialog's enabled buttons and never leave it", async () => {
  await mount();
  const answer: { fn?: Answer } = {};
  calls.remove.fn = () => new Promise((r) => { answer.fn = r; });
  const dialog = (await openRemove("beta:2b"))!;
  const cancel = byTestId("models.remove.cancel", dialog);
  const confirm = byTestId("models.remove.confirm", dialog);
  const press = async (shift = false) => {
    const e = tab(shift);
    await fire(dialog, "onKeyDown", e);
    expect(e.prevented).toBe(true);
    return doc.activeElement;
  };
  expect(await press()).toBe(confirm);
  expect(await press()).toBe(cancel);
  expect(await press(true)).toBe(confirm);
  expect(await press(true)).toBe(cancel);
  await fire(confirm, "onClick");
  expect(await press(), "while removing no button is enabled, so the dialog keeps the focus").toBe(dialog);
  expect(await press(true)).toBe(dialog);
  await act(async () => { answer.fn?.("Couldn't remove the model."); });
  await settle();
});

const hasUseAsDefault = (menu: FakeElement) => byTestId("models.row-menu.make-default", menu) !== null;

it("only the saved default's own row menu lacks Use as default, not a default nobody saved", async () => {
  await mount({ settings: { defaultModel: "beta:2b" } as never });
  expect(hasUseAsDefault(await openMenu("beta:2b"))).toBe(false);
  await mount({ settings: {} as never, model: "alpha:1b" });
  expect(byClass("mp-chip", rowOf("alpha:1b")), "the card names the model new chats start on").toHaveLength(1);
  expect(hasUseAsDefault(await openMenu("alpha:1b"))).toBe(true);
});

it("the remove dialog names the model that becomes the default, or says new chats wait when none can", async () => {
  await mount();
  const dialog = await openRemove("alpha:1b");
  expect(dialog!.textContent).toContain("Beta, the next model in your list, becomes the default for new chats.");
  expect(dialog!.textContent).not.toContain("No other installed model can chat");
  await mount({ models: [installed("alpha:1b"), installed("embed:1b", ["embedding"])] as never });
  const alone = await openRemove("alpha:1b");
  expect(alone!.textContent).toContain("No other installed model can chat, so new chats wait until you download one.");
  expect(alone!.textContent).not.toContain("becomes the default");
});

/** Every model row on the page, top to bottom: i for installed, d for downloading, o for offered. */
const order = () => all((el) => el.classList.includes("mp-row")).map((el) => {
  const dm = el.getAttribute("data-dm") ?? el.getAttribute("data-em"), pull = el.getAttribute("data-pull");
  return dm !== null ? `i ${dm}` : pull !== null ? `d ${pull}` : `o ${el.getAttribute("data-cat") ?? "?"}`;
});
const fits = table(report("alpha:1b", "fits"), report("beta:2b", "fits"), report("gamma:3b", "fits"));
const downloading = (name: string) => ({ name, state: "downloading" as const, completedBytes: GIB, totalBytes: 5 * GIB });
const change = async (over: Partial<import("../lib/store/store.ts").State>) => { await act(async () => { store.setState(over); }); await settle(); };

it("a model that is offered keeps its row from Download through progress to installed, and no other row moves", async () => {
  await mount({ models: [installed("alpha:1b")] as never, fitTable: fits as never });
  expect(order()).toEqual(["i alpha:1b", "o beta:2b", "o gamma:3b"]);
  expect(props(byTestId("models.offered.download", all((el) => el.getAttribute("data-cat") === "beta:2b")[0]))["aria-label"]).toBe("Download Beta, 5.0 GB");
  await change({ pulls: { "beta:2b": downloading("beta:2b") } });
  expect(order()).toEqual(["i alpha:1b", "d beta:2b", "o gamma:3b"]);
  expect(all((el) => el.getAttribute("role") === "progressbar")).toHaveLength(1);
  await change({ pulls: { "beta:2b": { ...downloading("beta:2b"), state: "done" as const } }, models: [installed("alpha:1b"), installed("beta:2b")] as never });
  expect(order()).toEqual(["i alpha:1b", "i beta:2b", "o gamma:3b"]);
  // it has an installed row's controls where it stands
  expect(byTestId("models.row-menu.open", rowOf("beta:2b"))).not.toBeNull();
  // removed again, the list offers it where it was
  await change({ pulls: {}, models: [installed("alpha:1b")] as never });
  expect(order()).toEqual(["i alpha:1b", "o beta:2b", "o gamma:3b"]);
});

it("with no models, the page says so in one line over the offered list, and a first download is a row of that list", async () => {
  await mount({ models: [] as never, model: null as never, settings: {} as never, fitTable: fits as never });
  expect(byTestId("models.empty")?.textContent).toBe("No models yet. Download one to start chatting.");
  expect(byTestId("models.list.installed")).toBeNull();
  expect(order()).toEqual(["o alpha:1b", "o beta:2b", "o gamma:3b"]);
  expect(byClass("mp-th"), "the offered list carries the column heads").toHaveLength(1);
  await change({ pulls: { "beta:2b": downloading("beta:2b") } });
  expect(order()).toEqual(["o alpha:1b", "d beta:2b", "o gamma:3b"]);
  await change({ pulls: {}, models: [installed("beta:2b")] as never });
  expect(order()).toEqual(["o alpha:1b", "i beta:2b", "o gamma:3b"]);
  expect(byTestId("models.empty"), "it no longer says there are none").toBeNull();
});

it("a download started by a typed name gets a row under the box it was typed in, and stays there when installed", async () => {
  await mount({ models: [installed("alpha:1b")] as never, fitTable: fits as never });
  expect(byTestId("models.list.typed")).toBeNull();
  await change({ pulls: { "zeta:9b": downloading("zeta:9b") } });
  const typed = byTestId("models.list.typed");
  expect(all((el) => el.getAttribute("data-pull") === "zeta:9b", typed!)).toHaveLength(1);
  expect(order()).toEqual(["i alpha:1b", "o beta:2b", "o gamma:3b", "d zeta:9b"]);
  await change({ pulls: {}, models: [installed("alpha:1b"), installed("zeta:9b")] as never });
  expect(order()).toEqual(["i alpha:1b", "o beta:2b", "o gamma:3b", "i zeta:9b"]);
  // a model put there by another program, with no download here, joins the installed ones
  await change({ models: [installed("alpha:1b"), installed("zeta:9b"), installed("omega:1b")] as never });
  expect(order()).toEqual(["i alpha:1b", "i omega:1b", "o beta:2b", "o gamma:3b", "i zeta:9b"]);
});

it("a download already running when the page opens is among the installed models, and the list below does not offer it", async () => {
  await mount({ models: [installed("alpha:1b")] as never, fitTable: fits as never, pulls: { "gamma:3b": downloading("gamma:3b") } });
  expect(order()).toEqual(["i alpha:1b", "d gamma:3b", "o beta:2b"]);
  const top = byTestId("models.list.installed")!;
  expect(all((el) => el.getAttribute("data-pull") === "gamma:3b", top)).toHaveLength(1);
});

it("opened to add a model, the offered list is brought into view once", async () => {
  const seen: FakeElement[] = [];
  Object.assign(FakeElement.prototype, { scrollIntoView(this: FakeElement) { seen.push(this); } });
  await mount({ fitTable: fits as never, addPage: true, models: [installed("alpha:1b")] as never });
  expect(seen).toHaveLength(1);
  expect(all((el) => el.getAttribute("data-cat") === "beta:2b", seen[0])).toHaveLength(1);
  expect(byTestId("models.list.installed", seen[0])).toBeNull();
  expect(store.getState().addPage).toBe(false);
  await change({ pulls: {} });
  expect(seen, "a later render does not scroll").toHaveLength(1);
  seen.length = 0;
  await mount({ fitTable: fits as never, models: [installed("alpha:1b")] as never });
  expect(seen, "opened from the sidebar, the page stays at its top").toHaveLength(0);
});

it("the size column is the file's size, in its own column beside what the model needs on this computer", async () => {
  await mount();
  const head = byClass("mp-th")[0]!;
  expect(byClass("mp-sz", head).map((el) => el.textContent)).toEqual(["Size"]);
  expect(byClass("mp-fitc", head).map((el) => el.textContent)).toEqual(["On this computer"]);
});

it("a row carries no verdict while the fit check runs, so it is not marked as unable to run", async () => {
  await mount();
  expect(rowOf("alpha:1b").classList).not.toContain("cant");
  await act(async () => { store.setState({ fitTable: table(report("alpha:1b", "refuse")) as never }); });
  await settle();
  expect(rowOf("alpha:1b").classList, "a refusal from the table does mark it").toContain("cant");
});

it("a model that never chats carries no verdict, even when the fit table has a row for it", async () => {
  await mount({
    models: [installed("alpha:1b"), installed("embed:1b", ["embedding"])] as never,
    fitTable: table(report("alpha:1b", "refuse"), report("embed:1b", "refuse")) as never,
  });
  expect(rowOf("alpha:1b").classList).toContain("cant");
  expect(rowOf("embed:1b").classList).toEqual(["mp-row", "emb"]);
});
