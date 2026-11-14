// The note under a refused send prints the words the server judged each offer with: it holds no verdict of its own.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, it, vi } from "vitest";
import { fitWords } from "@gates-local/contracts";
import type { FitOffer } from "@gates-local/contracts";

let RefusalNote: typeof import("../src/RefusalNote.tsx")["RefusalNote"];
beforeAll(async () => {
  vi.stubGlobal("window", {});
  RefusalNote = (await import("../src/RefusalNote.tsx")).RefusalNote;
  vi.unstubAllGlobals();
});

const GIB = 1024 ** 3;
const report = (verdict: "fits" | "spills") => ({ verdict, numCtx: 8192, needVramBytes: 9 * GIB, freeVramBytes: 8 * GIB, spillRamBytes: verdict === "spills" ? GIB : 0, source: "estimate" as const });
const short = { needBytes: 0, gpuBytes: 0, ramBytes: 0, shortBytes: 0 };
const note = (offer: FitOffer) => renderToStaticMarkup(createElement(RefusalNote, { o: { notice: "refused", model: "qwen3.5:9b", numCtx: 32768, offer } }));
const SLOWER = new RegExp(String.raw`<span[^>]*data-testid="chat\.composer\.offer-slower"[^>]*>`, "g");
const marks = (html: string) => [...html.matchAll(SLOWER)].map((m) => m[0]);

it.each([
  ["a GPU that spills", false, "Slower"],
  ["no supported GPU", true, "System memory"],
])("an offer that runs partly in system memory, on %s, is marked with the server's word for it", (_, cpu, word) => {
  const html = note({ short, context: { numCtx: 8192, verdict: "spills", words: fitWords(report("spills"), "now", cpu) } });
  const [mark, ...more] = marks(html);
  expect(more).toEqual([]);
  expect(mark).toContain(`data-tip="${word}"`);
  expect(mark).toContain(`aria-label="${word}"`);
});

it("an offer the server judged to run on the GPU carries no mark, whatever its verdict field says", () => {
  const html = note({ short, model: { model: "qwen3.5:4b", numCtx: 8192, verdict: "spills", words: fitWords(report("fits"), "now", false) } });
  expect(marks(html)).toEqual([]);
});

it("an offer sent with no words is not judged by the note", () => {
  const html = note({ short, context: { numCtx: 8192, verdict: "spills" } });
  expect(marks(html)).toEqual([]);
});
