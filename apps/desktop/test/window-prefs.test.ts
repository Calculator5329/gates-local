// The window's webPreferences, read from main.ts (it imports Electron, so it
// is never loaded in a unit test). Spellcheck stays off: Electron's default
// is on, and on Linux it downloads Hunspell dictionaries from a Google host
// (redirector.gvt1.com) when one is missing. The README's privacy list
// depends on this.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "main.ts");

/** The body of the one `webPreferences: { ... }` literal in main.ts, comments removed. */
function webPreferences(): string {
  const source = readFileSync(MAIN, "utf8");
  const blocks = [...source.matchAll(/webPreferences:\s*\{([^{}]*)\}/g)];
  expect(blocks).toHaveLength(1);
  return blocks[0]![1]!.replace(/\/\/.*$/gm, "");
}

describe("the desktop window", () => {
  it("turns Electron's spellchecker off, so no dictionary is downloaded", () => {
    expect(webPreferences()).toMatch(/(^|[\s,])spellcheck:\s*false\s*,/m);
  });

  it("keeps the renderer sandboxed and isolated", () => {
    const prefs = webPreferences();
    expect(prefs).toMatch(/\bsandbox:\s*true\b/);
    expect(prefs).toMatch(/\bcontextIsolation:\s*true\b/);
    expect(prefs).toMatch(/\bnodeIntegration:\s*false\b/);
  });
});
