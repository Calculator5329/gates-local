// The shell's stylesheet rules the shared pieces in ui.tsx lean on, read as text.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, expect, it, vi } from "vitest";
import { PHONE, TurnSkel, VLabel } from "./ui.tsx";
import type { Verdict } from "../words/format.ts";

vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
afterAll(() => vi.unstubAllGlobals());
const { Timeline } = await import("../../thread/Thread.tsx");

interface Rule { readonly at: string; readonly selectors: readonly string[]; readonly body: string }

function parse(text: string, at = ""): Rule[] {
  const out: Rule[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    const prelude = text.slice(i, open).trim();
    if (prelude.startsWith("@")) {
      let depth = 1;
      let j = open + 1;
      for (; j < text.length && depth > 0; j++) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
      }
      out.push(...parse(text.slice(open + 1, j - 1), prelude));
      i = j;
    } else {
      const close = text.indexOf("}", open);
      out.push({ at, selectors: prelude.split(",").map((s) => s.trim()), body: text.slice(open + 1, close) });
      i = close + 1;
    }
  }
  return out;
}

const squash = (s: string) => s.replace(/\s+/g, "");
const sheet = parse(readFileSync(new URL("../../app/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""));
const phoneAt = `@media${squash(PHONE)}`;

const decl = (body: string, prop: string) => [...body.matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "g"))].at(-1)?.[1]?.trim();

function last(selector: string, prop: string, where: (at: string) => boolean): string | undefined {
  return sheet.filter((r) => where(squash(r.at)) && r.selectors.includes(selector) && decl(r.body, prop) !== undefined).map((r) => decl(r.body, prop)).at(-1);
}

const everywhere = (at: string) => at === "";
const onPhone = (at: string) => at === phoneAt;

it("popovers turn into bottom sheets at exactly the width the app calls a phone", () => {
  const sheetRule = sheet.find((r) => r.selectors.includes(".pop") && decl(r.body, "position") === "fixed" && decl(r.body, "inset")?.startsWith("auto 0 0") === true);
  expect(sheetRule).toBeDefined();
  expect(squash(sheetRule?.at ?? "")).toBe(phoneAt);
  expect(phoneAt).toBe("@media(max-width:640px)");
});

it("a placeholder block is as tall as the line of text it stands for", () => {
  expect(last(".skel", "height", everywhere)).toBe("1lh");
});

it("a conversation still loading shows a question on the right with a reply under it, and hides the placeholder from assistive tech", () => {
  const html = renderToStaticMarkup(createElement(TurnSkel));
  expect(html).toMatch(/^<div class="tl-skel"[^>]* aria-hidden="true"/);
  const turns = [...html.matchAll(/class="(tl-skel-[ua])"/g)].map((m) => m[1]);
  expect(turns.length).toBeGreaterThan(1);
  turns.forEach((t, i) => expect(t).toBe(i % 2 === 0 ? "tl-skel-u" : "tl-skel-a"));
  expect(last(".tl-skel-u", "display", everywhere)).toBe("flex");
  expect(last(".tl-skel-u", "justify-content", everywhere)).toBe("flex-end");
  expect(last(".tl-skel-a", "justify-content", everywhere)).toBeUndefined();
  expect(last(".tl-skel .skel", "display", everywhere)).toBe("block");
});

it("a conversation's timeline says it is busy while its turns are still being read", () => {
  const html = renderToStaticMarkup(createElement(Timeline, { threadId: "never-loaded" }));
  expect(html).toMatch(/^<div class="tl" aria-busy="true">/);
  expect(html).toContain('class="tl-skel"');
});

const VERDICTS = [["gpu", "green"], ["spill", "amber"], ["no", "red"]] as const;

it("the verdict label draws its dot and its words in the verdict's own colour", () => {
  for (const [k, colour] of VERDICTS) {
    const html = renderToStaticMarkup(createElement(VLabel, { v: { k, word: "Words" } as Verdict }));
    expect(html).toBe(`<span class="vl ${k}"><span class="vd ${k}"></span>Words</span>`);
    expect(last(`.vd.${k}`, "background", everywhere), k).toBe(`var(--${colour})`);
    expect(last(`.vl.${k}`, "color", everywhere) ?? last(".vl", "color", everywhere), k).toBe(`var(--${colour}-fg)`);
  }
  expect(last(".vl .vd", "background", everywhere)).toBeUndefined();
});

it("a bottom sheet's title row is hidden off a phone and shown on one", () => {
  expect(last(".sh-h", "display", everywhere)).toBe("none");
  expect(sheet.filter((r) => r.at !== "" && squash(r.at) !== phoneAt && r.selectors.includes(".sh-h") && decl(r.body, "display") !== undefined)).toEqual([]);
  expect(last(".sh-h", "display", onPhone)).toBe("flex");
});
