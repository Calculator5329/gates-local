// Links in a reply: a bare URL is a link, and a long one can wrap only at its separators.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { isPageDoc, mayBePage, pageBlocks } from "@gates-local/contracts";
import { createMarkdownParser, Markdown } from "./markdown.tsx";

const html = (text: string, live = false) => renderToStaticMarkup(createElement(Markdown, { text, live }));

describe("paced inline markup", () => {
  it("renders an unfinished emphasis or inline code span without flashing its delimiters", () => {
    expect(html("Start **bold", true)).toContain("<strong>bold</strong>");
    expect(html("Start **bold*", true)).toContain("<strong>bold</strong>");
    expect(html("Start *soft", true)).toContain("<em>soft</em>");
    expect(html("Use `cmd", true)).toContain("<code>cmd</code>");
    expect(html("Start **bold**", true)).toContain("<strong>bold</strong>");
    expect(html("literal **", false)).toContain("literal **");
  });
});

it("does not add a temporary blank code line just before the closing fence", () => {
  const open = html("```sh\necho hello\n", true);
  const closed = html("```sh\necho hello\n```", true);
  expect(open).toBe(closed);
});

describe("links", () => {
  it.each(["LINKS", "# LINKS", "> LINKS", "- LINKS", "1. LINKS", "| LINKS |\n| --- |\n| LINKS |"])("keeps invented links inert through partial formatting in %s", (block) => {
    const text = block.replaceAll("LINKS", "[Invented](https://invented.example/report) **still writing");
    for (const live of [true, false]) {
      const out = renderToStaticMarkup(createElement(Markdown, { text, live, allowedLinks: new Set<string>() }));
      expect(out).toContain("Invented");
      expect(out).not.toContain("<a ");
    }
  });

  it("uses provenance when a pending destination closes", () => {
    const props = { live: true, allowedLinks: new Set<string>() };
    const text = "See [the guide](https://invented.example/report";
    expect(renderToStaticMarkup(createElement(Markdown, { ...props, text }))).toBe('<div class="md live"><p>See the guide</p></div>');
    expect(renderToStaticMarkup(createElement(Markdown, { ...props, text: text + ")" }))).not.toContain("<a ");
  });

  it.each([
    "# LINKS", "> LINKS", "- LINKS", "| Result |\n| --- |\n| LINKS |",
  ])("restricts complete URL targets in every block: %s", (block) => {
    const props = { text: block.replace("LINKS", "[Known](https://person.example/brief) [Invented](https://person.example/brief/other)"), allowedLinks: new Set(["https://person.example/brief"]) };
    const out = renderToStaticMarkup(createElement(Markdown, props));
    expect(out).toContain('href="https://person.example/brief"');
    expect(out).toContain("Invented");
    expect(out).not.toContain('href="https://person.example/brief/other"');
  });
  it.each(["https://example.com/invented.png", "images/saved.png", "javascript:alert(1)"])("shows an image label without fetching or linking %s", (url) => {
    const out = html(`![Star Trek Ship](${url})`);
    expect(out).toContain("Star Trek Ship");
    expect(out).not.toContain("!");
    expect(out).not.toContain("<a ");
    expect(out).not.toContain("<img");
  });
  it("shows only a partial link's label until the destination closes", () => {
    for (const tail of ["", "https://example.com", "https://example.com/" + "long/".repeat(80)]) {
      expect(html(`See [the guide](${tail}`, true)).toBe('<div class="md live"><p>See the guide</p></div>');
    }
    expect(html("See [the guide](https://example.com)", true)).toContain('>the guide</a>');
    expect(html("See [the guide](https://example.com", false)).toContain("[the guide](");
    expect(html("Use `[the guide](https://example.com`", true)).toContain("<code>[the guide](https://example.com</code>");
    expect(html("See [**guide**](https://example.com", true)).toContain("See **guide**</p>");
  });
  it("makes a bare https URL a link and leaves the sentence's full stop outside it", () => {
    const out = html("See https://example.com/docs.");
    expect(out).toContain('href="https://example.com/docs"');
    expect(out).toContain("</a>.");
  });

  it("offers a break after every / and - of a URL, and nowhere else", () => {
    const out = html("[https://a.example/one-two/three](https://a.example/one-two/three)");
    expect(out).toContain("https:/<wbr/>/<wbr/>a.example/<wbr/>one-<wbr/>two/<wbr/>three");
  });

  it("does not link a URL in inline code", () => {
    expect(html("`https://example.com/a`")).not.toContain("<a ");
  });

  it("keeps a label that is not a URL whole", () => {
    expect(html("[some-long label](https://example.com)")).toContain(">some-long label</a>");
  });
});

it("retains completed parses so suffix work does not grow with reply length", () => {
  const identities: boolean[] = [];
  const counts = [2, 1000].map((length) => {
    const parse = createMarkdownParser();
    const prefix = "A completed paragraph.\n\n".repeat(length);
    const initial = parse(prefix + "Tail");
    const spy = vi.spyOn(RegExp.prototype, "test");
    let latest = initial;
    try {
      for (let i = 1; i <= 20; i++) latest = parse(prefix + "Tail" + "x".repeat(i));
      identities.push(latest.blocks[0] === initial.blocks[0]);
      return spy.mock.calls.length;
    } finally { spy.mockRestore(); }
  });
  expect(counts[1]).toBeLessThanOrEqual(counts[0]! + 20);
  expect(identities).toEqual([true, true]);
});

