import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { bundleSize, jsWithinBudget } from "./bundle-size.ts";

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
    css: kb("styles"),
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
  const spec = readFileSync(new URL("./e2e/perf.spec.ts", import.meta.url), "utf8");
  const number = (key: string) => {
    const value = spec.match(new RegExp(`${key}: ([0-9.]+)`))?.[1];
    if (value === undefined) throw new Error(`Missing ${key} in perf.spec.ts`);
    return Number(value);
  };
  const size = bundleSize(dist);
  expect(size.entryJs, "entry JS gzip KiB").toBeLessThan(number("entryJsGzipKb"));
  expect(size.totalJs, "total JS gzip KiB").toBeLessThan(number("totalJsGzipKb"));
  expect(size.css, "CSS gzip KiB").toBeLessThan(number("cssGzipKb"));
});
