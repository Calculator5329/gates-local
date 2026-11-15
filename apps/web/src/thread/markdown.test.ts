// Links in a reply: a bare URL is a link, and a long one can wrap only at its separators.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
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
