import { readdirSync, readFileSync } from "node:fs";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";
import { FakeDocument, FakeElement, FakeIFrame, type FakeNode } from "../../../test/fake-dom.ts";
import { type Browser, installBrowser, tick, until } from "../../../test/harness.ts";
import { CopyButton, PathText, Status } from "./settings-controls.tsx";
import { Grp, useAct } from "./settings-ui.tsx";
import type { ActionResult } from "../session/index.ts";

const copied = vi.hoisted(() => ({ result: Promise.resolve(true), texts: [] as string[] }));
vi.mock("./copy.ts", async (original) => ({
  ...await original<typeof import("./copy.ts")>(),
  copyText: (text: string) => { copied.texts.push(text); return copied.result; },
}));

function all(pred: (el: FakeElement) => boolean, from: FakeNode): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (n: FakeNode) => { for (const c of n.childNodes) if (c instanceof FakeElement) { if (pred(c)) out.push(c); walk(c); } };
  walk(from);
  return out;
}
const props = (el: FakeElement | undefined): Record<string, unknown> => {
  if (el === undefined) throw new Error("no such element");
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  return (key === undefined ? {} : (el as unknown as Record<string, Record<string, unknown>>)[key]) ?? {};
};
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const words = (tip: string) => tip.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
const decode = (s: string) => s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#x27;", "'").replaceAll("&amp;", "&");
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let done: ((v: T) => void) | undefined;
  const promise = new Promise<T>((r) => { done = r; });
  return { promise, resolve: (v: T) => done?.(v) };
}
const SRC = new URL("../../", import.meta.url);
const tsxFiles = (): string[] => readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".tsx"));

describe("mounted on the fake DOM", () => {
  const doc = new FakeDocument();
  let root: Root;
  beforeAll(async () => {
    doc.defaultView = { document: doc, HTMLIFrameElement: FakeIFrame, addEventListener() {}, removeEventListener() {} };
    Object.assign(doc, { addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", doc.defaultView);
    vi.stubGlobal("document", doc);
    vi.stubGlobal("HTMLElement", FakeElement);
    const { createRoot } = await import("react-dom/client");
    root = createRoot(doc.body.appendChild(doc.createElement("div")) as unknown as Element);
  });
  afterEach(() => { act(() => root.render(null)); });
  const button = () => all((el) => el.getAttribute("data-testid") === "settings.copy.command", doc.body)[0];
  afterAll(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });

  it("a Copy button says Copied after a copy that worked, Couldn't copy after one that failed, and its label again once focus leaves it", async () => {
    act(() => root.render(createElement(CopyButton, { text: "ollama pull qwen3", label: "Copy the command", handle: "command" })));
    expect(button()?.textContent).toBe("Copy");
    expect(button()?.getAttribute("aria-label")).toBe("Copy the command");
    copied.result = Promise.resolve(true);
    await act(async () => { (props(button()).onClick as () => void)(); });
    await settle();
    expect(copied.texts).toEqual(["ollama pull qwen3"]);
    expect(button()?.textContent).toBe("Copied");
    expect(button()?.hasAttribute("aria-label")).toBe(false);
    await act(async () => { (props(button()).onBlur as () => void)(); });
    expect(button()?.textContent).toBe("Copy");
    expect(button()?.getAttribute("aria-label")).toBe("Copy the command");
    copied.result = Promise.resolve(false);
    await act(async () => { (props(button()).onClick as () => void)(); });
    await settle();
    expect(button()?.textContent).toBe("Couldn't copy");
    await act(async () => { (props(button()).onBlur as () => void)(); });
    expect(button()?.textContent).toBe("Copy");
  });

  it("an action's failure is nothing until one fails, shows the failure, and is gone as soon as the next try starts", async () => {
    const seen: (string | null)[] = [];
    let run: ((action: Promise<ActionResult>) => Promise<boolean>) | undefined;
    const Control = () => { const [err, r] = useAct(); run = r; seen.push(err); return null; };
    act(() => root.render(createElement(Control)));
    expect(seen.at(-1)).toBeNull();
    let first: Promise<boolean> | undefined;
    await act(async () => { first = run?.(Promise.resolve("Couldn't save the folder.")); await first; });
    await expect(first).resolves.toBe(false);
    expect(seen.at(-1)).toBe("Couldn't save the folder.");
    const next = deferred<ActionResult>();
    let second: Promise<boolean> | undefined;
    await act(async () => { second = run?.(next.promise); });
    expect(seen.at(-1)).toBeNull();
    await act(async () => { next.resolve(null); await second; });
    await expect(second).resolves.toBe(true);
    expect(seen.at(-1)).toBeNull();
  });
});

it("a status's colour is its dot alone: the words carry no status class and the stylesheet gives .stat no colour", () => {
  for (const dot of ["ok", "warn", "err", "off", "run"]) {
    const html = renderToStaticMarkup(createElement(Status, { dot, children: "Short of memory" }));
    expect(html).toBe(`<span class="stat"><span class="dot ${dot}"></span>Short of memory</span>`);
  }
  const css = readFileSync(new URL("../../app/styles.css", import.meta.url), "utf8");
  const statRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, sel]) => (sel ?? "").split(",").some((s) => /\.stat\b/.test(s) && !/\.dot\b/.test(s)));
  expect(statRules.length).toBeGreaterThan(0);
  for (const [rule, , body] of statRules) expect(body, rule).not.toMatch(/(?:^|;)\s*color\s*:/);
});

