import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import type { Message } from "@gates-local/contracts";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { FakeDocument, FakeElement, FakeIFrame } from "../../test/fake-dom.ts";

vi.mock("../lib/session/index.ts", () => ({ cancelImage: vi.fn(), retryImage: vi.fn(), reloadThread: vi.fn(), retry: vi.fn(), fileUrl: () => "/files/image.png", loadEarlier: vi.fn(async () => false), earlierOf: () => 0, onEarlier: () => () => undefined }));

const doc = new FakeDocument();
let root: Root;
let store: typeof import("../lib/store/store.ts");
let Timeline: typeof import("./Thread.tsx")["Timeline"];

const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

beforeAll(async () => {
  const win = { document: doc, HTMLIFrameElement: FakeIFrame, matchMedia, requestIdleCallback: () => 0, cancelIdleCallback() {}, addEventListener() {}, removeEventListener() {} };
  doc.defaultView = win;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("matchMedia", matchMedia);
  vi.stubGlobal("requestIdleCallback", () => 0);
  vi.stubGlobal("cancelIdleCallback", () => {});
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("HTMLElement", FakeElement);
  const { createRoot } = await import("react-dom/client");
  store = await import("../lib/store/store.ts");
  ({ Timeline } = await import("./Thread.tsx"));
  root = createRoot(doc.body.appendChild(doc.createElement("div")) as unknown as Element);
});
afterAll(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
afterEach(() => {
  act(() => root.render(null));
  store.setState({ messages: {}, threadId: null, serverOrigin: null });
});

type Job = NonNullable<Message["imageJob"]>;
const choice = { preset: "z-image-int8", width: 1024, height: 768 };

function thread(jobs: readonly Partial<Job>[]): Message[] {
  return [
    { id: "user", threadId: "thread", role: "user", createdAt: 1, content: "a tree" },
    ...jobs.map((job, i): Message => ({ id: `job-${i}`, threadId: "thread", role: "assistant", createdAt: 2 + i, content: "a tree", imageJob: { jobId: `job-${i}`, threadId: "thread", state: "done", imagePath: `images/tree-${i}.png`, choice, ...job } })),
  ];
}

function open(messages: Message[], origin: string | null) {
  store.setState({ threadId: "thread", serverOrigin: origin, messages: { thread: messages } });
  act(() => root.render(createElement(Timeline, { threadId: "thread" })));
}

function reactProps(el: FakeElement): Record<string, unknown> {
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  return key === undefined ? {} : (Reflect.get(el, key) as Record<string, unknown>);
}

const sheet = readFileSync(new URL("../app/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function declsOf(selector: string, prop: string): string[] {
  const out: string[] = [];
  for (const [, selectors = "", body = ""] of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors.split(",").map((s) => s.trim()).includes(selector)) continue;
    for (const [, value = ""] of body.matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "g"))) out.push(value.trim());
  }
  return out;
}

it("a picture whose file is gone becomes the quiet Image not available placeholder in its own box", () => {
  open(thread([{}]), "http://server");
  const box = doc.body.querySelector(".image-job");
  const img = doc.body.querySelector("img.img-out");
  if (img === null) throw new Error("no picture");
  expect(doc.body.querySelector(".img-miss")).toBeNull();
  act(() => { (reactProps(img).onError as () => void)(); });
  expect(doc.body.querySelector("img")).toBeNull();
  const miss = doc.body.querySelector(".image-job .img-miss");
  expect(miss?.textContent).toBe("Image not available");
  expect(doc.body.querySelector(".image-job")).toBe(box);
});

it("a picture with no server to fetch it from shows Image not available, not a broken image", () => {
  open(thread([{}]), null);
  expect(doc.body.querySelector("img")).toBeNull();
  expect(doc.body.querySelector(".image-job .img-miss")?.textContent).toBe("Image not available");
});

it("a send of three or four pictures is one card whose tiles sit two to a row", () => {
  for (const count of [3, 4]) {
    open(thread(Array.from({ length: count }, (_, index) => ({ group: { id: "send", index, of: count } }))), "http://server");
    expect(doc.body.querySelectorAll(".image-group")).toHaveLength(1);
    expect(doc.body.querySelectorAll(".image-group .image-tiles")).toHaveLength(1);
    expect(doc.body.querySelectorAll(".image-tiles .image-job")).toHaveLength(count);
    act(() => root.render(null));
  }
  expect(declsOf(".image-tiles", "display")).toEqual(["grid"]);
  expect(declsOf(".image-tiles", "grid-template-columns")).toEqual(["1fr 1fr"]);
});

it("a finished picture is fitted whole inside its box, never cropped or spilling out of it", () => {
  open(thread([{}]), "http://server");
  expect(doc.body.querySelector(".image-job img.img-out")).not.toBeNull();
  expect(declsOf(".image-job .img-out", "object-fit")).toEqual(["contain"]);
  expect(declsOf(".image-job .img-out", "width")).toEqual(["100%"]);
  expect(declsOf(".image-job .img-out", "height")).toEqual(["100%"]);
});
