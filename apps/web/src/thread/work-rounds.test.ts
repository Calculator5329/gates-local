import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import type { Message, ToolStep } from "@gates-local/contracts";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { FakeDocument, FakeElement, FakeIFrame } from "../../test/fake-dom.ts";

vi.mock("../lib/session/index.ts", () => ({ cancelImage: vi.fn(), retryImage: vi.fn(), reloadThread: vi.fn(), retry: vi.fn(), fileUrl: () => "/f", loadEarlier: vi.fn(async () => false), earlierOf: () => 0, onEarlier: () => () => undefined }));

const T = "t";
const user: Message = { id: "u", threadId: T, role: "user", createdAt: 1, content: "Check my notes" };
const call: ToolStep = { callId: "a", name: "shell", state: "done", summary: "Searching your library", durationMs: 4000 };
const reply: Message = {
  id: "a", threadId: T, role: "assistant", createdAt: 2, content: "Done.", thinking: "Look first. Then more.", tools: [call], model: "m",
  stats: { completionTokens: 140, evalDurationMs: 10_000 },
  times: { startedAt: 0, workMs: 8800, spans: [{ from: 0, ms: 2000 }, { from: 15, ms: 2800 }], callsAt: { a: 11 }, ended: { reason: "done", at: 11_000 } },
};

const doc = new FakeDocument();
const copied: string[] = [];
let root: Root;
let store: typeof import("../lib/store/store.ts");
let Timeline: typeof import("./Thread.tsx")["Timeline"];

beforeAll(async () => {
  const win = { document: doc, HTMLIFrameElement: FakeIFrame, addEventListener() {}, removeEventListener() {} };
  doc.defaultView = win;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("navigator", { userAgent: "", clipboard: { writeText: (text: string) => { copied.push(text); return Promise.resolve(); } } });
  vi.stubGlobal("requestIdleCallback", () => 1);
  vi.stubGlobal("cancelIdleCallback", () => {});
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const { createRoot } = await import("react-dom/client");
  store = await import("../lib/store/store.ts");
  ({ Timeline } = await import("./Thread.tsx"));
  root = createRoot(doc.body.appendChild(doc.createElement("div")) as unknown as Element);
});
afterAll(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
afterEach(() => { act(() => root.render(null)); vi.useRealTimers(); copied.length = 0; });

function mount(): void {
  act(() => store.setState({ messages: { [T]: [user, reply] }, turns: {} }));
  act(() => root.render(createElement(Timeline, { threadId: T })));
}
const one = (selector: string): FakeElement => {
  const el = doc.body.querySelector(selector);
  if (el === null) throw new Error(`no ${selector}`);
  return el;
};
const props = (el: FakeElement): Record<string, unknown> => {
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  return (key === undefined ? {} : (el as unknown as Record<string, Record<string, unknown>>)[key]) ?? {};
};
const click = async (el: FakeElement) => {
  await act(async () => {
    (props(el)["onClick"] as (e: unknown) => void)({ target: el, currentTarget: el });
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
};
function iconOf(el: FakeElement): string | null | undefined {
  for (const c of el.childNodes) {
    if (!(c instanceof FakeElement)) continue;
    if (c.nodeName === "use") return c.getAttribute("href");
    const inner = iconOf(c);
    if (inner !== undefined) return inner;
  }
  return undefined;
}
const rounds = () => doc.body.querySelectorAll('[data-testid="chat.fold.thinking"]');
async function styles(): Promise<string> {
  const { readFileSync } = await import("node:fs");
  return readFileSync(new URL("../app/styles.css", import.meta.url), "utf8");
}
function mediaBody(css: string, query: string): string {
  let out = "";
  for (let at = css.indexOf(`@media ${query}{`); at >= 0; at = css.indexOf(`@media ${query}{`, at + 1)) {
    let depth = 0;
    const open = css.indexOf("{", at);
    for (let i = open; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) { out += `${css.slice(open + 1, i)}\n`; break; }
    }
  }
  return out;
}
const lines = (css: string) => css.split("\n").map((l) => l.trim());

it("Copy turns into the check mark and says Copied for a little over a second, then is Copy again", async () => {
  mount();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const copy = one('[data-testid="chat.copy.reply"]');
  expect(iconOf(copy)).toBe("#i-copy");
  await click(copy);
  expect(copied).toEqual(["Done."]);
  expect(iconOf(copy)).toBe("#i-check");
  expect(copy.getAttribute("data-tip")).toBe("Copied");
  await act(async () => { vi.advanceTimersByTime(1199); });
  expect(iconOf(copy), "still the check mark just before 1.2 s").toBe("#i-check");
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(iconOf(copy)).toBe("#i-copy");
  expect(copy.getAttribute("data-tip")).toBe("Copy");
});

it("on a touch screen the model and speed wait behind the Reply details tap, so the row is one line of icons until it is pressed", async () => {
  mount();
  const row = one(".a-act");
  const details = one('[data-testid="chat.reply.details"]');
  expect(details.getAttribute("aria-expanded")).toBe("false");
  expect(row.classList).not.toContain("det");
  expect(one(".a-act .meta").textContent).toBe("8.8 s · 14 tok/s");
  await click(details);
  expect(details.getAttribute("aria-expanded")).toBe("true");
  expect(row.classList).toContain("det");
  await click(details);
  expect(details.getAttribute("aria-expanded")).toBe("false");
  expect(row.classList).not.toContain("det");
  const css = await styles();
  expect(css).toMatch(/(?:^|\n)[^\n{]*\.a-det,[^\n{]*\{display:none\}/);
  const touch = lines(mediaBody(css, "(hover:none)"));
  expect(touch).toEqual(expect.arrayContaining([".a-det{display:inline-flex}", ".a-act .meta{display:none}", ".a-act.det .meta{display:block}"]));
});

it("a thinking round the next step closed shows the bulb and its seconds, and a click opens it again and closes it again", async () => {
  mount();
  await click(one('[data-testid="chat.fold.toggle"]'));
  const [first, last] = rounds();
  if (first === undefined || last === undefined) throw new Error("two rounds");
  expect(first.getAttribute("aria-expanded")).toBe("false");
  expect(iconOf(first)).toBe("#i-bulb");
  expect(first.querySelector(".wr-h")?.textContent).toBe("2 s");
  expect(last.getAttribute("aria-expanded"), "the newest round is open").toBe("true");
  await click(first);
  expect(first.getAttribute("aria-expanded")).toBe("true");
  await click(first);
  expect(first.getAttribute("aria-expanded")).toBe("false");
  await click(first);
  expect(first.getAttribute("aria-expanded")).toBe("true");
  expect(last.getAttribute("aria-expanded"), "the other round stays as left").toBe("true");
});
