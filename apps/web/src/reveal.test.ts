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

  it("past the hold limit, a paragraph with no line break shows its last complete word", () => {
    const words = "x ".repeat(1100);
    expect(live(words)).toBe(words);
    expect(live(`${words}hal`)).toBe(words);
    expect(live(`${words}half `)).toBe(`${words}half `);
    // under the limit the same paragraph stays held
    expect(live("x ".repeat(900))).toBe("");
  });

  it("past the hold limit, a paragraph with no line break shows its last complete sentence, growing as text arrives", () => {
    const sentence = `${"word ".repeat(419)}end.`;
    expect(sentence.length).toBeGreaterThan(2090);
    // one sentence still arriving: its complete words show
    const a = live(sentence.slice(0, 2050));
    const b = live(sentence.slice(0, 2090));
    expect(a.length).toBeGreaterThan(2000);
    expect(b.length).toBeGreaterThan(a.length);
    expect(sentence.startsWith(b)).toBe(true);
    // a sentence end beats the words after it
    expect(live(`${sentence} Next one is com`)).toBe(sentence);
    expect(live(`${sentence} Next one is done! Then`)).toBe(`${sentence} Next one is done!`);
    // one character at a time across the limit, the reveal only grows
    const text = `${sentence} Next one is done! Then\nmore\n\nAfter`;
    let shown = "";
    for (let n = 1900; n <= text.length; n++) {
      const now = live(text.slice(0, n));
      expect(now.startsWith(shown), `shrank at ${n}`).toBe(true);
      shown = now;
    }
    expect(shown).toBe(`${sentence} Next one is done! Then\nmore\n`);
  });

  it("never shrinks: every one-character split of a mixed reply reveals a growing prefix", () => {
    const fence = "```";
    const replies = [
      // a table right under its paragraph, with no blank line between
      `Here is how they compare.\n| Model | Size |\n| :--- | ---: |\n| Gemma | 8.1 GB |\n\n${fence}sh\nollama list\n${fence}\n\n- One\n- Two\n  more of two\n\nDone.\n`,
      `Intro.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\nAfter the table.\n\n1. First\n2. Second\n${fence}\nx\n${fence}\nEnd`,
    ];
    for (const text of replies) {
      const final = live(text);
      let shown = "";
      for (let n = 0; n <= text.length; n++) {
        const now = live(text.slice(0, n));
        expect(now.startsWith(shown), `shrank at ${JSON.stringify(text.slice(0, n))}`).toBe(true);
        expect(final.startsWith(now)).toBe(true);
        shown = now;
      }
      expect(reveal(text, false).startsWith(final)).toBe(true);
    }
  });

  it("never shrinks past the hold limit, whatever the long block turns into", () => {
    const words = "word ".repeat(410);
    const replies = [
      // the header showed through the safety valve, then its separator made it a table
      `${words}\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nAfter`,
      // a complete line with a bar that turns out not to be a header
      `${words}\n| a | b |\nplain words\n\nAfter`,
      `${words}\n| a | b |\n-- then words\n\nAfter`,
      // one very long line with a bar, then a separator
      `${"word | ".repeat(320)}\n| --- | --- |\n| 1 | 2 |\n\nAfter`,
      `Intro\n\n${"word | ".repeat(320)}\n| --- | --- |\n`,
      // a short line with a bar, then one very long line
      `| a | b |\n${words}\n\nAfter`,
      // runs with no spaces, alone and after other text
      `${"x".repeat(2100)} then words. More\n\nAfter`,
      `Short. ${"x".repeat(2100)}\n\nAfter`,
      `Line\n${"x".repeat(2100)}\nmore`,
      `> quote\n${"x".repeat(2100)}\n\nAfter`,
      `${words}\r\n| a | b |\r\n| --- | --- |\r\n\r\nAfter`,
    ];
    for (const text of replies) {
      let shown = "";
      for (let n = 0; n <= text.length; n++) {
        const now = live(text.slice(0, n));
        expect(now.startsWith(shown), `shrank from ${shown.length} to ${now.length} at ${n}, ending ${JSON.stringify(text.slice(Math.max(0, n - 20), n))}`).toBe(true);
        shown = now;
      }
    }
  });

  it("holds a line with a bar back until the next line says whether it is a table header", () => {
    const words = "word ".repeat(410);
    const header = `${words}\n| a | b |\n`;
    expect(live(header)).toBe(`${words}\n`);
    expect(live(`${header}| --- `)).toBe(`${words}\n`);
    expect(live(`${header}| --- | --- |\n`)).toBe(`${words}\n`);
    expect(live(`${header}plain`)).toBe(header);
  });

  it("a run with no spaces past the hold limit shows as it grows", () => {
    const run = "x".repeat(HOLD_LIMIT + 100);
    expect(live(run)).toBe(run);
    expect(live(`${run}xx`)).toBe(`${run}xx`);
    expect(live("x".repeat(HOLD_LIMIT))).toBe("");
  });

  it("a run past the hold limit shows even after a sentence or a line that came first", () => {
    const run = "x".repeat(HOLD_LIMIT + 100);
    expect(live(`Short. ${run}`)).toBe(`Short. ${run}`);
    expect(live(`Line\n${run}`)).toBe(`Line\n${run}`);
  });

  it("shows all the text once the stream has ended", () => {
    for (const text of ["Here is a plain", "```sh\nunclosed", "- a\n- b", "| a | b |\n| --- | --- |\n| 1 | 2 |", "## Head", ""]) expect(reveal(text, false)).toBe(text);
  });

  it("shows nothing before the first finished block", () => {
    expect(live("")).toBe("");
    expect(live("\n\n")).toBe("");
  });
});
