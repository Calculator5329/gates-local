// The kit's box watcher: a scroll box's edges are read again when it scrolls, resizes or its content changes.
import { afterEach, expect, it, vi } from "vitest";
import { observeBox } from "./events.ts";

afterEach(() => vi.unstubAllGlobals());

function watchers() {
  const made: { kind: string; seen: unknown[]; call: () => void; off: boolean }[] = [];
  const kind = (name: string) => class {
    entry: { kind: string; seen: unknown[]; call: () => void; off: boolean };
    constructor(call: () => void) { this.entry = { kind: name, seen: [], call, off: false }; made.push(this.entry); }
    observe(target: unknown) { this.entry.seen.push(target); }
    disconnect() { this.entry.off = true; }
  };
  vi.stubGlobal("ResizeObserver", kind("size"));
  vi.stubGlobal("MutationObserver", kind("content"));
  return made;
}

it("a watched box is read at once and again on scroll, resize and content change, and nothing after it is let go", () => {
  const made = watchers();
  const el = new EventTarget() as unknown as HTMLElement;
  const also = {} as Element;
  const changed = vi.fn();
  const off = observeBox(el, changed, { also: [also], content: true });
  expect(changed).toHaveBeenCalledTimes(1);
  el.dispatchEvent(new Event("scroll"));
  expect(changed).toHaveBeenCalledTimes(2);
  const size = made.find((m) => m.kind === "size")!;
  const content = made.find((m) => m.kind === "content")!;
  expect(size.seen).toEqual([el, also]);
  expect(content.seen).toEqual([el]);
  size.call();
  content.call();
  expect(changed).toHaveBeenCalledTimes(4);
  off();
  expect([size.off, content.off]).toEqual([true, true]);
  el.dispatchEvent(new Event("scroll"));
  expect(changed).toHaveBeenCalledTimes(4);
});

it("a box watched without content takes no content watcher", () => {
  const made = watchers();
  observeBox(new EventTarget() as unknown as HTMLElement, vi.fn())();
  expect(made.map((m) => m.kind)).toEqual(["size"]);
});
