// A long thread opens as a window of its latest turns (chat row 40, owner pick A,
// 2026-11-13): a button at the top says how many earlier turns one press adds and
// how many there are; a thread that fits in the window has no button. The press
// itself, and the turn in view holding still, are browser checks (long-thread.spec.ts).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Message } from "@gates-local/contracts";
import { setState, type State } from "./store.ts";

vi.mock("./store.ts", async (original) => {
  const actual = await original<typeof import("./store.ts")>();
  return { ...actual, useStore: <T,>(selector: (s: State) => T) => selector(actual.getState()) };
});
vi.mock("./session.ts", () => ({ cancelImage: vi.fn(), retryImage: vi.fn(), reloadThread: vi.fn(), retry: vi.fn(), fileUrl: () => "/f" }));
beforeEach(() => { vi.stubGlobal("matchMedia", () => ({ matches: true })); vi.stubGlobal("window", {}); });
afterEach(() => { setState({ turns: {}, messages: {}, threadId: null }); vi.unstubAllGlobals(); });

const T = "t";
/** A saved thread of `n` messages, question and answer in turn. */
const thread = (n: number): Message[] => Array.from({ length: n }, (_, i) => i % 2 === 0
  ? { id: `u${i}`, threadId: T, role: "user", createdAt: i, content: `Question ${i / 2 + 1}` }
  : { id: `a${i}`, threadId: T, role: "assistant", createdAt: i, content: "An answer." });

async function render(n: number): Promise<string> {
  const { Timeline } = await import("./Thread.tsx");
  setState({ threadId: T, turns: {}, messages: { [T]: thread(n) } });
  return renderToStaticMarkup(createElement(Timeline, { threadId: T }));
}

/** The button's arrow and number, and its tip; undefined when there is no button. */
const button = (html: string) => {
  const m = /<button[^>]*data-testid="chat.thread.earlier"[^>]*data-tip="([^"]*)"[^>]*>([\s\S]*?)<\/button>/.exec(html);
  return m === null ? undefined : { arrow: m[2]?.includes("#i-up") === true, says: m[2]?.replace(/<[^>]+>/g, ""), tip: m[1] };
};

// decision 5: the arrow and the number the press adds; how many there are is in the tip
it("a 2,000-message thread opens with a button for the 200 before its window, of the 1,800 there are", async () => {
  expect(button(await render(2000))).toEqual({ arrow: true, says: "200", tip: "1,800 earlier" });
});

it("fewer earlier turns than a press adds says how many there are", async () => {
  expect(button(await render(260))).toEqual({ arrow: true, says: "60", tip: "60 earlier" });
});

it("a thread that fits in the window has no button", async () => {
  expect(button(await render(200))).toBeUndefined();
});
