import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { CHAT_MODELS, fitWords, suggestedList, type CatalogEntry, type ContextSize, type FitReport, type FitTable, type ModelEstimate, type PullProgress } from "@gates-local/contracts";
import { FakeDocument, FakeElement, FakeIFrame, type FakeNode } from "../../test/fake-dom.ts";

type Answer = string | null;
const calls = vi.hoisted(() => ({
  pull: { fn: null as unknown as (name: string) => Promise<string | null> },
  cancel: { fn: null as unknown as (name: string) => Promise<string | null> },
  estimate: { fn: null as unknown as (name: string, numCtx: number) => Promise<unknown> },
}));
vi.mock("../lib/session/index.ts", async (original) => ({
  ...await original<typeof import("../lib/session/index.ts")>(),
  pull: (name: string) => calls.pull.fn(name),
  cancelPull: (name: string) => calls.cancel.fn(name),
  estimateModel: (name: string, numCtx: number) => calls.estimate.fn(name, numCtx),
}));

const GIB = 1024 ** 3;
const doc = new FakeDocument();
const win = { document: doc, HTMLIFrameElement: FakeIFrame, addEventListener() {}, removeEventListener() {} };
let root: Root;
let store: typeof import("../lib/store/store.ts");
let view: typeof import("./ModelDownloads.tsx");

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
  view = await import("./ModelDownloads.tsx");
  root = createRoot(doc.body.appendChild(doc.createElement("div")) as unknown as Element);
});
afterAll(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
beforeEach(() => {
  calls.pull.fn = () => Promise.resolve(null);
  calls.cancel.fn = () => Promise.resolve(null);
  calls.estimate.fn = () => Promise.resolve(undefined);
  doc.activeElement = null;
  store.setState({ suggested: suggestedList(CHAT_MODELS), gpu: undefined, catalog: [], models: [], pulls: {}, unavailable: {}, numCtx: 16384, fitTable: undefined });
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
const rowOf = (name: string) => all((el) => el.getAttribute("data-cat") === name)[0] ?? null;
const props = (el: FakeElement | null): Record<string, unknown> => {
  if (el === null) throw new Error("no such element");
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  return (key === undefined ? {} : (el as unknown as Record<string, Record<string, unknown>>)[key]) ?? {};
};
const fire = async (el: FakeElement | null, handler: string, event: unknown = {}) => {
  await act(async () => { (props(el)[handler] as (e: unknown) => void)(event); });
  await settle();
};
const update = async (patch: Partial<import("../lib/store/store.ts").State>) => {
  act(() => store.setState(patch));
  await settle();
};

function held(): { promise: Promise<Answer>; answer: (a: Answer) => Promise<void> } {
  let answer: ((a: Answer) => void) | undefined;
  const promise = new Promise<Answer>((r) => { answer = r; });
  return { promise, answer: async (a) => { await act(async () => { answer?.(a); }); await settle(); } };
}

type Verdict = FitReport["verdict"];
const fitOf = (model: string, verdict: Verdict, numCtx: ContextSize = 16384) => {
  const r = { model, numCtx, verdict, freeVramBytes: 16 * GIB, needVramBytes: (verdict === "refuse" ? 40 : 6) * GIB, spillRamBytes: verdict === "spills" ? GIB : 0, source: "estimate" as const };
  return { ...r, words: fitWords(r, "card", false) };
};
let seq = 0;
const tableOf = (rows: ReturnType<typeof fitOf>[], others?: { programs: string[]; bytes: number }): FitTable => ({
  reading: { boot: "b", seq: ++seq, measuredAt: 0 },
  memory: { kind: "gpu", freeBytes: 16 * GIB, usableBytes: 15 * GIB, totalBytes: 16 * GIB, ...(others === undefined ? {} : { others }) },
  rows: rows.map((r) => ({ ...r, stops: [] })),
});
const entry = (name: string, recommended: boolean, rank?: number): CatalogEntry => ({ name, label: name.toUpperCase(), purpose: "General chat", downloadBytes: 5 * GIB, installed: false, recommended, ...(rank === undefined ? {} : { rank }) });
const downloading = (name: string, completedBytes: number): PullProgress => ({ name, state: "downloading", completedBytes, totalBytes: 5 * GIB });

async function mountTab(over: Partial<import("../lib/store/store.ts").State>) {
  store.setState(over);
  act(() => root.render(createElement(view.DownloadTab)));
  await settle();
}
/** Each group in order: its title and the catalog names under it; a kept, hidden header is not a group. */
const groups = () => all((el) => el.classList.includes("grp") && !el.classList.includes("grp-keep")).map((g) => {
  const title = all((el) => el.classList.includes("grp-t"), g)[0]?.childNodes[0]?.textContent ?? "";
  return [title, all((el) => el.getAttribute("data-cat") !== null, g).map((el) => el.getAttribute("data-cat"))] as const;
});
const errorOf = (name: string) => all((el) => el.classList.includes("dl-error"), rowOf(name) ?? doc.body)[0]?.textContent ?? null;

it("on the phone a running download shows its progress and no ×, here and among the downloading rows", async () => {
  const p = downloading("a:1", GIB);
  await mountTab({ catalog: [entry("a:1", false)], fitTable: tableOf([fitOf("a:1", "fits")]), pulls: { "a:1": p }, unavailable: { "models.cancelPull": true } });
  expect(all((el) => el.classList.includes("dl-run"), rowOf("a:1")!)).toHaveLength(1);
  expect(byTestId("models.download.cancel")).toBeNull();
  act(() => root.render(createElement(view.DownloadingRow, { p })));
  expect(byTestId("models.downloading.cancel")).toBeNull();
  await update({ unavailable: {} });
  expect(byTestId("models.downloading.cancel")).not.toBeNull();
  act(() => root.render(createElement(view.DownloadTab)));
  await settle();
  expect(byTestId("models.download.cancel")).not.toBeNull();
});

const button = (p: PullProgress | undefined, size: string | undefined = "5.0 GB") => renderToStaticMarkup(createElement(view.DlButton, { size, label: "A", p, onCancel: () => undefined }));

it("until the download's size is known, its button reads 0 and waits with an ellipsis", () => {
  const html = button({ name: "a:1", state: "downloading", completedBytes: 3 * GIB });
  expect(html).toContain('aria-valuenow="0"');
  expect(html).toContain('<i style="width:0%"></i><span>…</span>');
});

it("a download's percent never reads past 100", () => {
  const html = button({ name: "a:1", state: "downloading", completedBytes: 6 * GIB, totalBytes: 5 * GIB });
  expect(html).toContain('aria-valuenow="100"');
  expect(html).toContain('<i style="width:100%"></i><span>Finishing</span>');
});

/** The two boxes of a download button: the first box's classes and the × box's (or the side slot's ×). */
const boxes = (html: string) => {
  const [first, second] = [...html.matchAll(/^<div class="dl-a">|<(?:span|button) [^>]*?class="([^"]+)"/g)].slice(1).map((m) => m[1]);
  return [first, second?.startsWith("dl-side") ? /<span class="dl-side"><button [^>]*?class="([^"]+)"/.exec(html)?.[1] : second];
};
const lastCompound = (selector: string) => selector.split(/\s+/).at(-1) ?? "";
const rules = (css: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: (m[1] ?? "").trim().split(",").map((s) => s.trim()), decls: (m[2] ?? "").split(";").map((d) => d.trim()).filter((d) => d !== "") }));

