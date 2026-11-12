// The pages an update shows without a server (section 8's sentences): the
// words once, the release page link only where the words promise one, and
// the one action a page has as a link main catches.
import { describe, expect, it } from "vitest";
import { pageAction, renderUpdatePage } from "./page.ts";

const RELEASE = "https://example.test/r/latest";

describe("update page", () => {
  it("PG-01 says the sentence once, escaped, with its second line", () => {
    const html = renderUpdatePage({ words: { text: "Found <b>a</b> file at /a & b.", detail: "Second line." }, releasePage: RELEASE, actions: [] });
    expect(html).toContain("Found &lt;b&gt;a&lt;/b&gt; file at /a &amp; b.");
    expect(html.split("Found &lt;b&gt;").length - 1).toBe(1);
    expect(html).toContain("Second line.");
    expect(html).not.toContain("<b>a</b>");
  });

  it("PG-02 links the release page only when the words send the person there", () => {
    expect(renderUpdatePage({ words: { text: "Download it.", link: true }, releasePage: RELEASE, actions: [] })).toContain(`href="${RELEASE}"`);
    expect(renderUpdatePage({ words: { text: "Updating." }, releasePage: RELEASE, actions: [] })).not.toContain(RELEASE);
    expect(renderUpdatePage({ words: { text: "Download it.", link: true }, releasePage: null, actions: [] })).not.toContain("href=");
  });

  it("PG-03 an action is a link main catches; no script runs on the page", () => {
    const html = renderUpdatePage({ words: { text: "An earlier update did not finish." }, releasePage: RELEASE, actions: ["continue"] });
    const href = /href="([^"]+)"/.exec(html)?.[1];
    expect(href).toBeDefined();
    expect(pageAction(href!)).toBe("continue");
    // Section 2, rollback-failed: the one button is "Start Gates Local".
    expect(html).toContain(">Start Gates Local</a>");
    expect(html).not.toContain("<script");
    expect(pageAction("gates-local-update:delete")).toBeNull();
    expect(pageAction("gates-local-update:constructor")).toBeNull();
    expect(pageAction(RELEASE)).toBeNull();
  });
});
