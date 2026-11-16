// Pages in a reply: the chip, the writing chip, the versions of a chat and the document the frame runs.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeDocument, type FakeElement } from "../../test/fake-dom.ts";
import { Markdown } from "../thread/markdown.tsx";
import { SANDBOX_OFF_SKIP, runPage, runPages } from "../measure/measure-pages.ts";
import { setState } from "../lib/store/store.ts";
import { COVER } from "./cover.ts";
import { PAGE_MAX, openPageWindow, pageAddress, pageFileName } from "./page-doc.ts";
import { closePanel, follow, setPageReads, showVersion, shownOf, versionsOf } from "./pages.ts";
import { PagePanel } from "./PagePanel.tsx";
import { sandboxOff } from "./sandbox.ts";
import { pinFramePolicy, pinnedFramePolicy } from "./frame-policy.ts";

const page = (title: string, body = "<p>x</p>") => `<!doctype html>\n<html><head><title>${title}</title></head><body>${body}</body></html>`;
const block = (code: string) => `\`\`\`html\n${code}\n\`\`\``;
const html = (text: string, live = false) => renderToStaticMarkup(createElement(Markdown, { text, live }));
const msg = (id: string, content: string) => ({ id, threadId: "t", role: "assistant" as const, content, createdAt: 1 });

afterEach(() => setState({ messages: {}, turns: {}, threadId: null }));

/** A blank window as window.open gives it, with the head and body a page's own window writes to. */
function blank() {
  const doc = new FakeDocument();
  const head = doc.documentElement.insertBefore(doc.createElement("head"), doc.body);
  for (const el of [head, doc.body]) Object.assign(el, { append: (n: FakeElement) => el.appendChild(n) });
  return { document: Object.assign(doc, { head, title: "" }), opener: {} as unknown, closed: false };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
function storage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
}
/** pages.ts loaded afresh over this storage, and a reader of the view it keeps for a chat. */
async function pagesOver(init: Record<string, string> = {}) {
  const kept = storage(init);
  vi.stubGlobal("localStorage", kept);
  vi.resetModules();
  const pages = await import("./pages.ts");
  const viewOf = (id: string) => {
    let v: ReturnType<typeof pages.useView>;
    renderToStaticMarkup(createElement(() => { v = pages.useView(id); return null; }));
    return v;
  };
  return { pages, kept, viewOf };
}

describe("a page in a reply", () => {
  it("is one chip with its title and version, and none of its code", () => {
    const v1 = page("Loan calculator");
    setState({ threadId: "t", messages: { t: [msg("a", block(v1))] } });
    const out = html(`Here it is.\n\n${block(v1)}\n\nEnjoy.`);
    expect(out).toContain('data-testid="pages.chip"');
    expect(out).toContain("Loan calculator");
    expect(out).toContain('<span class="pg-v">v1</span>');
    expect(out).not.toContain("&lt;body&gt;");
    expect(out).not.toContain("<pre");
  });

  it("while it is written the chip names it once its title is whole, with the working mark and no code, word or counter", () => {
    const part = "Here it is.\n\n```html\n<!doctype html>\n<html><head><title>Loan";
    const early = html(part, true);
    expect(early).toContain('<span class="pg-t">Page</span><span class="run-dot"');
    expect(early).not.toContain("Loan");
    expect(early).not.toContain("Writing");
    expect(early).not.toMatch(/\d/);
    const named = html(`${part} calculator</title></head><body><p>12`, true);
    expect(named).toContain('<span class="pg-t">Loan calculator</span><span class="run-dot"');
    expect(named).not.toMatch(/\d/);
  });

  it("a reply that ended before the block closed shows the code as before", () => {
    const out = html("Here it is.\n\n```html\n<!doctype html>\n<html><head><title>Loan", false);
    expect(out).not.toContain("pages.");
    expect(out).toContain("<pre");
    expect(out).toContain("&lt;title&gt;Loan");
  });

  it("an html snippet, or another language, stays code", () => {
    for (const text of [block("<div>hello</div>"), `\`\`\`js\n${page("x")}\n\`\`\``]) {
      expect(html(text)).not.toContain("pages.");
      expect(html(text)).toContain("<pre");
    }
  });
});

