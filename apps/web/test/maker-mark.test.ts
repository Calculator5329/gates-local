// Owner ruling 2026-11-09, "we need icons for the makers": every maker the
// curated catalog names gets its own mark, never the "?" fallback or another
// maker's mark.
import { CHAT_MODELS, suggestedList } from "@gates-local/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { curatedModels } from "../../server/src/runtime/recommended.ts";
import { MakerMark } from "../src/MakerMark.tsx";
import { makerOf } from "../src/picker-models.ts";
import { setState } from "../src/store.ts";

// The marks group by the list the server sends; seed the built-in one.
setState({ suggested: suggestedList(CHAT_MODELS) });
const rules = CHAT_MODELS.makers;
const mark = (tag: string) => renderToStaticMarkup(createElement(MakerMark, { tag }));
const FALLBACK = mark("some-unknown-model:1b");
const curated = curatedModels();
const makers = [...new Set(curated.map(m => makerOf(m.name, rules)))];

it("the catalog names known makers only", () => {
  expect(makers).not.toContain("Other");
  expect(FALLBACK).toContain(">?</span>");
});

it.each(curated.map(m => [m.name, makerOf(m.name, rules)] as const))("%s shows the %s mark", (name) => {
  const html = mark(name);
  expect(html).toContain("<svg");
  expect(html).not.toBe(FALLBACK);
});

it("no two makers share a mark", () => {
  const byMaker = new Map(makers.map(maker => [maker, mark(curated.find(m => makerOf(m.name, rules) === maker)!.name)]));
  expect(new Set(byMaker.values()).size).toBe(makers.length);
});
