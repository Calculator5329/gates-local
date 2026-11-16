// The page panel and a chat's page list mounted for real (react-dom on the fake DOM): when a page
// is handed to the server, what the panel shows when it cannot run, and the older pages of a long chat.
// What the frame may do once it runs has E2E coverage (test/e2e/pages-lockdown.spec.ts).
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import type { ThreadPage } from "@gates-local/contracts";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { FakeDocument, FakeElement, FakeIFrame, type FakeNode } from "../../test/fake-dom.ts";

vi.mock("../lib/ui/ui.tsx", async (original) => ({ ...await original<typeof import("../lib/ui/ui.tsx")>(), useMedia: () => false }));

const SERVER = "http://127.0.0.1:5186";
const doc = new FakeDocument();
const win: { document: FakeDocument; HTMLIFrameElement: typeof FakeIFrame; gatesLocal?: unknown; addEventListener(): void; removeEventListener(): void } = {
  document: doc, HTMLIFrameElement: FakeIFrame, addEventListener() {}, removeEventListener() {},
};
/** The server's page route: each hand-over answers a new id, or `status`; `hold` keeps the answer until released. */
const route = { status: 201, ids: 0, hold: false, waiting: [] as (() => void)[] };
const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
  if (route.hold) await new Promise<void>((r) => route.waiting.push(r));
  const id = (++route.ids).toString(16).padStart(32, "0");
  return new Response(route.status === 201 ? JSON.stringify({ id }) : null, { status: route.status });
});
let root: Root;
let store: typeof import("../lib/store/store.ts");
let pages: typeof import("./pages.ts");
let PagePanel: typeof import("./PagePanel.tsx")["PagePanel"];

const page = (title: string) => `<!doctype html>\n<html><head><title>${title}</title></head><body><p>x</p></body></html>`;
const block = (code: string) => `\`\`\`html\n${code}\n\`\`\``;
const msg = (threadId: string, id: string, content: string) => ({ id, threadId, role: "assistant" as const, content, createdAt: 1 });

