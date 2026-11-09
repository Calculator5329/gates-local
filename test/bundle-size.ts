import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

export const BUNDLE_BUDGET = { entryJsGzipKb: 133.03, totalJsGzipKb: 170, cssGzipKb: 13 };

/** Size alone blocks a build. Report every overage so one fix need not hide another. */
export function assertBundleBudget(size: ReturnType<typeof bundleSize>, budget = BUNDLE_BUDGET): void {
  const checks = [
    ["Entry JS (including HTML preloads)", size.entryJs, budget.entryJsGzipKb],
    ["Total JS", size.totalJs, budget.totalJsGzipKb],
    ["CSS", size.css, budget.cssGzipKb],
  ] as const;
  const failures = checks.filter(([, value, limit]) => !Number.isFinite(value) || value >= limit);
  if (failures.length) throw new Error(`Bundle exceeds its gzip budget:\n${failures.map(([name, value, limit]) => `${name}: ${value.toFixed(3)} KiB; must be below ${limit} KiB. Remove bytes before rebuilding.`).join("\n")}`);
}

/** Gzip each emitted asset separately, as it is transferred to a cold client. */
export function bundleSize(dist: string) {
  const sizes = readdirSync(dist, { recursive: true, encoding: "utf8" }).filter((file) => /\.(js|css)$/.test(file))
    .map((file) => ({ file, kb: gzipSync(readFileSync(path.join(dist, file))).length / 1024 }));
  const totalJs = sizes.filter(({ file }) => file.endsWith(".js")).reduce((sum, { kb }) => sum + kb, 0);
  const entry = new Set(sizes.filter(({ file }) => /^index-.*\.js$/.test(path.basename(file))).map(({ file }) => path.join(dist, file)));
  if (entry.size === 0) throw new Error("Build has no index-*.js entry");
  const html = readFileSync(path.join(dist, "index.html"), "utf8");
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = new Map([...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
      .map(([, key, double, single, bare]) => [key!.toLowerCase(), double ?? single ?? bare ?? ""]));
    const rel = attrs.get("rel")?.toLowerCase().split(/\s+/) ?? [];
    if (!rel.includes("modulepreload") && !(rel.includes("preload") && attrs.get("as") === "script")) continue;
    const href = attrs.get("href");
    if (href === undefined) throw new Error("Build contains a script preload without href");
    const file = new URL(href, "https://bundle.invalid/").pathname.slice(1);
    if (file.endsWith(".js")) entry.add(path.join(dist, file));
  }
  return {
    entryJs: [...entry].reduce((sum, file) => sum + gzipSync(readFileSync(file)).length / 1024, 0),
    totalJs,
    css: sizes.filter(({ file }) => file.endsWith(".css")).reduce((sum, { kb }) => sum + kb, 0),
  };
}

export function jsWithinBudget(size: { entryJs: number; totalJs: number }, budget: { entryJsGzipKb: number; totalJsGzipKb: number }) {
  return size.entryJs < budget.entryJsGzipKb && size.totalJs < budget.totalJsGzipKb;
}
