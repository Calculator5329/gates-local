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

// Send answers at once, so a waiting turn has its id long before its start: the start is what ends the wait.
describe("a chat sent while a picture renders", () => {
  const waiting = { gen: 1, threadId: "chat", turnId: "turn-1", model: "tiny-chat:2k", startedAt: Date.now(), thinking: "", text: "", tools: [], pendingUser: "hello" };
  async function line(turn: typeof waiting | (Omit<typeof waiting, "pendingUser"> & { pendingUser: null; userMessageId: string })) {
    vi.stubGlobal("window", {});
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const { Timeline } = await import("./Thread.tsx");
    setState({ threadId: "chat", turns: { chat: turn }, imageStatus: { state: "busy", owner: "external" } });
    return renderToStaticMarkup(createElement(Timeline, { threadId: "chat" }));
  }

  it("names image generation once the server has answered the send, until the turn starts", async () => {
    const html = await line(waiting);
    expect(html).toContain("Waiting for image generation");
    expect(html).not.toContain("Waiting for Ollama");
  });

  it("names Ollama once the turn has started, whatever the image engine is doing", async () => {
    const html = await line({ ...waiting, pendingUser: null, userMessageId: "saved" });
    expect(html).toContain("Waiting for Ollama");
    expect(html).not.toContain("Waiting for image generation");
  });
});

/**
 * One request, one box: a retry is a card message of its own, but it shows in the
 * box of the card it retries. The thread as the server saves it is what a reload
 * renders, so each state here is also the state after a reload.
 */
describe("a retry takes over its failed card's box", () => {
  const choice = { preset: "z-image-int8", width: 1024, height: 768 };
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
  const size = 'style="aspect-ratio:1024 / 768;width:1024px"';

  it("a failed card with no retry keeps its box and says why", async () => {
    const { html, boxes } = await render(undefined);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toContain(size);
    expect(html).toContain(refused);
    expect(html).toContain(">Try again</button>");
  });

  it.each([
    [{ state: "queued" }, "Waiting for the GPU", "<p>Waiting for the GPU</p>"],
    [{ state: "running", progress: 0, phase: "freeing" }, "Freeing memory", "<p>Freeing memory</p>"],
    // running, the spinner says it: on screen only the percent and the seconds since it was asked for
    [{ state: "running", progress: 0.4 }, "Making image · 40%", '<p aria-hidden="true">40% · '],
  ] as const)("while the retry is %o the one box says %s, not the old reason", async (retry, words, shown) => {
    const { html, boxes } = await render(retry);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toContain(size);
    expect(html).toContain(`aria-label="${words}"`);
    expect(html).toContain(shown);
    // a retry has no turn, so no Stop: its Cancel stays on the card
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

// IPT-02: each card names the model and size its job ran, inside its box, whatever the composer shows now.
describe("a card names its model", () => {
  const GIB = 1024 ** 3;
  const zimage = { id: "z-image-int8", name: "Z-Image Turbo int8", short: "Z-Image", family: "zimage", measured: false, sizes: [{ width: 1024, height: 768, bytes: 6 * GIB }] };
  const klein = { id: "flux2-klein-4b", name: "FLUX.2 Klein 4B", short: "Klein 4B", family: "flux", measured: false, sizes: [{ width: 1024, height: 1024, bytes: 10 * GIB }] };
  async function card(job: Partial<NonNullable<Message["imageJob"]>>, listed: boolean) {
    vi.stubGlobal("window", {});
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const { Timeline } = await import("./Thread.tsx");
    setState({ threadId: "thread", serverOrigin: "http://server", imagePresets: listed ? { presets: [zimage], others: [klein], current: { preset: zimage, width: 1024, height: 768 } } : undefined, messages: { thread: [
      { id: "user", threadId: "thread", role: "user", createdAt: 1, content: "a tree" },
      { id: "job", threadId: "thread", role: "assistant", createdAt: 2, content: "a tree", imageJob: { jobId: "job", threadId: "thread", state: "queued", ...job } },
    ] } });
    const html = renderToStaticMarkup(createElement(Timeline, { threadId: "thread" }));
    return { html, box: html.match(/<div class="image-job"[^>]*>/)?.[0] ?? "" };
  }
  afterEach(() => setState({ imagePresets: undefined }));

  it.each([{ state: "done", imagePath: "images/tree.png" }, { state: "error", message: "ComfyUI stopped." }, { state: "cancelled" }] as const)("by its full name and size once %o, and the box keeps its size", async (state) => {
    const { html, box } = await card({ ...state, choice: { preset: "z-image-int8", width: 1024, height: 768 } }, true);
    expect(html).toContain(">Z-Image Turbo int8 · 1024×768</span>");
    expect(box).toContain('style="aspect-ratio:1024 / 768;width:1024px"');
  });

  // while it runs the composer names the model and size: the card shows only the spinner
  it.each([{ state: "queued" }, { state: "running", progress: 0.4 }] as const)("names nothing while %o, and the box keeps its size", async (state) => {
    const { html, box } = await card({ ...state, choice: { preset: "z-image-int8", width: 1024, height: 768 } }, true);
    expect(html).not.toContain("image-job-model");
    expect(html).not.toContain("Z-Image Turbo int8");
    expect(box).toContain('style="aspect-ratio:1024 / 768;width:1024px"');
  });

  it("a job that settled to another setup names the one that ran; a setup ComfyUI no longer lists by its id", async () => {
    const settled = await card({ state: "done", imagePath: "images/tree.png", choice: { preset: "z-image-int8", width: 1024, height: 768 }, sent: { preset: "flux2-klein-4b", width: 1024, height: 1024 } }, true);
    expect(settled.html).toContain(">Z-Image Turbo int8 · 1024×768</span>");
    expect((await card({ state: "done", imagePath: "images/tree.png", choice: { preset: "flux2-klein-4b", width: 1024, height: 1024 } }, true)).html).toContain(">FLUX.2 Klein 4B · 1024×1024</span>");
    expect((await card({ state: "done", imagePath: "images/tree.png", choice: { preset: "template:gone", width: 512, height: 512 } }, false)).html).toContain(">template:gone · 512×512</span>");
  });

  it("a card from before choices were saved names nothing", async () => {
    expect((await card({ state: "done", imagePath: "images/tree.png" }, true)).html).not.toContain("image-job-model");
  });
});

// A card sent with the square default whose job settled to Z-Image 1024×768 (Klein's files absent):
// the box is the shape first drawn, waiting, running and done, the picture fitted inside.
it.each([{ state: "queued" }, { state: "running", progress: 0.4 }, { state: "done", imagePath: "images/tree.png" }] as const)("a card whose job settles to another shape keeps its first box (%o)", async (state) => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const { Timeline } = await import("./Thread.tsx");
  const sent = { preset: "flux2-klein-4b", width: 1024, height: 1024 };
  const settled = { preset: "z-image-int8", width: 1024, height: 768 };
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
