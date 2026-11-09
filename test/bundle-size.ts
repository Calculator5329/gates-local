import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

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
