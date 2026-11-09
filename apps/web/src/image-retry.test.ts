import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setState } from "./store.ts";
import type { State } from "./store.ts";

vi.mock("./store.ts", async (original) => {
  const actual = await original<typeof import("./store.ts")>();
  return { ...actual, useStore: <T,>(selector: (s: State) => T) => selector(actual.getState()) };
});
vi.mock("./session.ts", () => ({ cancelImage: vi.fn(), retryImage: vi.fn(), reloadThread: vi.fn(), retry: vi.fn(), fileUrl: () => "/files/image.png" }));
afterEach(() => { setState({ messages: {}, threadId: null, turns: {}, imageStatus: undefined }); vi.unstubAllGlobals(); });

it("names image generation while a chat is waiting to be admitted behind it", async () => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const { Timeline } = await import("./Thread.tsx");
  setState({ threadId: "chat", turns: { chat: { gen: 1, threadId: "chat", turnId: null, model: "tiny-chat:2k", startedAt: Date.now(), thinking: "", text: "", tools: [], pendingUser: "hello" } },
    imageStatus: { state: "busy", owner: "external" } });
  expect(renderToStaticMarkup(createElement(Timeline, { threadId: "chat" }))).toContain("Waiting for image generation");
});

describe("an image retry button follows the accepted job", () => {
  it.each(["queued", "running", "done", "error", "cancelled"] as const)("keeps the original button disabled when the retry is %s", async (state) => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const { Timeline } = await import("./Thread.tsx");
    const base = { threadId: "thread", role: "assistant" as const, createdAt: 1, content: "a tree" };
    setState({ threadId: "thread", messages: { thread: [
      { ...base, id: "failed", imageJob: { jobId: "failed", threadId: "thread", state: "error", retryJobId: "retry" } },
      { ...base, id: "retry", imageJob: { jobId: "retry", threadId: "thread", state } },
    ] } });
    const html = renderToStaticMarkup(createElement(Timeline, { threadId: "thread" }));
    const first = html.slice(0, html.indexOf('data-image-job=', html.indexOf('data-image-job=') + 1));
    const labels = { queued: "Retry queued", running: "Retrying", done: "Image ready", error: "Retry failed", cancelled: "Retry cancelled" };
    expect(first).toContain(labels[state]);
    expect(first).toContain('disabled=""');
  });
});