it("the size button and the × box are the same two fixed-width boxes in every state, so nothing beside them moves", () => {
  const states = [
    renderToStaticMarkup(createElement(view.DlButton, { size: "5.0 GB", label: "A" })),
    renderToStaticMarkup(createElement(view.DlButton, { size: undefined, label: "A" })),
    button(downloading("a:1", GIB)),
    renderToStaticMarkup(createElement(view.DlButton, { size: "5.0 GB", label: "A", installed: true })),
    renderToStaticMarkup(createElement(view.DlButton, { size: "5.0 GB", label: "A", side: createElement("button", { type: "button", className: "dl-x" }) })),
  ];
  for (const html of states) {
    const [first, second] = boxes(html);
    expect(first?.split(" "), html).toContain("dl-btn");
    expect(second?.split(" "), html).toContain("dl-x");
  }
  const css = readFileSync(new URL("../app/styles.css", import.meta.url), "utf8");
  const sheet = rules(css);
  const base = (selector: string) => sheet.find((r) => r.selectors.length === 1 && r.selectors[0] === selector)?.decls ?? [];
  expect(base(".dl-btn")).toEqual(expect.arrayContaining(["box-sizing:border-box", "width:104px", "height:32px"]));
  expect(base(".dl-x")).toEqual(expect.arrayContaining(["box-sizing:border-box", "width:32px", "height:32px"]));
  expect(base(".dl-side")).toEqual(["display:contents"]);
  expect(base(".dl-x.off")).toEqual(["visibility:hidden"]);
  const sizing = /^(?:width|min-width|max-width|height|min-height|max-height|padding(?:-\w+)?|flex(?:-basis)?|border(?:-width)?|display):/;
  const stateRules = sheet.filter((r) => r.selectors.some((s) => /\.dl-(?:btn|x|run|done|skel)\b/.test(lastCompound(s)) && !/^\.dl-(?:btn|x)$/.test(lastCompound(s)) && s !== ".dl-x.off"));
  expect(stateRules.length).toBeGreaterThan(0);
  for (const r of stateRules) expect(r.decls.filter((d) => sizing.test(d)), r.selectors.join(",")).toEqual([]);
});

