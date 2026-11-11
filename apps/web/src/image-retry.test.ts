import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setState } from "./store.ts";
import type { State } from "./store.ts";
import type { Message } from "@gates-local/contracts";

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

/**
 * One request, one box: a retry is a card message of its own, but it shows in the
 * box of the card it retries. The thread as the server saves it is what a reload
 * renders, so each state here is also the state after a reload.
 */
describe("a retry takes over its failed card's box", () => {
  const choice = { preset: "sdxl-lightning", width: 768, height: 512 };
  const base = { threadId: "thread", role: "assistant" as const, createdAt: 1, content: "a tree" };
  const refused = "The image needs 9.0 GB and 6.0 GB is free; a chat model this app did not load holds 7.0 GB, stop it or pick a smaller size.";
  const first = { ...base, id: "failed", imageJob: { jobId: "failed", threadId: "thread", state: "error" as const, errorKind: "wont-fit", message: refused, retryJobId: "retry", choice } };
  type Job = NonNullable<Message["imageJob"]>;
  async function render(retry: Partial<Job> | undefined, again?: Partial<Job>) {
    vi.stubGlobal("window", {});
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const { Timeline } = await import("./Thread.tsx");
    const messages: Message[] = [
      { ...base, id: "user", role: "user" },
      retry === undefined ? { ...first, imageJob: { ...first.imageJob, retryJobId: undefined } } : first,
      ...retry === undefined ? [] : [{ ...base, id: "retry", createdAt: 2, imageJob: { jobId: "retry", threadId: "thread", state: "queued", choice, ...retry, ...(again ? { retryJobId: "again" } : {}) } as Job }],
      ...again === undefined ? [] : [{ ...base, id: "again", createdAt: 3, imageJob: { jobId: "again", threadId: "thread", state: "queued", choice, ...again } as Job }],
    ];
    setState({ threadId: "thread", serverOrigin: "http://server", messages: { thread: messages } });
    const html = renderToStaticMarkup(createElement(Timeline, { threadId: "thread" }));
    const boxes = html.match(/<div class="image-job"[^>]*>/g) ?? [];
    return { html, boxes };
  }
  // the failed card alone: its box at the picture's size, its reason, Try again
  const size = 'style="aspect-ratio:768 / 512;width:768px"';

  it("a failed card with no retry keeps its box and says why", async () => {
    const { html, boxes } = await render(undefined);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toContain(size);
    expect(html).toContain(refused);
    expect(html).toContain(">Try again</button>");
  });

  it.each([
    [{ state: "queued" }, "Waiting for the GPU"],
    [{ state: "running", progress: 0, phase: "freeing" }, "Freeing memory"],
    [{ state: "running", progress: 0.4 }, "Making image · 40%"],
  ] as const)("while the retry is %o the one box says %s, not the old reason", async (retry, words) => {
    const { html, boxes } = await render(retry);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toContain(size);
    expect(html).toContain(`<p>${words}</p>`);
    expect(html).toContain(">Cancel image</button>");
    expect(html).not.toContain(refused);
  });

  it("when the retry is done the one box holds the picture, with no error beside it", async () => {
    const { html, boxes } = await render({ state: "done", imagePath: "images/tree.png" });
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toContain(size);
    expect(html).toContain('alt="Generated image"');
    expect(html).not.toContain(refused);
    expect(html).not.toContain("Image ready");
    expect(html).not.toContain('role="status"');
  });

  it("when the retry fails the one box says the new reason and offers Try again; a second retry reuses it too", async () => {
    const failed = await render({ state: "error", message: "ComfyUI stopped before the image finished." });
    expect(failed.boxes).toHaveLength(1);
    expect(failed.html).toContain("ComfyUI stopped before the image finished.");
    expect(failed.html).toContain(">Try again</button>");
    expect(failed.html).not.toContain(refused);
    const again = await render({ state: "error", message: "ComfyUI stopped before the image finished." }, { state: "done", imagePath: "images/tree.png" });
    expect(again.boxes).toHaveLength(1);
    expect(again.html).toContain('alt="Generated image"');
    expect(again.html).not.toContain("ComfyUI stopped");
  });

  it("a retry that runs another size (a default settled to other files) keeps the first card's box, running and done", async () => {
    const square = { preset: "flux2-klein-4b", width: 1024, height: 1024 };
    for (const state of [{ state: "running", progress: 0.4 }, { state: "done", imagePath: "images/tree.png" }] as Partial<Job>[]) {
      const { boxes } = await render({ ...state, choice: square });
      expect(boxes).toHaveLength(1);
      expect(boxes[0]).toContain(size);
    }
  });
});

// A card sent with the square default whose job settled to SDXL 768×512 (Klein's files absent):
// the box is the shape first drawn, waiting, running and done, the picture fitted inside.
it.each([{ state: "queued" }, { state: "running", progress: 0.4 }, { state: "done", imagePath: "images/tree.png" }] as const)("a card whose job settles to another shape keeps its first box (%o)", async (state) => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const { Timeline } = await import("./Thread.tsx");
  const sent = { preset: "flux2-klein-4b", width: 1024, height: 1024 };
  const settled = { preset: "sdxl-lightning", width: 768, height: 512 };
  setState({ threadId: "thread", serverOrigin: "http://server", messages: { thread: [
    { id: "user", threadId: "thread", role: "user", createdAt: 1, content: "a tree" },
    { id: "job", threadId: "thread", role: "assistant", createdAt: 2, content: "a tree", imageJob: { jobId: "job", threadId: "thread", ...state, choice: settled, sent } },
  ] } });
  const boxes = renderToStaticMarkup(createElement(Timeline, { threadId: "thread" })).match(/<div class="image-job"[^>]*>/g) ?? [];
  expect(boxes).toHaveLength(1);
  expect(boxes[0]).toContain('style="aspect-ratio:1024 / 1024;width:1024px"');
});

describe("chainEnd", () => {
  it("follows an accepted retry the thread has not caught up with as waiting, and stops on a loop", async () => {
    const { chainEnd } = await import("./Thread.tsx");
    const job = { jobId: "a", state: "error" as const };
    expect(chainEnd(job, [], { from: "a", to: "b" })).toEqual({ jobId: "b", state: "queued" });
    const loop = [{ id: "b", threadId: "t", role: "assistant" as const, createdAt: 1, content: "", imageJob: { jobId: "b", state: "error" as const, retryJobId: "a" } }];
    expect(chainEnd({ ...job, retryJobId: "b" }, loop).jobId).toBe("b");
  });
});
