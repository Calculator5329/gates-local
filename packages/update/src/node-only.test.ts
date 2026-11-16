import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const SRC = import.meta.dirname;
const TEST_HELPERS = new Set(["testing.ts", "rules-testing.ts", "installed/testing.ts"]);
const IMPORT = /^\s*(?:import|export)\s+(?!type\s)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm;

function product(): Map<string, string> {
  const found = new Map<string, string>();
  for (const entry of readdirSync(SRC, { recursive: true, encoding: "utf8" })) {
    const file = entry.split(path.sep).join("/");
    if (!file.endsWith(".ts") || file.endsWith(".test.ts") || TEST_HELPERS.has(file)) continue;
    found.set(file, readFileSync(path.join(SRC, file), "utf8"));
  }
  return found;
}

function outsideImports(files: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const [file, text] of files) {
    for (const [, from = ""] of text.matchAll(IMPORT)) {
      if (!from.startsWith("node:") && !from.startsWith(".")) out.push(`${file} imports ${from}`);
    }
  }
  return out.toSorted();
}

it("the updater runs on Node built-ins and its own files, so it works while node_modules is replaced", () => {
  const files = product();
  expect([...files.keys()]).toEqual(expect.arrayContaining(["lock.ts", "transaction.ts", "apply.ts", "installed/copy.ts"]));
  expect(outsideImports(files)).toEqual([]);
});

it("the scan sees an import from a package, and lets a type-only one pass", () => {
  const planted = new Map([
    ["lock.ts", `import { Effect } from "effect";\nimport type { X } from "@gates-local/contracts";\nimport { readFileSync } from "node:fs";\n`],
    ["run.ts", `export { a } from "./a.ts";\nimport "some-polyfill";\n`],
  ]);
  expect(outsideImports(planted)).toEqual(["lock.ts imports effect", "run.ts imports some-polyfill"]);
});