describe("versions", () => {
  it("each distinct page in order; the same code again is the same version", () => {
    const [a, b] = [page("A", "<p>1</p>"), page("A", "<p>2</p>")];
    const vs = versionsOf([block(a), `${block(b)}\n${block(a)}`, "no page", block(b)]);
    expect(vs.map((v) => [v.n, v.code])).toEqual([[1, a], [2, b]]);
  });

  it("an open block is not a version yet", () => {
    expect(versionsOf([`\`\`\`html\n${page("A")}`])).toEqual([]);
  });
});

const vs = (n: number) => versionsOf(Array.from({ length: n }, (_, i) => block(page("P", `<p>${i}</p>`))));
const panel = (thread: string) => renderToStaticMarkup(createElement(PagePanel, { threadId: thread }));
const step = (out: string) => /data-testid="pages\.panel\.step">([^<]*)</.exec(out)?.[1];

describe("the panel's state", () => {
  it("opens on the first page, steps through every version, and a new version comes on show", () => {
    setState({ messages: { one: [msg("a", block(page("P", "<p>0</p>")))] } });
    follow("one", vs(1));
    expect(step(panel("one"))).toBe("1 of 1");
    showVersion("one", 1, vs(1));
    setState({ messages: { one: vs(3).map((v, i) => msg(String(i), block(v.code))) } });
    follow("one", vs(3));
    expect(step(panel("one"))).toBe("3 of 3");
    showVersion("one", 2, vs(3));
    expect(step(panel("one"))).toBe("2 of 3");
  });

  it("once closed it stays closed, even when a new version comes; a chip opens it", () => {
    setState({ messages: { two: [msg("a", block(page("P", "<p>0</p>")))] } });
    follow("two", vs(1));
    closePanel("two");
    expect(panel("two")).toBe("");
    setState({ messages: { two: vs(2).map((v, i) => msg(String(i), block(v.code))) } });
    follow("two", vs(2));
    expect(panel("two")).toBe("");
    showVersion("two", 1, vs(2));
    expect(step(panel("two"))).toBe("1 of 2");
  });

  it("where the panel would cover the chat, the first page waits for its chip", () => {
    setState({ messages: { four: [msg("a", block(page("P", "<p>0</p>")))] } });
    follow("four", vs(1), false);
    expect(panel("four")).toBe("");
    // a wide window later does not open it by itself either: the chat has met its page
    follow("four", vs(1));
    expect(panel("four")).toBe("");
    showVersion("four", 1, vs(1));
    expect(step(panel("four"))).toBe("1 of 1");
  });

  it("keeps the page on show when older versions come in front of it (Show earlier, or the server's list)", () => {
    const all = vs(4);
    const loaded = all.slice(2);
    setState({ messages: { five: loaded.map((v, i) => msg(String(i), block(v.code))) } });
    follow("five", versionsOf(loaded.map((v) => block(v.code))));
    showVersion("five", 1, versionsOf(loaded.map((v) => block(v.code))));
    // two older pages arrive in front: the same page stays on show, now the third of four
    setState({ messages: { five: all.map((v, i) => msg(String(i), block(v.code))) } });
    expect(step(panel("five"))).toBe("3 of 4");
  });

  it("a version that is gone falls back to the newest there is", () => {
    expect(shownOf({ open: true, shown: "gone", newest: "" }, vs(2))?.n).toBe(2);
    expect(shownOf(undefined, vs(2))?.n).toBe(2);
    expect(shownOf(undefined, [])).toBeUndefined();
  });

  it("a long chat's chip and panel wait for its older pages: the chip keeps its number's place empty, the panel draws nothing", () => {
    const v = page("Loan calculator");
    setPageReads({ pages: () => new Promise(() => undefined), earlierOf: () => 3, onEarlier: () => () => undefined });
    try {
      setState({ threadId: "six", messages: { six: [msg("a", block(v))] } });
      follow("six", versionsOf([block(v)]));
      const chip = html(block(v));
      expect(chip).toContain('<span class="pg-v" aria-hidden="true" style="visibility:hidden">v1</span>');
      expect(chip).not.toContain('<span class="pg-v">');
      expect(panel("six")).toBe("");
    } finally {
      setPageReads({ pages: () => Promise.reject(new Error("not connected")), earlierOf: () => 0, onEarlier: () => () => undefined });
    }
  });

  it("lies over the chat at the width where pages.css lays it over the chat", () => {
    const css = readFileSync(new URL("pages.css", import.meta.url), "utf8");
    const at = css.indexOf(`@media ${COVER.replaceAll(" ", "")}{`);
    expect(at).toBeGreaterThan(-1);
    expect(css.slice(at).split("\n}")[0]).toContain(".pg-panel{position:fixed;inset:0");
  });

  it("draws no frame before the server has given the page its address, and no address holds the code", () => {
    setState({ messages: { three: [msg("a", block(page("P")))] } });
    follow("three", vs(1));
    const out = panel("three");
    expect(out).not.toContain("<iframe");
    expect(out).toContain('<div class="pg-frame" aria-hidden="true"></div>');
    expect(out).not.toContain("data:");
  });
});