it("while the download's size is unknown its button says plain Download, with no size", () => {
  const html = renderToStaticMarkup(createElement(view.DlButton, { size: undefined, label: "A" }));
  expect(html).toMatch(/<button type="button" class="dl-btn" data-testid="models.download.start" aria-label="Download">/);
  expect(html.replace(/<[^>]+>/g, "")).toBe("Download");
});

const estimate = (over: Partial<ModelEstimate>): ModelEstimate => ({ name: "x:1", found: "yes", downloadBytes: 5 * GIB, ...over });
const refused = estimate({ downloadBytes: 30 * GIB, fit: { ...fitOf("huge:1t", "refuse"), measuredAt: 0 } });
const started: string[] = [];
let startAnswer: () => Promise<boolean> = () => Promise.resolve(true);
const actions = {
  start: (name: string) => { started.push(name); return startAnswer(); },
  cancel: () => undefined,
  error: () => null,
};
async function mountCustom(numCtx: number = 16384) {
  act(() => root.render(createElement(view.CustomPull, { actions, numCtx })));
  await settle();
}
const field = () => byTestId("models.custom.name");
const type = (value: string) => fire(field(), "onChange", { target: { value } });
const enter = () => fire(field(), "onKeyDown", { key: "Enter", preventDefault() {} });
const startButton = () => byTestId("models.download.start");
const line = () => all((el) => el.classList.includes("dl-typed"))[0] ?? null;
beforeEach(() => { started.length = 0; startAnswer = () => Promise.resolve(true); });

it("opening the typed name's ⋯ menu puts focus on its first item", async () => {
  calls.estimate.fn = () => Promise.resolve(refused);
  await mountCustom();
  await type("huge:1t");
  await enter();
  await fire(byTestId("models.custom.more"), "onClick");
  expect(doc.activeElement).not.toBeNull();
  expect(doc.activeElement).toBe(byTestId("models.custom.download-anyway"));
});

it("the typed name's answer goes once the name or the context changes", async () => {
  calls.estimate.fn = () => Promise.resolve(refused);
  await mountCustom();
  await type("huge:1t");
  await enter();
  expect(line()?.textContent?.replaceAll("\u00a0", " ")).toBe("Too big for this computer · needs 40.0 GB");
  expect(props(startButton())["disabled"]).toBe(true);
  await type("huge:2t");
  expect(line()).toBeNull();
  expect(byTestId("models.custom.more")).toBeNull();
  expect(props(startButton())["disabled"]).toBe(false);
  await type("huge:1t");
  expect(line()).not.toBeNull();
  await mountCustom(32768);
  expect(line()).toBeNull();
  expect(props(startButton())["disabled"]).toBe(false);
});

it("the typed name stays in the field while its download is asked for and when it does not start, and goes once it starts", async () => {
  calls.estimate.fn = () => Promise.resolve(estimate({ fit: { ...fitOf("gemma4:26b", "fits"), measuredAt: 0 } }));
  let answer = held();
  startAnswer = () => answer.promise.then((a) => a === null);
  await mountCustom();
  await type("gemma4:26b");
  await fire(startButton(), "onClick");
  expect(started).toEqual(["gemma4:26b"]);
  expect(props(field())["value"]).toBe("gemma4:26b");
  await answer.answer("Couldn't start the download.");
  expect(props(field())["value"]).toBe("gemma4:26b");
  answer = held();
  await fire(startButton(), "onClick");
  expect(props(field())["value"]).toBe("gemma4:26b");
  await answer.answer(null);
  expect(props(field())["value"]).toBe("");
});

it("a name edited while its download starts stays in the field", async () => {
  calls.estimate.fn = () => Promise.resolve(estimate({ fit: { ...fitOf("gemma4:26b", "fits"), measuredAt: 0 } }));
  const answer = held();
  startAnswer = () => answer.promise.then((a) => a === null);
  await mountCustom();
  await type("gemma4:26b");
  await fire(startButton(), "onClick");
  await type("gemma4:27b");
  await answer.answer(null);
  expect(started).toEqual(["gemma4:26b"]);
  expect(props(field())["value"]).toBe("gemma4:27b");
});

