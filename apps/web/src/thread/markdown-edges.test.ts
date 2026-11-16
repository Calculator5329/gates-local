import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { FakeDocument, FakeElement, FakeIFrame } from "../../test/fake-dom.ts";

const box = { left: 0, scroll: 800, client: 300, reads: 0 };
const observed = new Set<() => void>();
let screenWidth = 390;

class MeasuredDocument extends FakeDocument {
  override createElement(tag: string): FakeElement {
    const el = super.createElement(tag);
    Object.defineProperties(el, {
      scrollLeft: { get: () => { box.reads++; return box.left; } },
      scrollWidth: { get: () => { box.reads++; return box.scroll; } },
      clientWidth: { get: () => { box.reads++; return box.client; } },
    });
    return el;
  }
}

class FakeResizeObserver {
  readonly #seen: () => void;
  constructor(seen: () => void) { this.#seen = seen; }
  observe(): void { observed.add(this.#seen); }
  disconnect(): void { observed.delete(this.#seen); }
}

const matchWidth = (query: string) => {
  const max = /\(max-width:\s*(\d+)px\)/.exec(query);
  return { matches: max !== null && screenWidth <= Number(max[1]), addEventListener() {}, removeEventListener() {} };
};

const doc = new MeasuredDocument();
const win = { document: doc, HTMLIFrameElement: FakeIFrame, matchMedia: matchWidth, addEventListener() {}, removeEventListener() {} };
let root: Root;
let Markdown: typeof import("./markdown.tsx")["Markdown"];

const CODE = "```sh\necho a-very-long-line-that-scrolls-sideways\n```";
const TABLE = "| Model | Size |\n| --- | --- |\n| Small | 2 |";
const more = (tag: string) => doc.querySelector(tag)?.dataset.more;
const resized = () => act(() => { for (const seen of observed) seen(); });

beforeAll(async () => {
  doc.defaultView = win;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("matchMedia", matchWidth);
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" });
  const { createRoot } = await import("react-dom/client");
  ({ Markdown } = await import("./markdown.tsx"));
  root = createRoot(doc.body.appendChild(doc.createElement("div")) as unknown as Element);
});
afterAll(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
beforeEach(() => { Object.assign(box, { left: 0, scroll: 800, client: 300, reads: 0 }); screenWidth = 390; });
afterEach(() => { act(() => root.render(null)); });

it("a code block or table that scrolls sideways marks the sides that have more to show, and no side once it fits", () => {
  act(() => root.render(createElement(Markdown, { text: `${CODE}\n\n${TABLE}` })));
  resized();
  expect(more("pre")).toBe("end");
  expect(more("table")).toBe("end");
  box.left = 200;
  resized();
  expect(more("pre")).toBe("start end");
  expect(more("table")).toBe("start end");
  box.left = 499;
  resized();
  expect(more("pre")).toBe("start");
  box.scroll = 300;
  box.left = 0;
  resized();
  expect(more("pre")).toBeUndefined();
  expect(more("table")).toBeUndefined();
});

it("edge marks apply only below 1024 px wide, and only from the size observer, never read as the block mounts", () => {
  screenWidth = 1023;
  act(() => root.render(createElement(Markdown, { text: CODE })));
  expect(box.reads, "nothing measured while mounting").toBe(0);
  expect(more("pre")).toBeUndefined();
  resized();
  expect(more("pre")).toBe("end");
  act(() => root.render(null));
  screenWidth = 1024;
  act(() => root.render(createElement(Markdown, { text: CODE })));
  expect(observed.size).toBe(0);
  resized();
  expect(more("pre")).toBeUndefined();
});