it("a long path reads from ~, cut in the middle, with the whole path kept for its hover and the cut head marked for measuring", () => {
  const path = "/home/alice/projects/gates-local/models/library.sqlite";
  const html = renderToStaticMarkup(createElement(PathText, { path }));
  const m = /^<span class="path mono" tabindex="0" data-tipt="([^"]*)" data-testid="[^"]*"><span class="([^"]*)">([^<]*)<\/span><span class="mp-t">([^<]*)<\/span><\/span>$/.exec(html);
  expect(m, html).not.toBeNull();
  const [, tipt, headClass, head, tail] = m ?? [];
  expect(tipt).toBe(path);
  expect(headClass?.split(" ")).toContain("t");
  expect(`${head}${tail}`).toBe("~/projects/gates-local/models/library.sqlite");
  expect(tail).not.toBe("");
});

it("a group that is busy says so on its card, and one that is not says nothing", () => {
  expect(renderToStaticMarkup(createElement(Grp, { title: "Models", busy: true, children: "x" }))).toMatch(/^<div class="grp" aria-busy="true">/);
  expect(renderToStaticMarkup(createElement(Grp, { title: "Models", children: "x" }))).not.toContain("aria-busy");
});

it("the web app draws no native select anywhere; a short fixed set is a segmented control", () => {
  const files = tsxFiles();
  expect(files.length).toBeGreaterThan(40);
  for (const f of files) expect(readFileSync(new URL(f, SRC), "utf8"), f).not.toMatch(/<select[\s>/]|createElement\(\s*["']select["']/);
});

describe("over the in-memory server", () => {
  let b: Browser;
  let stop: () => void;
  let store: typeof import("../store/store.ts");
  let SettingsView: typeof import("../../settings/Settings.tsx")["SettingsView"];
  const SECTIONS = ["general", "models", "instructions", "library", "tools", "images", "runtime", "advanced", "shortcuts"] as const;

  beforeEach(async () => {
    b = installBrowser();
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    vi.resetModules();
    const session = await import("../session/index.ts");
    store = await import("../store/store.ts");
    ({ SettingsView } = await import("../../settings/Settings.tsx"));
    stop = session.connect();
    await until(() => store.getState().imageStatus !== undefined, 2000, "boot");
    await tick();
    store.setState({ settings: methodSamples["settings.get"].result });
  });
  afterEach(async () => {
    stop?.(); b.server.accepting = false;
    for (const socket of b.server.sockets) socket.close();
    await tick(); vi.unstubAllGlobals();
  });

  it("every button in Settings that has a tip names itself in one to three words", () => {
    const tips: string[] = [];
    for (const section of SECTIONS) {
      store.setState({ section });
      const html = renderToStaticMarkup(createElement(SettingsView));
      for (const [tag] of html.matchAll(/<button\b[^>]*\sdata-tip="[^"]*"[^>]*>/g)) {
        if (/\sdisabled=""/.test(tag)) continue;
        const tip = decode(/\sdata-tip="([^"]*)"/.exec(tag)?.[1] ?? "");
        tips.push(tip);
        expect(words(tip), `${section}: ${tip}`).toBeGreaterThanOrEqual(1);
        expect(words(tip), `${section}: ${tip}`).toBeLessThanOrEqual(3);
      }
    }
    expect(tips.length).toBeGreaterThan(5);
  });
});
