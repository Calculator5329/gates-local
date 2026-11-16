// A screen's code is fetched and listened for only while the screen is needed, and a fetch that
// fails offers a reload; mounted for real (react-dom on the fake DOM).
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { FakeDocument, FakeElement, FakeIFrame } from "../../test/fake-dom.ts";
import { deferred } from "../lib/session/deferred.ts";

const doc = new FakeDocument();
const reload = vi.fn();
let root: Root;
let screens: typeof import("./screens.tsx");

beforeAll(async () => {
  Object.assign(doc, { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { document: doc, HTMLIFrameElement: FakeIFrame, addEventListener() {}, removeEventListener() {} });
  doc.defaultView = window;
  vi.stubGlobal("document", doc);
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("location", { reload });
  const { createRoot } = await import("react-dom/client");
  screens = await import("./screens.tsx");
  root = createRoot(doc.body.appendChild(doc.createElement("div")) as unknown as Element);
});
afterAll(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });

const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

it("a screen not needed is neither fetched nor listened for, so its code landing redraws nothing; once needed it is both", async () => {
  let land!: (v: string) => void;
  const fetch = vi.fn(() => new Promise<string>((r) => { land = r; }));
  const screen = deferred(fetch);
  const subscribe = vi.spyOn(screen, "subscribe");
  let renders = 0;
  const Probe = ({ needed }: { needed: boolean }) => {
    renders++;
    return createElement("i", { "data-kind": screens.useScreen(screen, needed).kind });
  };
  act(() => root.render(createElement(Probe, { needed: false })));
  await settle();
  expect(fetch).not.toHaveBeenCalled();
  expect(subscribe).not.toHaveBeenCalled();
  act(() => root.render(createElement(Probe, { needed: true })));
  await settle();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(subscribe).toHaveBeenCalled();
  const before = renders;
  await act(async () => { land("code"); });
  await settle();
  expect(renders).toBe(before + 1);
  act(() => root.render(null));
});

it("a screen whose code will not load says the app may have updated, and its Reload reloads the page", async () => {
  act(() => root.render(createElement(screens.ScreenError)));
  const alert = doc.body.querySelector('[role="alert"]');
  expect(alert?.textContent).toBe("This page couldn't load. The app may have updated.  Reload");
  const button = doc.body.querySelector('[data-testid="ui.screen-error.reload"]');
  const key = Object.keys(button ?? {}).find((k) => k.startsWith("__reactProps$"));
  act(() => { ((button as unknown as Record<string, { onClick: () => void }>)[key ?? ""])?.onClick(); });
  expect(reload).toHaveBeenCalledTimes(1);
  act(() => root.render(null));
});
