// The load ring around Send and the download bar on the model button: what LoadBar.tsx draws and what
// the stylesheet does with it, read as text.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { DownloadBar, LoadRing } from "./LoadBar.tsx";

const css = readFileSync(new URL("../app/styles.css", import.meta.url), "utf8");
const ruleOf = (selector: string) => css.match(new RegExp(String.raw`(?:^|\})${selector.replaceAll(".", String.raw`\.`)}\{([^}]*)\}`, "m"))?.[1] ?? "";
const ring = (since: number | undefined, ms: number | undefined, ask = false) => renderToStaticMarkup(createElement(LoadRing, { since, ms, ask }));
const delayOf = (html: string) => html.match(/animation-delay:(-?\d+)ms/)?.[1];
const bar = (pct: number) => renderToStaticMarkup(createElement(DownloadBar, { pct })).match(/transform:(scaleX\([^)]*\))/)?.[1];

afterEach(() => { vi.restoreAllMocks(); });

it("a model loaded here before fills the ring to 90% over its last load and holds there until the ring goes", () => {
  const html = ring(undefined, 4200);
  expect(html).toMatch(/<circle class="ldring-f"[^>]*pathLength="100"/);
  expect(html).toMatch(/animation-duration:4200ms/);
  const keyframes = css.match(/@keyframes ldfill\{from\{stroke-dashoffset:(\d+)\}to\{stroke-dashoffset:(\d+)\}\}/);
  expect(Number(keyframes?.[1]), "it starts empty").toBe(100);
  expect(100 - Number(keyframes?.[2]), "it ends at 90% of the ring").toBe(90);
  const fill = ruleOf(".ldring-f");
  expect(fill).toMatch(/stroke-dasharray:100;/);
  expect(fill, "the end of the fill is held").toMatch(/animation:ldfill linear both/);
});

it("a ring for a load that started before it mounted starts that far into its fill, and one that started here starts at the beginning", () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
  expect(delayOf(ring(7_500, 4_000))).toBe("-2500");
  expect(delayOf(ring(undefined, 4_000)), "a load this client never saw start").toBe("0");
  expect(delayOf(ring(10_200, 4_000)), "a start a moment ahead of this clock").toBe("0");
  now.mockReturnValue(11_000);
  expect(delayOf(ring(7_500, 4_000)), "mounted again a second later").toBe("-3500");
});

it("the ring a send turns while it asks the server what it would stop stays unseen for the first 300 ms, then fades in", () => {
  expect(ring(undefined, undefined, true)).toMatch(/<svg class="ldring wait ask"/);
  expect(ring(undefined, undefined, false)).toMatch(/<svg class="ldring wait"/);
  expect(ruleOf(".ldring.wait.ask")).toMatch(/^opacity:0;/);
  const asks = [...css.matchAll(/\.ldring\.wait\.ask\{([^}]*)\}/g)].map((m) => m[1]);
  expect(asks.length).toBeGreaterThan(0);
  for (const rule of asks) expect(rule).toMatch(/fadein \.12s linear \.3s forwards/);
  expect(css).toMatch(/@keyframes fadein\{from\{opacity:0\}to\{opacity:1\}\}/);
});

it("the download bar is a 2 px line on the model button's bottom edge, filled from the left to its percent", () => {
  expect(bar(37)).toBe("scaleX(0.37)");
  expect(bar(0)).toBe("scaleX(0)");
  expect(bar(100)).toBe("scaleX(1)");
  expect(bar(140), "never past full").toBe("scaleX(1)");
  expect(bar(-5), "never below empty").toBe("scaleX(0)");
  const line = ruleOf(".ldbar");
  for (const part of ["position:absolute", "left:0", "bottom:0", "width:100%", "height:2px", "transform-origin:left"]) expect(line).toContain(part);
  expect(ruleOf("#modelBtn")).toMatch(/position:relative/);
});
