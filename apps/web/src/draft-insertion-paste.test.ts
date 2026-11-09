import { expect, it, vi } from "vitest";
import { insertAtCursor } from "./draft-insertion.ts";

it("paste replaces its captured selection while voice keeps selected words", () => {
  const doc = { activeElement: null as unknown, execCommand: vi.fn(() => true) };
  const ta = { selectionStart: 3, ownerDocument: doc, blur() {}, focus() { doc.activeElement = ta; }, setSelectionRange: vi.fn() };
  expect(insertAtCursor(ta as unknown as HTMLTextAreaElement, "pasted", { start: 3, end: 8 })).toBe(true);
  expect(ta.setSelectionRange).toHaveBeenLastCalledWith(3, 8);
  expect(insertAtCursor(ta as unknown as HTMLTextAreaElement, "spoken")).toBe(true);
  expect(ta.setSelectionRange).toHaveBeenLastCalledWith(3, 3);
});
