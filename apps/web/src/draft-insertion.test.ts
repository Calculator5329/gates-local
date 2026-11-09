import { expect, it, vi } from "vitest";
import { insertAtCursor } from "./draft-insertion.ts";

it("VC-02: an inert textarea must not insert into the search field that retains focus", () => {
  const search = { value: "thread search" };
  const document = { activeElement: search, execCommand: vi.fn(() => { search.value += "wrong speech"; return true; }) };
  const textarea = { selectionStart: 0, ownerDocument: document, blur() {}, focus() {}, setSelectionRange() {} } as unknown as HTMLTextAreaElement;
  expect(insertAtCursor(textarea, "wrong speech")).toBe(false);
  expect(document.execCommand).not.toHaveBeenCalled();
  expect(search.value).toBe("thread search");
});

it("a usable textarea gets an undoable edit at the selection start", () => {
  const document = { activeElement: null as unknown, execCommand: vi.fn(() => true) };
  const textarea = { selectionStart: 3, ownerDocument: document, blur() {}, focus() { document.activeElement = textarea; }, setSelectionRange: vi.fn() };
  expect(insertAtCursor(textarea as unknown as HTMLTextAreaElement, "words")).toBe(true);
  expect(textarea.setSelectionRange).toHaveBeenCalledWith(3, 3);
  expect(document.execCommand).toHaveBeenCalledWith("insertText", false, "words");
});
