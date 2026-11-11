import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { BUNDLE_BUDGET, bundleSizeWarnings, bundleSize } from "./bundle-size.ts";

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

it("includes JS outside the assets folder in the total", () => {
  const dist = build("", { "index-a.js": "chat" });
  writeFileSync(path.join(dist, "worker.js"), "worker");
  expect(bundleSize(dist)).toMatchObject({ entryJs: kb("chat"), totalJs: kb("chat") + kb("worker") });
});

it("reports a real emitted JS total over target while its entry still fits", () => {
  const dist = build("", { "index-a.js": "chat", "Settings.js": randomBytes(180 * 1024).toString("base64") });
  const size = bundleSize(dist);
  expect(size.entryJs).toBeLessThan(BUNDLE_BUDGET.entryJsGzipKb);
  expect(size.totalJs).toBeGreaterThan(BUNDLE_BUDGET.totalJsGzipKb);
  expect(bundleSizeWarnings(size)).toEqual([expect.stringMatching(/^Total JS: .* KiB over\.$/)]);
});

it("reports every over-target size without failing", () => {
  const size = { entryJs: 134.5, totalJs: 172.65, startupCss: 14, totalCss: 16 };
  const targets = { entryJsGzipKb: 133.5, totalJsGzipKb: 171.65, startupCssGzipKb: 13, totalCssGzipKb: 15 };
  expect(() => bundleSizeWarnings(size, targets)).not.toThrow();
  expect(bundleSizeWarnings(size, targets)).toEqual([
    "Entry JS (including HTML preloads): 134.500 KiB; target 133.5 KiB; 1.000 KiB over.",
    "Total JS: 172.650 KiB; target 171.65 KiB; 1.000 KiB over.",
    "Startup CSS (HTML stylesheets and style preloads): 14.000 KiB; target 13 KiB; 1.000 KiB over.",
    "Total CSS: 16.000 KiB; target 15 KiB; 1.000 KiB over.",
  ]);
});

it("reports each reached target, but still fails nonfinite measurements", () => {
  const size = { entryJs: 132, totalJs: 169, startupCss: 12.8, totalCss: 14.4 };
  expect(bundleSizeWarnings(size)).toEqual([]);
  for (const [key, limit] of [["entryJs", BUNDLE_BUDGET.entryJsGzipKb], ["totalJs", BUNDLE_BUDGET.totalJsGzipKb], ["startupCss", BUNDLE_BUDGET.startupCssGzipKb], ["totalCss", BUNDLE_BUDGET.totalCssGzipKb]] as const) {
    expect(bundleSizeWarnings({ ...size, [key]: limit })).toEqual([expect.stringContaining("0.000 KiB over.")]);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => bundleSizeWarnings({ ...size, [key]: value })).toThrow(/Cannot measure bundle size/);
    }
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

it("fails on a missing entry or a stylesheet without href", () => {
  expect(() => bundleSize(build("", { "lazy.js": "lazy" }))).toThrow(/no index-\*\.js entry/);
  expect(() => bundleSize(build('<link rel="stylesheet">', { "index-a.js": "chat" }))).toThrow(/without href/);
});
