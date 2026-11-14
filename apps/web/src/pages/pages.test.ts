// Pages in a reply: the chip, the writing chip, the versions of a chat and the document the frame runs.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "../markdown.tsx";
import { setState } from "../store.ts";
import { PAGE_POLICY, framedDoc, pageFileName, pageUrl } from "./page-doc.ts";
import { closePanel, follow, showVersion, shownOf, versionsOf } from "./pages.ts";
import { PagePanel } from "./PagePanel.tsx";

const page = (title: string, body = "<p>x</p>") => `<!doctype html>\n<html><head><title>${title}</title></head><body>${body}</body></html>`;
const block = (code: string) => `\`\`\`html\n${code}\n\`\`\``;
const html = (text: string, live = false) => renderToStaticMarkup(createElement(Markdown, { text, live }));
const msg = (id: string, content: string) => ({ id, threadId: "t", role: "assistant" as const, content, createdAt: 1 });

afterEach(() => setState({ messages: {}, turns: {}, threadId: null }));

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

  it("a version that is gone falls back to the newest there is", () => {
    expect(shownOf({ open: true, shown: 5, newest: "" }, vs(2))?.n).toBe(2);
    expect(shownOf(undefined, vs(2))?.n).toBe(2);
    expect(shownOf(undefined, [])).toBeUndefined();
  });

  it("the frame is sandboxed to scripts only, sends no referrer and loads a data: address", () => {
    setState({ messages: { three: [msg("a", block(page("P")))] } });
    follow("three", vs(1));
    const out = panel("three");
    expect(out).toMatch(/<iframe[^>]* sandbox="allow-scripts"/);
    expect(out).toMatch(/<iframe[^>]* referrerPolicy="no-referrer"/i);
    expect(out).toMatch(/<iframe[^>]* src="data:text\/html;charset=utf-8,/);
  });
});

describe("the framed document", () => {
  it("puts the policy first, after the doctype", () => {
    const doc = framedDoc(page("A"));
    expect(doc.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${PAGE_POLICY}">`)).toBe(true);
    expect(framedDoc("<html><body>x</body></html>").startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(true);
  });

  it("is the whole URL, with nothing of the app's address in it", () => {
    const url = pageUrl(page("A"));
    expect(url.startsWith("data:text/html;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url.slice(url.indexOf(",") + 1))).toBe(framedDoc(page("A")));
  });

  it("a save is named after the page", () => {
    expect(pageFileName("Loan calculator — v2!")).toBe("loan-calculator-v2.html");
    expect(pageFileName("…")).toBe("page.html");
  });
});
