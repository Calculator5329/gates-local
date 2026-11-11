// Owner ruling 2026-11-09, "we need icons for the makers": every maker the
// curated catalog names gets its own mark, never the "?" fallback or another
// maker's mark.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CURATED_MODELS } from "../../server/src/runtime/recommended.ts";
import { MakerMark } from "../src/MakerMark.tsx";
import { makerOf } from "../src/picker-models.ts";

const mark = (tag: string) => renderToStaticMarkup(createElement(MakerMark, { tag }));
const FALLBACK = mark("some-unknown-model:1b");
const makers = [...new Set(CURATED_MODELS.map(m => makerOf(m.name)))];

it("the catalog names known makers only", () => {
  expect(makers).not.toContain("Other");
  expect(FALLBACK).toContain(">?</span>");
});

it.each(CURATED_MODELS.map(m => [m.name, makerOf(m.name)] as const))("%s shows the %s mark", (name) => {
  const html = mark(name);
  expect(html).toContain("<svg");
  expect(html).not.toBe(FALLBACK);
});

it("no two makers share a mark", () => {
  const byMaker = new Map(makers.map(maker => [maker, mark(CURATED_MODELS.find(m => makerOf(m.name) === maker)!.name)]));
  expect(new Set(byMaker.values()).size).toBe(makers.length);
});