beforeAll(async () => {
  doc.defaultView = win;
  Object.assign(doc, { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("fetch", fetch);
  const { createRoot } = await import("react-dom/client");
  store = await import("../lib/store/store.ts");
  pages = await import("./pages.ts");
  ({ PagePanel } = await import("./PagePanel.tsx"));
  root = createRoot(doc.body.appendChild(doc.createElement("div")) as unknown as Element);
});
afterAll(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
beforeEach(() => {
  fetch.mockClear();
  Object.assign(route, { status: 201, hold: false, waiting: [] });
  store.setState({ serverOrigin: SERVER, fileToken: "t" });
});
afterEach(() => { act(() => root.render(null)); delete win.gatesLocal; });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
function all(pred: (el: FakeElement) => boolean): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (n: FakeNode) => { for (const c of n.childNodes) if (c instanceof FakeElement) { if (pred(c)) out.push(c); walk(c); } };
  walk(doc.body);
  return out;
}
const byTestId = (id: string) => all((el) => el.getAttribute("data-testid") === id)[0] ?? null;
/** Where the panel's frame points, if there is one; a fake element is not printed in a failure. */
const frameAt = () => byTestId("pages.frame")?.getAttribute("src") ?? undefined;
const props = (el: FakeElement | null): Record<string, unknown> => {
  if (el === null) throw new Error("no such element");
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  return (key === undefined ? {} : (el as unknown as Record<string, Record<string, unknown>>)[key]) ?? {};
};
const click = async (el: FakeElement | null) => {
  await act(async () => { (props(el)["onClick"] as () => void)(); });
  await settle();
};
/** What the probe of a chat's page list shows: its versions' titles, and whether the list is whole. */
const seen = () => [byTestId("probe")?.getAttribute("data-v"), byTestId("probe")?.getAttribute("data-loaded")];
/** The panel of a chat whose replies wrote these pages, opened by its first page. */
async function mount(threadId: string, codes: readonly string[]) {
  store.setState({ threadId, messages: { [threadId]: codes.map((c, i) => msg(threadId, `${threadId}-${i}`, block(c))) } });
  act(() => root.render(createElement(PagePanel, { threadId })));
  await settle();
}

it("runs nothing until the desktop bridge has said, then hands the page over and frames it", async () => {
  let answer!: (s: { status: string; sandboxOff?: boolean }) => void;
  win.gatesLocal = { getState: () => new Promise((r) => { answer = r; }), onState: () => () => undefined };
  await mount("b1", [page("A")]);
  expect(byTestId("pages.panel")).not.toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  expect(frameAt()).toBeUndefined();
  expect(props(byTestId("pages.panel.open-window"))["disabled"]).toBe(true);
  await act(async () => { answer({ status: "ready", sandboxOff: false }); });
  await settle();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(frameAt()).toBe(`${SERVER}/pages/${route.ids.toString(16).padStart(32, "0")}`);
  expect(props(byTestId("pages.panel.open-window"))["disabled"]).toBe(false);
});

it("a page the server did not take shows its code and says so, with no code button to leave it", async () => {
  route.status = 401;
  await mount("r1", [page("A")]);
  expect(byTestId("pages.not-run")?.textContent).toBe("The server did not take this page, so it cannot run");
  expect(byTestId("pages.panel.source")?.textContent).toBe(page("A"));
  expect(frameAt()).toBeUndefined();
  expect(props(byTestId("pages.panel.code"))["disabled"]).toBe(true);
});

it("each frame loads an address of its own: back from the code view, the page is handed over again", async () => {
  await mount("c1", [page("A")]);
  const first = frameAt();
  expect(first).toMatch(/\/pages\/[0-9a-f]{32}$/);
  await click(byTestId("pages.panel.code"));
  expect(frameAt()).toBeUndefined();
  route.hold = true;
  await click(byTestId("pages.panel.code"));
  // the address the first frame loaded is spent: no frame until the new one comes
  expect(frameAt()).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => { for (const r of route.waiting) r(); });
  await settle();
  const second = frameAt();
  expect(second).toMatch(/\/pages\/[0-9a-f]{32}$/);
  expect(second).not.toBe(first);
});

it("a long chat's older pages stay while a newer read is on its way, and a failed read leaves them", async () => {
  const reads: { before: string; answer: (p: readonly ThreadPage[]) => void; fail: () => void }[] = [];
  pages.setPageReads({
    pages: (_threadId, before) => new Promise((answer, reject) => { reads.push({ before, answer, fail: () => reject(new Error("down")) }); }),
    earlierOf: () => 5,
    onEarlier: () => () => undefined,
  });
  const Probe = () => {
    const { versions, loaded } = pages.usePages("o1");
    return createElement("i", { "data-testid": "probe", "data-v": versions.map((v) => v.title).join(","), "data-loaded": String(loaded) });
  };
  try {
    store.setState({ messages: { o1: [msg("o1", "m9", block(page("New")))] } });
    act(() => root.render(createElement(Probe)));
    await settle();
    expect(reads.map((r) => r.before)).toEqual(["m9"]);
    expect(seen()).toEqual(["New", "false"]);
    await act(async () => { reads[0]?.answer([{ messageId: "m1", code: page("Old") }]); });
    await settle();
    expect(seen()).toEqual(["Old,New", "true"]);
    // Show earlier loads another message: the pages before it are asked for, and the ones in hand stay
    store.setState({ messages: { o1: [msg("o1", "m7", "no page"), msg("o1", "m9", block(page("New")))] } });
    await settle();
    expect(reads.map((r) => r.before)).toEqual(["m9", "m7"]);
    expect(seen()).toEqual(["Old,New", "true"]);
    await act(async () => { reads[1]?.fail(); });
    await settle();
    expect(seen()).toEqual(["Old,New", "true"]);
  } finally {
    pages.setPageReads({ pages: () => Promise.reject(new Error("not connected")), earlierOf: () => 0, onEarlier: () => () => undefined });
  }
});
