// A test name (data-testid) names one control: a spec that asks for it reaches the control it means,
// never another that happens to share the name. A list's rows share their one written name, which
// is written once in the source; two places in the source that write the same name are two controls.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const src = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(at);
    return entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx") ? [at] : [];
  });
}

it("every test name written in the window's source is written in one place", () => {
  const places = new Map<string, string[]>();
  for (const file of sources(src)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      // the attribute as written on an element; a selector string ('[data-testid="…"]') only reads one
      for (const m of line.matchAll(/(?<!\[)data-testid="([^"]+)"/g)) {
        const name = m[1]!;
        places.set(name, [...places.get(name) ?? [], `${path.relative(src, file)}:${i + 1}`]);
      }
    });
  }
  const twice = Object.fromEntries([...places].filter(([, at]) => at.length > 1));
  expect(places.size, "the scan found the window's test names").toBeGreaterThan(100);
  expect(twice).toEqual({});
});
