// A drag that carries no files (a link a page offers, some text) is refused
// anywhere a person could not type, so the window never follows a dropped link.
import { beforeAll, expect, it, vi } from "vitest";

type Handler = (e: unknown) => void;
const handlers = new Map<string, Handler>();
let refusesDrop: (target: EventTarget | null) => boolean;

beforeAll(async () => {
  vi.stubGlobal("window", { addEventListener: (name: string, fn: Handler) => { handlers.set(name, fn); }, innerWidth: 1280, innerHeight: 800 });
  ({ refusesDrop } = await import("./file-drop.tsx"));
});

/** A drop target whose nearest field is `f`. */
const field = (f: object) => ({ closest: () => f }) as unknown as EventTarget;
const el = (editable: boolean) => ({ closest: () => (editable ? {} : null) }) as unknown as EventTarget;
function drag(types: string[], target: EventTarget | null) {
  const dataTransfer = { types, dropEffect: "copy" };
  const e = { dataTransfer, target, relatedTarget: null, preventDefault: vi.fn() };
  return e;
}

it("a link dragged onto the window is refused on dragover and on drop", () => {
  for (const name of ["dragenter", "dragover", "drop"]) {
    const e = drag(["text/uri-list", "text/plain"], el(false));
    handlers.get(name)!(e);
    expect(e.preventDefault, name).toHaveBeenCalledTimes(1);
    expect(e.dataTransfer.dropEffect, name).toBe("none");
  }
});

it("text or a link dragged into a field the person types in is left to the field", () => {
  for (const name of ["dragover", "drop"]) {
    const e = drag(["text/plain"], el(true));
    handlers.get(name)!(e);
    expect(e.preventDefault, name).not.toHaveBeenCalled();
    expect(e.dataTransfer.dropEffect, name).toBe("copy");
  }
});

it("a drag that began in this window is left alone", () => {
  handlers.get("dragstart")!({});
  const over = drag(["text/uri-list"], el(false));
  handlers.get("dragover")!(over);
  expect(over.preventDefault).not.toHaveBeenCalled();
  const drop = drag(["text/uri-list"], el(false));
  handlers.get("drop")!(drop);
  expect(drop.preventDefault).not.toHaveBeenCalled();
  handlers.get("dragend")!({});
});

/** Files from outside the window, dragged over a spot that takes no typing. */
const files = () => drag(["Files"], el(false));

it("files over the window put the marker above a usable composer, and leaving the window takes it down", async () => {
  const { getState, setState } = await import("../lib/store/store.ts");
  const composer = { getBoundingClientRect: () => ({ left: 100, width: 400, top: 600 }), closest: () => null };
  vi.stubGlobal("document", { querySelector: (s: string) => (s === ".composer" ? composer : null) });
  handlers.get("dragover")!(files());
  expect(getState().dropAt).toEqual({ x: 300, y: 300 });
  const published = getState();
  handlers.get("dragover")!(files());
  expect(getState(), "the same place again changes nothing").toBe(published);
  handlers.get("dragleave")!(files());
  expect(getState().dropAt).toBeNull();
  // an open popover owns the window: no marker, and the drop is refused
  setState({ pop: { id: "plus", kb: false } });
  const over = files();
  handlers.get("dragover")!(over);
  expect(getState().dropAt).toBeNull();
  expect(over.dataTransfer.dropEffect).toBe("none");
  setState({ pop: null });
  // no composer on screen: the same
  vi.stubGlobal("document", { querySelector: () => null });
  handlers.get("dragover")!(files());
  expect(getState().dropAt).toBeNull();
});

it("a target with no element under it is refused", () => {
  expect(refusesDrop(null)).toBe(true);
  expect(refusesDrop({} as EventTarget)).toBe(true);
});

it("a field that takes no typing is refused: a checkbox, a slider, a button, a disabled or read-only field", () => {
  for (const type of ["checkbox", "radio", "range", "button", "submit", "file", "color", "date"]) expect(refusesDrop(field({ tagName: "INPUT", type })), type).toBe(true);
  expect(refusesDrop(field({ tagName: "TEXTAREA", disabled: true }))).toBe(true);
  expect(refusesDrop(field({ tagName: "INPUT", type: "text", readOnly: true }))).toBe(true);
  for (const type of ["text", "search", "url", "TEXT", ""]) expect(refusesDrop(field({ tagName: "INPUT", type })), type).toBe(false);
  expect(refusesDrop(field({ tagName: "TEXTAREA" }))).toBe(false);
  expect(refusesDrop(field({ tagName: "DIV" }))).toBe(false);
});
