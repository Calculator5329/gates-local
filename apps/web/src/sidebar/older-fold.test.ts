// The owner 2026-11-20: Older folds out of the way, as a settled section does, and stays as he left it.
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { FakeDocument, FakeElement, FakeIFrame, type FakeNode } from "../../test/fake-dom.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const KEY = "gates-local.sidebar-older-open";
const doc = new FakeDocument();
const win = { document: doc, HTMLIFrameElement: FakeIFrame, addEventListener() {}, removeEventListener() {} };
const kept = new Map<string, string>();
let root: Root;
let store: typeof import("../lib/store/store.ts");
let Sidebar: typeof import("./Sidebar.tsx")["Sidebar"];

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
  vi.stubGlobal("localStorage", { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v); } });
  const { createRoot } = await import("react-dom/client");
  store = await import("../lib/store/store.ts");
  ({ Sidebar } = await import("./Sidebar.tsx"));
  root = createRoot(doc.body.appendChild(doc.createElement("div")) as unknown as Element);
});
afterAll(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
beforeEach(() => { kept.clear(); });
afterEach(() => { act(() => root.render(null)); });

const thread = (id: string, daysAgo: number) => ({ id, title: `Chat ${id}`, createdAt: 1, updatedAt: NOW - daysAgo * DAY });
const THREADS = [thread("today", 0), thread("week", 3), thread("old-1", 30), thread("old-2", 60), thread("old-3", 90)];

function all(pred: (el: FakeElement) => boolean, from: FakeNode = doc.body): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (n: FakeNode) => { for (const c of n.childNodes) if (c instanceof FakeElement) { if (pred(c)) out.push(c); walk(c); } };
  walk(from);
  return out;
}
const rows = () => all((el) => el.getAttribute("data-thread") !== null).map((el) => el.getAttribute("data-thread"));
const fold = () => all((el) => el.getAttribute("data-testid") === "sidebar.older.toggle")[0] ?? null;
const headings = () => all((el) => el.classList.includes("sb-group")).map((el) => el.textContent);
const press = (el: FakeElement | null) => {
  if (el === null) throw new Error("no fold button");
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$")) ?? "";
  act(() => { ((el as unknown as Record<string, { onClick: () => void }>)[key]!).onClick(); });
};
function mount(over: Partial<import("../lib/store/store.ts").State> = {}) {
  store.setState({ threads: THREADS, search: "", view: "new", threadId: null, turns: {}, ...over });
  act(() => root.render(createElement(Sidebar)));
}

it("Older starts folded: one line with how many threads it holds, and none of their rows", () => {
  mount();
  expect(rows()).toEqual(["today", "week"]);
  expect(headings()).toEqual(["Today", "Previous 7 days", "Older3"]);
  expect(fold()?.getAttribute("aria-expanded")).toBe("false");
  expect(fold()?.getAttribute("aria-label")).toBe("Older, 3 threads");
  expect(kept.size).toBe(0);
});

it("pressing Older shows its threads, pressing again folds them, and the list opens the way it was left", () => {
  mount();
  press(fold());
  expect(rows()).toEqual(["today", "week", "old-1", "old-2", "old-3"]);
  expect(fold()?.getAttribute("aria-expanded")).toBe("true");
  expect(kept.get(KEY)).toBe("1");
  act(() => root.render(null));
  mount();
  expect(rows()).toEqual(["today", "week", "old-1", "old-2", "old-3"]);
  press(fold());
  expect(rows()).toEqual(["today", "week"]);
  expect(kept.get(KEY)).toBe("0");
  act(() => root.render(null));
  mount();
  expect(rows()).toEqual(["today", "week"]);
});

it("a folded Older keeps the row of the open thread and of a thread with a reply under way", () => {
  mount({ view: "thread", threadId: "old-2" });
  expect(rows()).toEqual(["today", "week", "old-2"]);
  expect(fold()?.getAttribute("aria-label")).toBe("Older, 3 threads");
  act(() => store.setState({ view: "new", threadId: null, turns: { "old-3": { threadId: "old-3", startedAt: NOW, text: "", thinking: "", tools: [] } } as never }));
  expect(rows()).toEqual(["today", "week", "old-3"]);
});

it("one older thread is counted as one thread, and a search looks through a folded Older", () => {
  mount({ threads: [thread("today", 0), thread("old-1", 30)] });
  expect(fold()?.getAttribute("aria-label")).toBe("Older, 1 thread");
  act(() => store.setState({ search: "old" }));
  expect(rows()).toEqual(["old-1"]);
  expect(fold()).toBeNull();
});
