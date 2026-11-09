import { afterEach, expect, it, vi } from "vitest";
import { keepSheetFocus } from "./sheet-focus.ts";

afterEach(() => vi.unstubAllGlobals());

it("keeps focus in the modal when a fit result replaces the focused model button", () => {
  const body = {};
  const doc = { activeElement: body };
  const close = { focus: () => { doc.activeElement = close; } };
  const model = {};
  let children: object[] = [close, model];
  const sheet = {
    contains: (node: unknown) => children.includes(node as object),
    querySelector: () => close,
  };
  let changed = vi.fn<() => void>();
  const disconnect = vi.fn();
  vi.stubGlobal("document", doc);
  vi.stubGlobal("MutationObserver", class {
    constructor(callback: () => void) { changed = vi.fn(callback); }
    observe() {}
    disconnect = disconnect;
  });
  const stop = keepSheetFocus(sheet as unknown as HTMLElement);
  expect(doc.activeElement).toBe(close);
  // Tab 10 lands on a model; a delayed fit replaces its button with a refused row.
  doc.activeElement = model;
  children = [close];
  doc.activeElement = body;
  changed();
  expect(sheet.contains(doc.activeElement), "removing a focused row must not leave focus on body").toBe(true);
  // An update that leaves a control focused must not steal it.
  children = [close, model];
  doc.activeElement = model;
  changed();
  expect(doc.activeElement).toBe(model);
  stop();
  expect(disconnect).toHaveBeenCalledOnce();
});
