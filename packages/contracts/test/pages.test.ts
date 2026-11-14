import { describe, expect, it } from "vitest";
import { isPageDoc, mayBePage, pageBlocks, pageTitle } from "../src/pages.ts";

const DOC = "<!doctype html>\n<html><head><title>Loan calculator</title></head><body><p>hi</p></body></html>";
const reply = (code: string, close = true) => `Here it is.\n\n\`\`\`html\n${code}\n${close ? "```\n\nUse it." : ""}`;

describe("pageBlocks", () => {
  it("finds a closed document block with its offsets", () => {
    const text = reply(DOC);
    const [b] = pageBlocks(text);
    expect(b).toEqual({ code: DOC, closed: true, start: text.indexOf("```html"), end: text.indexOf("```\n\nUse") + 3 });
  });

  it("an html snippet that is not a document is code, not a page", () => {
    expect(pageBlocks(reply("<div>hello</div>"))).toEqual([]);
  });

  it("other languages are never pages", () => {
    expect(pageBlocks(`\`\`\`js\n${DOC}\n\`\`\``)).toEqual([]);
  });

  it("an open block is a page in the making while what has arrived can start a document", () => {
    expect(pageBlocks("```html\n")).toEqual([{ code: "", closed: false, start: 0, end: 8 }]);
    expect(pageBlocks("```html\n<!DOC")[0]?.closed).toBe(false);
    expect(pageBlocks("```html\n<div>")).toEqual([]);
  });

  it("reads several pages in one reply, in order", () => {
    const two = `${reply(DOC)}\n\n${reply(DOC.replace("Loan", "Tip"))}`;
    expect(pageBlocks(two).map((b) => pageTitle(b.code))).toEqual(["Loan calculator", "Tip calculator"]);
  });

  it("CRLF text keeps its offsets", () => {
    const text = reply(DOC).replaceAll("\n", "\r\n");
    const [b] = pageBlocks(text);
    expect(text.slice(b!.start, b!.end).startsWith("```html")).toBe(true);
    expect(text.slice(b!.start, b!.end).endsWith("```")).toBe(true);
  });
});

describe("isPageDoc and mayBePage", () => {
  it("a doctype or an html tag starts a document, in any case", () => {
    expect(isPageDoc("  <!DOCTYPE html>\n<html>")).toBe(true);
    expect(isPageDoc('<html lang="en">')).toBe(true);
    expect(isPageDoc("<body>")).toBe(false);
  });
  it("a prefix of a document's start may still become one", () => {
    expect(mayBePage("")).toBe(true);
    expect(mayBePage("<!do")).toBe(true);
    expect(mayBePage("<h")).toBe(true);
    expect(mayBePage("<p>")).toBe(false);
  });
});

describe("pageTitle", () => {
  it("is the title's text, entities decoded and spaces folded", () => {
    expect(pageTitle("<title>\n  Tips &amp; tricks &#8212; v2 </title>")).toBe("Tips & tricks — v2");
  });
  it("is Page without one", () => {
    expect(pageTitle("<html><body></body></html>")).toBe("Page");
    expect(pageTitle("<title>  </title>")).toBe("Page");
  });
});
