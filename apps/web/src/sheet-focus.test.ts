import { afterEach, expect, it, vi } from "vitest";
import { keepSheetFocus } from "./sheet-focus.ts";

afterEach(() => vi.unstubAllGlobals());

it.each([
  ["legacy sheet", ".sh-h .ibtn", true, false],
  ["picker model step", ".pk-close", true, false],
  ["picker context step", ".pk-back", false, true],
] as const)("PL-02: restores focus to a visible control on the %s", (_name, expected, closeVisible, backVisible) => {
  const body = {};
  const doc = { activeElement: body };
  const control = (selector: string, visible: boolean) => ({
    selector,
    getClientRects: () => visible ? [{}] : [],
    focus() { if (visible) doc.activeElement = this; },
  });
  const buttons = expected === ".sh-h .ibtn" ? [control(expected, true)] : [control(".pk-close", closeVisible), control(".pk-back", backVisible)];
  const close = buttons.find(button => button.selector === expected)!;
  const model = {};
  let children: object[] = [...buttons, model];
  const sheet = {
    contains: (node: unknown) => children.includes(node as object),
    querySelector: (selector: string) => buttons.find(button => button.selector === selector) ?? null,
    querySelectorAll: (selector: string) => buttons.filter(button => selector.split(",").map(s => s.trim()).includes(button.selector)),
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
  doc.activeElement = model;
  children = [...buttons];
  doc.activeElement = body;
  changed();
  expect(doc.activeElement, "removing a focused control must return to a visible control").toBe(close);
  children.push(model);
  doc.activeElement = model;
  changed();
  expect(doc.activeElement).toBe(model);
  stop();
  expect(disconnect).toHaveBeenCalledOnce();
});
