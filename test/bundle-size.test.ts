import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { BUNDLE_BUDGET, assertBundleBudget, bundleSize, jsWithinBudget } from "./bundle-size.ts";

const dirs: string[] = [];
function build(html: string, assets: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), "bundle-size-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(path.join(dir, "index.html"), html);
  for (const [file, text] of Object.entries(assets)) writeFileSync(path.join(dir, "assets", file), text);
  return dir;
}
const kb = (text: string) => gzipSync(text).length / 1024;
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("counts entry plus HTML-preloaded JS once, while keeping lazy pages out of startup", () => {
  const assets = { "index-a.js": "chat", "shared.js": "react", "Settings.js": "settings", "first.js": "first run", "index-a.css": "styles" };
  const dist = build(`<script type="module" src="./assets/index-a.js"></script>
    <link rel="modulepreload" href="./assets/index-a.js">
    <link href='./assets/shared.js' crossorigin rel='modulepreload'>
    <link rel="modulepreload" href="./assets/shared.js">
    <link rel="preload" as="script" href="./assets/first.js">`, assets);
  expect(bundleSize(dist)).toEqual({
    entryJs: kb("chat") + kb("react") + kb("first run"),
    totalJs: kb("chat") + kb("react") + kb("first run") + kb("settings"),
    startupCss: 0,
    totalCss: kb("styles"),
  });
});

it("a missing preloaded asset fails loudly instead of silently lowering the entry measurement", () => {
  const dist = build('<link rel="modulepreload" href="./assets/missing.js">', { "index-a.js": "chat" });
  expect(() => bundleSize(dist)).toThrow(/missing\.js/);
});

it("includes JS outside the assets folder in the total ceiling", () => {
  const dist = build("", { "index-a.js": "chat" });
  writeFileSync(path.join(dist, "worker.js"), "worker");
  expect(bundleSize(dist)).toMatchObject({ entryJs: kb("chat"), totalJs: kb("chat") + kb("worker") });
});

it("both limits hold independently: entry growth and a total at or above 170 fail", () => {
  const budget = { entryJsGzipKb: 133.03, totalJsGzipKb: 170 };
  expect(jsWithinBudget({ entryJs: 131.02, totalJs: 147.10 }, budget)).toBe(true);
  expect(jsWithinBudget({ entryJs: 143.84, totalJs: 147.10 }, budget)).toBe(false);
  expect(jsWithinBudget({ entryJs: 131.02, totalJs: 170 }, budget)).toBe(false);
  expect(jsWithinBudget({ entryJs: 131.02, totalJs: 170.01 }, budget)).toBe(false);
});

it("rejects a real emitted JS total above 170 KiB while its entry still fits", () => {
  const dist = build("", { "index-a.js": "chat", "Settings.js": randomBytes(180 * 1024).toString("base64") });
  const size = bundleSize(dist);
  expect(size.entryJs).toBeLessThan(133.03);
  expect(size.totalJs).toBeGreaterThan(170);
  expect(jsWithinBudget(size, { entryJsGzipKb: 133.03, totalJsGzipKb: 170 })).toBe(false);
});

it.runIf(process.env["GATES_LOCAL_BUNDLE_DIST"] !== undefined)("uses the production budget to check a built bundle when explicitly requested", () => {
  const dist = process.env["GATES_LOCAL_BUNDLE_DIST"];
  if (dist === undefined) throw new Error("GATES_LOCAL_BUNDLE_DIST must name the production build");
  const size = bundleSize(dist);
  expect(() => assertBundleBudget(size)).not.toThrow();
});

it("accepts a fitting bundle and refuses each independent size limit, including nonfinite readings", () => {
  const size = { entryJs: 132, totalJs: 169, startupCss: 12.8, totalCss: 14.4 };
  expect(() => assertBundleBudget(size)).not.toThrow();
  for (const [key, limit] of [["entryJs", BUNDLE_BUDGET.entryJsGzipKb], ["totalJs", BUNDLE_BUDGET.totalJsGzipKb], ["startupCss", BUNDLE_BUDGET.startupCssGzipKb], ["totalCss", BUNDLE_BUDGET.totalCssGzipKb]] as const) {
    expect(() => assertBundleBudget({ ...size, [key]: limit })).toThrow(/Remove bytes/);
    expect(() => assertBundleBudget({ ...size, [key]: Number.NaN })).toThrow(/Remove bytes/);
  }
});

it("counts linked styles and style preloads once by HTML href, regardless of their filename", () => {
  const dist = build(`<link href='./assets/theme.css?v=1' rel='stylesheet'>
    <link rel=stylesheet href=./assets/theme.css?v=1#same-request>
    <link rel="preload" as="style" href="./assets/controls.css">`, {
    "index-a.js": "chat", "theme.css": "theme", "controls.css": "controls", "index-looking.css": "deferred",
  });
  expect(bundleSize(dist)).toMatchObject({
    startupCss: kb("theme") + kb("controls"),
    totalCss: kb("theme") + kb("controls") + kb("deferred"),
  });
});

it("counts distinct stylesheet query URLs as separate startup downloads", () => {
  const dist = build('<link rel="stylesheet" href="./assets/theme.css?v=1"><link rel="stylesheet" href="./assets/theme.css?v=2">', {
    "index-a.js": "chat", "theme.css": "theme",
  });
  expect(bundleSize(dist)).toMatchObject({ startupCss: 2 * kb("theme"), totalCss: kb("theme") });
});

it("fails on a missing linked stylesheet instead of counting an unstyled startup as smaller", () => {
  const dist = build('<link rel="stylesheet" href="./assets/missing.css">', { "index-a.js": "chat" });
  expect(() => bundleSize(dist)).toThrow(/missing\.css/);
});
