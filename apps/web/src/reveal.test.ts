import { describe, expect, it } from "vitest";
import { HOLD_LIMIT, reveal } from "./reveal.ts";

const live = (text: string) => reveal(text, true);

describe("reveal while streaming: whole blocks only", () => {
  it("holds a paragraph until its blank line", () => {
    expect(live("Here is a plain")).toBe("");
    expect(live("Here is a plain answer.\nIt goes on")).toBe("");
    expect(live("Here is a plain answer.\n")).toBe("");
    expect(live("Here is a plain answer.\n\nNext")).toBe("Here is a plain answer.\n");
  });

  it("ends a paragraph where a heading, list, fence or table starts on the next line", () => {
    expect(live("Run this:\n```")).toBe("Run this:\n");
    expect(live("Steps:\n- Open")).toBe("Steps:\n");
    expect(live("Steps:\n-")).toBe("");
    expect(live("Intro\n## Steps")).toBe("Intro\n");
  });

  it("shows a heading at its newline", () => {
    expect(live("## Ste")).toBe("");
    expect(live("## Steps")).toBe("");
    expect(live("## Steps\n")).toBe("## Steps\n");
    expect(live("## Steps\nOpen the")).toBe("## Steps\n");
  });

  it("shows a list item once the next item or a blank line starts", () => {
    expect(live("- Open a terminal")).toBe("");
    expect(live("- Open a terminal\n")).toBe("");
    expect(live("- Open a terminal\n-")).toBe("- Open a terminal\n");
    expect(live("- Open a terminal\n- Run the")).toBe("- Open a terminal\n");
    expect(live("1. One\n2. Two\n3. Thr")).toBe("1. One\n2. Two\n");
    expect(live("- One\n- Two\n\nAfter")).toBe("- One\n- Two\n");
  });

  it("keeps an item's indented continuation with it", () => {
    expect(live("- One\n  more of one\n- Two")).toBe("- One\n  more of one\n");
    expect(live("- One\n  more of")).toBe("");
  });

  it("shows a fenced code block only at its closing fence; nothing inside an unclosed fence", () => {
    expect(live("```sh\ndf -h /\ndu -sh")).toBe("");
    expect(live("```sh\ndf -h /\n```")).toBe("");
    expect(live("```sh\ndf -h /\n```\n")).toBe("```sh\ndf -h /\n```\n");
    expect(live("Intro\n\n```sh\n\nnot a paragraph\n\n")).toBe("Intro\n");
  });

  it("shows a table at its blank line", () => {
    const t = "| Model | Size |\n| --- | --- |\n| Gemma | 8.1 GB |\n";
    expect(live("| Model | Size |\n| --- |")).toBe("");
    expect(live(t)).toBe("");
    expect(live(`${t}| Qwen | 6.6 GB |`)).toBe("");
    expect(live(`${t}\n`)).toBe(t);
    expect(live(`${t}\nAfter`)).toBe(t);
  });

  it("shows a quote at its blank line", () => {
    expect(live("> a note\n> more")).toBe("");
    expect(live("> a note\n> more\n\n")).toBe("> a note\n> more\n");
  });

  it("returns a prefix of finished blocks across a mixed reply", () => {
    const text = "Intro line.\n\n## Steps\n\n- One\n- Two\n\n```sh\nls\n```\n\nThe end is ne";
    expect(live(text)).toBe("Intro line.\n\n## Steps\n\n- One\n- Two\n\n```sh\nls\n```\n");
    expect(text.startsWith(live(text))).toBe(true);
  });

  it("treats CRLF like LF and returns a prefix of the original text", () => {
    expect(live("Para one.\r\n\r\nPara two")).toBe("Para one.\r\n");
    expect(live("## Head\r\n")).toBe("## Head\r\n");
    expect(live("```\r\ncode\r\n```\r\nx")).toBe("```\r\ncode\r\n```\r\n");
    expect(live("- a\r\n- b")).toBe("- a\r\n");
  });

  it("shows the complete lines of an unfinished block past the hold limit", () => {
    const line = `${"x".repeat(99)}\n`;
    const body = line.repeat(Math.ceil(HOLD_LIMIT / line.length) + 1);
    const text = `Intro\n\n\`\`\`\n${body}half a li`;
    expect(text.length - "Intro\n\n".length).toBeGreaterThan(HOLD_LIMIT);
    expect(live(text)).toBe(`Intro\n\n\`\`\`\n${body}`);
    // under the limit the same block stays held
    expect(live(`Intro\n\n\`\`\`\n${line.repeat(3)}half`)).toBe("Intro\n");
  });

  it("shows all the text once the stream has ended", () => {
    for (const text of ["Here is a plain", "```sh\nunclosed", "- a\n- b", "| a | b |\n| --- | --- |\n| 1 | 2 |", "## Head", ""]) expect(reveal(text, false)).toBe(text);
  });

  it("shows nothing before the first finished block", () => {
    expect(live("")).toBe("");
    expect(live("\n\n")).toBe("");
  });
});
