// Usage's one tip: a model name cut by its row reads in full in a cut-name tip
// (data-tipt), whose anchor holds the `.t` the tooltip measures. A data-tipt
// with nothing to measure never opens (ui.tsx). Figures have no tip.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { UsageRead } from "../src/usage-data.ts";

const HOUR = 3_600_000;
const now = Date.now();
const read: UsageRead = {
  models: ["qwen3.5:9b"],
  rows: [{ hour: Math.floor(now / HOUR) * HOUR - HOUR, model: "qwen3.5:9b", promptTokens: 12_345, completionTokens: 6789, replies: 3, decodeMs: 2000, decodeTokens: 100, readMs: 1000, readTokens: 2000, wallMs: 4000 }],
};
vi.mock("../src/session.ts", () => ({ closeUsage: vi.fn(), usageData: { subscribe: () => () => undefined, get: () => ({ read }) } }));

it("a figure has no tip (decision 19), and the cut-name tip has the .t it measures", async () => {
  const { Usage } = await import("../src/Usage.tsx");
  const html = renderToStaticMarkup(createElement(Usage));
  // the only plain tip left is the close button's name
  expect([...html.matchAll(/<(\w+)[^>]*\sdata-tip="([^"]*)"/g)].map(m => `${m[1]} ${m[2]}`)).toEqual(["button Close · Esc"]);
  expect(html).toContain('<div class="us-num"><b>19.1k</b>');
  expect(html).toContain('<div class="us-num"><b>3</b><span>replies</span>');
  // decision 17: Usage sits in the same centred column as Models (panel.css .dlg-body>.us)
  expect(html).toMatch(/<div class="dlg-body"><div class="us">/);
  // a data-tipt anchor with no .t inside never opens its tip
  const tipts = [...html.matchAll(/<(\w+)[^>]*data-tipt="[^"]*"[^>]*>(.*?)<\/\1>/g)];
  expect(tipts.length).toBeGreaterThan(0);
  for (const [anchor, , inner] of tipts) expect(inner, anchor).toMatch(/class="[^"]*\bt\b[^"]*"/);
});