it("Download with no answer yet that stops says why under the field, with the ⋯ menu for one too big", async () => {
  calls.estimate.fn = () => Promise.resolve(estimate({ found: "no" }));
  await mountCustom();
  await type("nope:1b");
  await fire(startButton(), "onClick");
  expect(started).toEqual([]);
  expect(line()?.textContent).toBe("Not in the Ollama library. Check the name.");
  expect(line()?.classList).toContain("no");
  calls.estimate.fn = () => Promise.resolve(refused);
  await type("huge:1t");
  await fire(startButton(), "onClick");
  expect(started).toEqual([]);
  expect(line()?.textContent?.replaceAll("\u00a0", " ")).toBe("Too big for this computer · needs 40.0 GB");
  expect(byTestId("models.custom.more")).not.toBeNull();
});

it("a typed name whose size could not be read says so under the field and can still download", async () => {
  calls.estimate.fn = () => Promise.resolve(estimate({ found: "unknown", downloadBytes: undefined }));
  await mountCustom();
  await type("odd:1b");
  await enter();
  expect(line()?.textContent).toBe("Couldn't read this model's size, so it is not checked.");
  expect(line()?.classList).not.toContain("no");
  expect(props(startButton())["disabled"]).toBe(false);
});

it("a typed name that would spill says it is slower once, under the field, and says nothing on a computer with no GPU", async () => {
  calls.estimate.fn = () => Promise.resolve(estimate({ fit: { ...fitOf("big:30b", "spills"), measuredAt: 0 } }));
  store.setState({ gpu: { vendor: "nvidia", occupants: [], systemMemoryAvailableBytes: 0, measuredAt: 0 } });
  await mountCustom();
  await type("big:30b");
  await enter();
  expect(line()?.textContent).toBe("Uses system memory · slower");
  expect(doc.body.textContent.split("slower")).toHaveLength(2);
  act(() => root.render(null));
  store.setState({ gpu: { vendor: "none", occupants: [], systemMemoryAvailableBytes: 0, measuredAt: 0 } });
  await mountCustom();
  await type("big:30b");
  await enter();
  expect(line()).toBeNull();
});

it("no line about other programs when nothing else holds the GPU", async () => {
  const memory = { kind: "gpu", freeBytes: 16 * GIB, usableBytes: 15 * GIB } as const;
  expect(view.othersOf({ fitTable: { ...tableOf([]), memory } })).toBeUndefined();
  expect(view.othersOf({ fitTable: { ...tableOf([]), memory: { kind: "cpu" } } })).toBeUndefined();
  expect(view.othersOf({ fitTable: undefined })).toBeUndefined();
  expect(view.othersOf({ fitTable: tableOf([], { programs: ["blender"], bytes: GIB }) })).toEqual({ programs: ["blender"], bytes: GIB });
  await mountTab({ catalog: [entry("a:1", false)], fitTable: tableOf([fitOf("a:1", "fits")]) });
  expect(all((el) => el.classList.includes("dl-others"))).toEqual([]);
  await update({ fitTable: tableOf([fitOf("a:1", "fits")], { programs: ["blender"], bytes: GIB }) });
  expect(all((el) => el.classList.includes("dl-others"))).toHaveLength(1);
});

const said = (programs: string[]) => view.othersLine({ programs, bytes: 2 * GIB }).replaceAll("\u00a0", " ");
it("the line about other programs names one, two, the first and how many more, or just other programs", () => {
  expect(said(["blender"])).toBe("blender is using 2.0 GB of GPU memory right now.");
  expect(said(["blender", "ComfyUI"])).toBe("blender and ComfyUI are using 2.0 GB of GPU memory right now.");
  expect(said(["blender", "ComfyUI", "obs"])).toBe("blender and 2 other programs are using 2.0 GB of GPU memory right now.");
  expect(said(["blender", "ComfyUI", "obs", "steam"])).toBe("blender and 3 other programs are using 2.0 GB of GPU memory right now.");
  expect(said([])).toBe("Other programs are using 2.0 GB of GPU memory right now.");
});

