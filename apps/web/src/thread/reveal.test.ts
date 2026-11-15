import { describe, expect, it } from "vitest";
import { reveal } from "./reveal.ts";

describe("paced Markdown structure", () => {
  it.each([
    "Use A | B for piping.\nContinue with ordinary prose.",
    "| Model | Size |\n| --- | --- |\n| Small | 2 |\n\nNext",
    "Use A | B\n-- | --\n1 | 2\n\nNext",
    "Use A | B\n-- nope\n\nNext",
    "## Heading\n\nUse A | B.\n\n```sh\necho '| literal'\n```\n\nNext",
  ])("never takes back a revealed prefix: %s", (reply) => {
    let previous = "";
    for (let i = 1; i <= reply.length; i++) {
      const next = reveal(reply.slice(0, i), true);
      expect(next.startsWith(previous), `prefix ${JSON.stringify(reply.slice(0, i))} retracted ${JSON.stringify(previous)}`).toBe(true);
      previous = next;
    }
    expect(reveal(reply, false)).toBe(reply);
  });

  it("keeps prose visible while holding only an unproven delimiter", () => {
    expect(reveal("Use A", true)).toBe("Use A");
    expect(reveal("Use A |", true)).toBe("Use A |");
    expect(reveal("Use A | B\n-- | -", true)).toBe("Use A | B\n");
    expect(reveal("Use A | B\n-- | --\n", true)).toBe("Use A | B\n-- | --\n");
  });
  it("releases a literal pipe line as soon as its next line disproves a table", () => {
    for (const next of ["O", "Ordinary next line.", "-- nope", "-:"]) {
      const text = `| literal bar line |\n${next}`;
      expect(reveal(text, true)).toBe(text);
    }
    const text = "| literal bar line |\nOrdinary next line.\n\nLater content";
    expect(reveal(text, true)).toBe(text);
    expect(reveal("| literal bar line |\n- |", true)).toBe("| literal bar line |\n- |");
  });

  it("keeps pipe-less headers visible, holding only a possible delimiter row", () => {
    for (const tail of ["", "-", "--", "-- | -"]) expect(reveal(`A | B\n${tail}`, true)).toBe("A | B\n");
    for (const tail of ["O", "-- x", "\nNext"]) {
      const text = `A | B\n${tail}`;
      expect(reveal(text, true)).toBe(text);
    }
    const text = "A | B\n-- | --\n1 | 2\n\nNext";
    expect(reveal(text, true)).toBe(text);
  });
  it("shows partial prose without waiting for a paragraph", () => {
    expect(reveal("Start with a plain", true)).toBe("Start with a plain");
    expect(reveal("## A heading\n\nStart with", true)).toBe("## A heading\n\nStart with");
  });

  it("holds incomplete block markers and fence language", () => {
    for (const marker of ["#", "##", "`", "``", "```sh", "-", "1."]) expect(reveal(marker, true)).toBe("");
    expect(reveal("```sh\nprintf hello", true)).toBe("```sh\nprintf hello");
    expect(reveal("```sh\nprintf hello\n``", true)).toBe("```sh\nprintf hello\n");
  });

  it("reveals a table once its delimiter row completes, without hiding its header", () => {
    const header = "| Model | Size |\n| --- | --- |\n";
    expect(reveal("| Model | Size |", true)).toBe("| Model | Size |");
    expect(reveal("| Model | Size |\n| --- | --", true)).toBe("| Model | Size |\n");
    expect(reveal(header + "| Qwen | 6", true)).toBe(header + "| Qwen | 6");
    expect(reveal(header + "| Qwen | 6 |\n", true)).toBe(header + "| Qwen | 6 |\n");
    expect(reveal(header + "| Qwen | 6 |\n\nNext", true)).toBe(header + "| Qwen | 6 |\n\nNext");
  });

  it("preserves literal bars and asterisks inside fenced code, and the entire terminal text", () => {
    const code = "```sh\necho '* | text'";
    expect(reveal(code, true)).toBe(code);
    for (const text of ["#", "```sh", "| partial", "plain"]) expect(reveal(text, false)).toBe(text);
  });
});