it("keeps incremental parsing equivalent across block boundaries and resets", () => {
  const parse = createMarkdownParser();
  const text = "Heading\r\n\r\nA paragraph\r\ncontinued.\r\n\r\n## Next\n- One\n- Two\n\n```sh\necho hi\n```\n\nA | B\n-- | --\n1 | 2\n\n> Quote\n> continued\n\nEnd";
  for (let i = 1; i <= text.length; i++) {
    const prefix = text.slice(0, i);
    expect(parse(prefix).blocks).toEqual(createMarkdownParser()(prefix).blocks);
  }
  expect(parse("Reset").blocks).toEqual([{ t: "p", text: "Reset" }]);
  expect(parse("A replacement that is longer", false).blocks).toEqual([{ t: "p", text: "A replacement that is longer" }]);
});

const DOC = "<!doctype html>\n<html><body><p>Hi</p></body></html>";
const FENCE_TEXTS = [
  `Here it is:\n\n\`\`\`html\n${DOC}\n\`\`\`\n\nDone.`,
  "A snippet:\n```html\n<p>Just a part</p>\n```",
  `Two:\n\`\`\`HTML\n${DOC}\n\`\`\`\n\`\`\`css\nbody{}\n\`\`\`\n  \`\`\`html\n${DOC}\n  \`\`\``,
  `Still writing:\n\`\`\`html\n${DOC.slice(0, 20)}`,
  "Opening:\n```html\n",
  `Windows lines:\r\n\`\`\`html\r\n${DOC.replaceAll("\n", "\r\n")}\r\n\`\`\`\r\nAfter.`,
  `Old Mac lines:\r\`\`\`html\r${DOC.replaceAll("\n", "\r")}\r\`\`\``,
  "No fences at all, only `inline` code.",
];

function rendererPages(text: string) {
  return createMarkdownParser()(text, false).blocks.flatMap((b) => {
    if (b.t !== "code" || b.lang.toLowerCase() !== "html") return [];
    return (b.closed ? isPageDoc(b.text) : mayBePage(b.text)) ? [{ code: b.text, closed: b.closed }] : [];
  });
}

it("the renderer and the page reader agree on every fence: the blocks drawn as pages are the blocks both sides call pages", () => {
  for (const text of FENCE_TEXTS) {
    const read = pageBlocks(text).map(({ code, closed }) => ({ code, closed }));
    expect(rendererPages(text), JSON.stringify(text)).toEqual(read);
  }
  expect(FENCE_TEXTS.map((t) => pageBlocks(t).length)).toEqual([1, 0, 2, 1, 1, 1, 1, 0]);
});

const rulesWith = (css: string, selector: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter((m) => (m[1] ?? "").split(",").map((s) => s.trim()).includes(selector))
  .map((m) => m[2] ?? "");

describe("what a reply's markdown draws", () => {
  it("text that looks like HTML shows as text in prose, a heading or a quote, and quotes and numbered lists draw as themselves", () => {
    const prose = html("Say <script>alert(1)</script> and <b>loud</b>");
    expect(prose).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(prose).toContain("&lt;b&gt;loud&lt;/b&gt;");
    expect(prose).not.toContain("<script");
    expect(prose).not.toContain("<b>");
    const heading = html("# Title <img src=x onerror=alert(1)>");
    expect(heading).toContain("<h1>Title &lt;img src=x onerror=alert(1)&gt;</h1>");
    const quote = html("> Quoted <iframe src=https://x.example></iframe>");
    expect(quote).toContain("<blockquote>Quoted &lt;iframe");
    expect(quote).not.toContain("<iframe");
    expect(html("1. one\n2. two")).toContain("<ol><li>one</li><li>two</li></ol>");
  });

  it("a long URL with no / or - still offers a break every 32 characters", () => {
    const run = "a".repeat(70);
    const out = html(`See https://example.com/${run}`);
    expect(out).toContain(`example.com/<wbr/>${"a".repeat(32)}<wbr/>${"a".repeat(32)}<wbr/>${"a".repeat(6)}</a>`);
  });

  it("a closed *word* is italic with its asterisks gone, live or saved", () => {
    for (const live of [false, true]) {
      const out = html("A *soft* word", live);
      expect(out).toContain("<em>soft</em>");
      expect(out).not.toContain("*");
    }
  });

  it("a code block names its language at the top left and its copy button sits at the top right, shown on hover or keyboard focus", () => {
    const css = readFileSync(new URL("../app/styles.css", import.meta.url), "utf8").replaceAll("\r\n", "\n");
    const out = html("```sh\necho hi\n```");
    expect(out).toMatch(/<div class="cb-h"><span class="cb-lang">sh<\/span><button[^>]*class="cb-copy"/);
    expect(rulesWith(css, ".md .cb-h").some((body) => body.includes("display:flex"))).toBe(true);
    expect(rulesWith(css, ".cb-copy").some((body) => body.includes("margin-left:auto") && body.includes("opacity:0"))).toBe(true);
    expect(rulesWith(css, ".md .cb:hover .cb-copy").some((body) => body.includes("opacity:1"))).toBe(true);
    expect(rulesWith(css, ".md .cb:focus-within .cb-copy").some((body) => body.includes("opacity:1"))).toBe(true);
  });
});