it("only a model's newest download attempt says how it went: a Cancel's answer stands over an older pull's, and an older success does not clear a newer error", async () => {
  await mountTab({ catalog: [entry("a:1", false)], fitTable: tableOf([fitOf("a:1", "fits")]) });
  const first = held();
  calls.pull.fn = () => first.promise;
  await fire(startButton(), "onClick");
  await update({ pulls: { "a:1": downloading("a:1", GIB) } });
  await fire(byTestId("models.download.cancel"), "onClick");
  await first.answer("The first pull was refused.");
  expect(errorOf("a:1")).toBeNull();
  await update({ pulls: {} });
  const older = held(), newer = held();
  calls.pull.fn = () => older.promise;
  await fire(startButton(), "onClick");
  calls.pull.fn = () => newer.promise;
  await fire(startButton(), "onClick");
  await newer.answer("The second pull was refused.");
  expect(errorOf("a:1")).toBe("The second pull was refused.");
  await older.answer(null);
  expect(errorOf("a:1")).toBe("The second pull was refused.");
});

it("a cancel that failed keeps its error while that download goes on", async () => {
  await mountTab({ catalog: [entry("a:1", false)], fitTable: tableOf([fitOf("a:1", "fits")]), pulls: { "a:1": downloading("a:1", GIB) } });
  calls.cancel.fn = () => Promise.resolve("Couldn't cancel the download.");
  await fire(byTestId("models.download.cancel"), "onClick");
  expect(errorOf("a:1")).toBe("Couldn't cancel the download.");
  await update({ pulls: { "a:1": downloading("a:1", 2 * GIB) } });
  expect(errorOf("a:1")).toBe("Couldn't cancel the download.");
  await update({ pulls: { "a:1": downloading("a:1", 3 * GIB) } });
  expect(errorOf("a:1")).toBe("Couldn't cancel the download.");
});

it("changing the context size within a visit groups the rows again at the new size", async () => {
  await mountTab({ catalog: [entry("a:1", true), entry("b:1", false)], fitTable: tableOf([fitOf("b:1", "fits")]) });
  expect(groups().slice(0, 2)).toEqual([["Also available", ["a:1", "b:1"]], ["Something else", []]]);
  await update({ numCtx: 32768, fitTable: tableOf([fitOf("a:1", "fits", 32768), fitOf("b:1", "fits", 32768)]) });
  expect(groups().slice(0, 2)).toEqual([["Recommended", ["a:1"]], ["Also available", ["b:1"]]]);
});

it("a model too big for this computer is only in the last group, Too big for this computer", async () => {
  await mountTab({ catalog: [entry("a:1", true), entry("b:1", false), entry("c:1", false)], fitTable: tableOf([fitOf("a:1", "fits"), fitOf("b:1", "refuse"), fitOf("c:1", "fits")]) });
  const shown = groups();
  expect(shown.at(-1)).toEqual(["Too big for this computer", ["b:1"]]);
  expect(shown.filter(([, names]) => names.includes("b:1"))).toHaveLength(1);
  expect(shown.map(([title]) => title)).toEqual(["Recommended", "Also available", "Something else", "Too big for this computer"]);
});

it("a Recommended group that showed and then emptied keeps its header's place for the visit", async () => {
  await mountTab({ catalog: [entry("a:1", true), entry("b:1", false)], fitTable: tableOf([fitOf("a:1", "fits"), fitOf("b:1", "fits")]) });
  expect(groups()[0]).toEqual(["Recommended", ["a:1"]]);
  expect(all((el) => el.classList.includes("grp-keep"))).toEqual([]);
  await update({ fitTable: tableOf([fitOf("a:1", "refuse"), fitOf("b:1", "fits")]) });
  expect(groups().map(([title]) => title)).toEqual(["Also available", "Something else", "Too big for this computer"]);
  const kept = all((el) => el.classList.includes("grp-keep"));
  expect(kept).toHaveLength(1);
  expect(kept[0]?.getAttribute("aria-hidden")).toBe("true");
  expect(doc.body.childNodes[0]?.childNodes[0]).toBe(kept[0]);
});

it("a model that joins the catalog after the rows are grouped comes at the end, and no row already there moves", async () => {
  await mountTab({ catalog: [entry("a:1", true), entry("b:1", false), entry("c:1", false)], fitTable: tableOf([fitOf("a:1", "fits"), fitOf("b:1", "fits"), fitOf("c:1", "fits")]) });
  expect(groups().slice(0, 2)).toEqual([["Recommended", ["a:1"]], ["Also available", ["b:1", "c:1"]]]);
  await update({
    catalog: [entry("0new:1", true, 0), entry("a:1", true), entry("b:1", false), entry("c:1", false)],
    fitTable: tableOf([fitOf("0new:1", "fits"), fitOf("a:1", "fits"), fitOf("b:1", "fits"), fitOf("c:1", "fits")]),
  });
  expect(groups().slice(0, 2)).toEqual([["Recommended", ["a:1"]], ["Also available", ["b:1", "c:1", "0new:1"]]]);
});