describe("the frame's address", () => {
  const SERVER = "http://127.0.0.1:5186";
  const ID = "0123456789abcdef0123456789abcdef";
  afterEach(() => vi.unstubAllGlobals());

  /** fetch as the server's page route answers it; the hand-overs are kept. */
  function route(status = 201, id = ID): Array<{ url: string; init: RequestInit }> {
    const sent: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return Promise.resolve(new Response(status === 201 ? JSON.stringify({ id }) : null, { status }));
    });
    return sent;
  }

  it("is the server's page route under the id it answered, with the token only on the hand-over", async () => {
    const sent = route();
    const a = await pageAddress(page("A"), { origin: SERVER, token: "secret-token" });
    expect(a).toEqual({ url: `${SERVER}/pages/${ID}` });
    expect(JSON.stringify(a)).not.toContain("secret-token");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`${SERVER}/pages?token=secret-token`);
    expect(sent[0]!.init).toMatchObject({ method: "POST", body: page("A"), credentials: "omit", referrerPolicy: "no-referrer" });
  });

  it("on the phone (no token) hands over on its own origin", async () => {
    const sent = route();
    expect(await pageAddress(page("A"), { origin: "https://hub.example.ts.net", token: null })).toEqual({ url: `https://hub.example.ts.net/pages/${ID}` });
    expect(sent[0]!.url).toBe("https://hub.example.ts.net/pages");
  });

  it("a page past the size the server serves is not sent; the server's own refusal reads the same", async () => {
    const sent = route(413);
    expect(await pageAddress("a".repeat(PAGE_MAX + 1), { origin: SERVER, token: "t" })).toEqual({ error: "too-big" });
    expect(sent).toHaveLength(0);
    expect(await pageAddress("a".repeat(PAGE_MAX), { origin: SERVER, token: "t" })).toEqual({ error: "too-big" });
    expect(sent).toHaveLength(1);
  });

  it("the largest page is the one the server's page route serves", () => {
    const served = readFileSync(new URL("../../../server/src/pages/route.ts", import.meta.url), "utf8");
    const size = /export const PAGE_MAX_BYTES = ([\d\s*]+);/.exec(served)?.[1];
    expect(size?.split("*").reduce((n, f) => n * Number(f), 1)).toBe(PAGE_MAX);
  });

  it("its own window is a blank window cut from the app's, given the locked frame once the server has the page", async () => {
    let w = blank();
    const open = vi.fn((_url: string, _target: string) => w);
    vi.stubGlobal("window", { open });
    route();
    expect(openPageWindow(page("A"), "A", { origin: SERVER, token: "t" })).toBe(true);
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(w.opener).toBeNull();
    expect(w.document.title).toBe("A");
    await flush();
    const frame = w.document.body.childNodes[0] as FakeElement;
    expect(w.document.body.childNodes).toHaveLength(1);
    expect([frame.getAttribute("sandbox"), frame.getAttribute("allow")]).toEqual(["allow-scripts", ""]);
    expect(frame).toMatchObject({ referrerPolicy: "no-referrer", title: "A", src: `${SERVER}/pages/${ID}` });
    // the server refuses it: the window says so
    route(401);
    w = blank();
    openPageWindow(page("A"), "A", { origin: SERVER, token: "t" });
    await flush();
    expect(w.document.body.textContent).toBe("This page could not be run.");
    // closed before the server answered: nothing is put in it
    route();
    w = blank();
    openPageWindow(page("A"), "A", { origin: SERVER, token: "t" });
    w.closed = true;
    await flush();
    expect(w.document.body.childNodes).toHaveLength(0);
    // a popup the browser blocks
    vi.stubGlobal("window", { open: () => null });
    expect(openPageWindow(page("A"), "A", { origin: SERVER, token: "t" })).toBe(false);
  });

  it("an id that is not the server's shape, a refusal or no server gives no address", async () => {
    route(201, "../../index.html?");
    expect(await pageAddress(page("A"), { origin: SERVER, token: "t" })).toEqual({ error: "refused" });
    route(401);
    expect(await pageAddress(page("A"), { origin: SERVER, token: "t" })).toEqual({ error: "refused" });
    expect(await pageAddress(page("A"), { origin: null, token: null })).toEqual({ error: "no-server" });
  });

  it("Measure's page checks take the same route, and none run with the sandbox off", async () => {
    const sent = route(413);
    const checks = [{ id: "page-total", state: "pending", page: page("M"), script: [{ do: "read" as const, target: "#out" }] }];
    const seen = await runPage("page-total", page("M"), checks[0]!.script, 100, { origin: SERVER, token: "t" });
    expect(sent[0]!.url).toBe(`${SERVER}/pages?token=t`);
    // what goes to the route is the page with the check's harness after it
    expect(String(sent[0]!.init.body).startsWith(page("M"))).toBe(true);
    expect(seen).toEqual({ id: "page-total", seen: [], error: "The page is too big to run here (0.0 MB)." });
    const skipped = await runPages(checks, () => Promise.resolve(true));
    expect(skipped).toEqual([{ id: "page-total", seen: [], skipped: SANDBOX_OFF_SKIP }]);
    expect(sent).toHaveLength(1);
  });

  it("the desktop app's sandbox switch is read once its server is ready; a browser has its sandbox", async () => {
    expect(await sandboxOff()).toBe(false);
    let push: ((s: { status: string; sandboxOff?: boolean }) => void) | undefined;
    vi.stubGlobal("window", { gatesLocal: { getState: () => Promise.resolve({ status: "starting" }), onState: (l: typeof push) => { push = l; return () => undefined; } } });
    const asked = sandboxOff();
    await Promise.resolve();
    push?.({ status: "ready", sandboxOff: true });
    expect(await asked).toBe(true);
  });

  it("asks the desktop bridge once: the switch is fixed for the life of the app", async () => {
    vi.resetModules();
    const getState = vi.fn(() => Promise.resolve({ status: "ready", sandboxOff: true }));
    vi.stubGlobal("window", { gatesLocal: { getState, onState: () => () => undefined } });
    const fresh = await import("./sandbox.ts");
    expect(await fresh.sandboxOff()).toBe(true);
    expect(await fresh.sandboxOff()).toBe(true);
    expect(getState).toHaveBeenCalledTimes(1);
  });

  it("a bridge from before the sandbox switch, or a ready state without it, runs pages by themselves", async () => {
    vi.resetModules();
    vi.stubGlobal("window", { gatesLocal: {} });
    expect(await (await import("./sandbox.ts")).sandboxOff()).toBe(false);
    vi.resetModules();
    vi.stubGlobal("window", { gatesLocal: { getState: () => Promise.resolve({ status: "ready" }), onState: () => () => undefined } });
    expect(await (await import("./sandbox.ts")).sandboxOff()).toBe(false);
  });

  it("a bridge that cannot answer counts as sandbox off: a page waits for Run, and Measure is not left waiting", async () => {
    vi.resetModules();
    vi.stubGlobal("window", { gatesLocal: { getState: () => Promise.reject(new Error("no reply")), onState: () => () => undefined } });
    const fresh = await import("./sandbox.ts");
    expect(await Promise.race([fresh.sandboxOff(), new Promise((r) => setTimeout(() => r("never settled"), 50))])).toBe(true);
  });

  it("in a browser tab the app's frame policy is narrowed to the one server it talks to, once", () => {
    expect(pinnedFramePolicy("http://127.0.0.1:5286")).toBe("frame-src http://127.0.0.1:5286/pages/");
    expect(pinnedFramePolicy("https://hub.example.ts.net:8456")).toBe("frame-src https://hub.example.ts.net:8456/pages/");
    // nothing that is not a bare origin is ever written into a policy
    for (const odd of ["", "http://127.0.0.1:5286/x", "http://a b", "http://x; script-src *", "javascript:alert(1)"]) expect(pinnedFramePolicy(odd), odd).toBeUndefined();
    const added: { httpEquiv: string; content: string }[] = [];
    const doc = { createElement: () => ({ httpEquiv: "", content: "" }), head: { append: (m: { httpEquiv: string; content: string }) => added.push(m) } };
    // a document that cannot take the tag: the connection that called this goes on, and the next one tries again
    expect(() => pinFramePolicy("http://127.0.0.1:5286", {} as unknown as Document)).not.toThrow();
    pinFramePolicy("http://127.0.0.1:5286", doc as unknown as Document);
    pinFramePolicy("http://127.0.0.1:5286", doc as unknown as Document);
    pinFramePolicy("http://127.0.0.1:9999", doc as unknown as Document);
    expect(added).toEqual([{ httpEquiv: "Content-Security-Policy", content: "frame-src http://127.0.0.1:5286/pages/" }]);
  });

  it("a save is named after the page", () => {
    expect(pageFileName("Loan calculator — v2!")).toBe("loan-calculator-v2.html");
    expect(pageFileName("…")).toBe("page.html");
  });
});

describe("the views kept in this browser", () => {
  afterEach(() => vi.unstubAllGlobals());
  const KEY = "gates-local.pages";

  it("a chat's view kept by an earlier build stays as it was left, with the newest on show", async () => {
    const two = vs(2);
    const newest = two[1]!.key;
    const { pages, viewOf } = await pagesOver({ [KEY]: JSON.stringify({ old: { open: false, shown: 1, newest } }) });
    expect(viewOf("old")).toEqual({ open: false, shown: newest, newest });
    pages.follow("old", two);
    expect(viewOf("old")).toEqual({ open: false, shown: newest, newest });
  });

  it("keeps the views of the last 200 chats: past that the oldest drops off, and a chat touched again is the newest", async () => {
    const { pages, kept } = await pagesOver();
    for (let i = 0; i <= 200; i++) pages.follow(`c${i}`, vs(1));
    const ids = () => Object.keys(JSON.parse(kept.getItem(KEY) ?? "{}") as object);
    expect(ids()).toHaveLength(200);
    expect([ids()[0], ids().at(-1)]).toEqual(["c1", "c200"]);
    pages.closePanel("c1");
    expect([ids()[0], ids().at(-1), ids().length]).toEqual(["c2", "c1", 200]);
  });
});
