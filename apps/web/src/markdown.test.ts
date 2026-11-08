// Links in a reply: a bare URL is a link, and a long one can wrap only at its separators.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./markdown.tsx";

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe("links", () => {
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
