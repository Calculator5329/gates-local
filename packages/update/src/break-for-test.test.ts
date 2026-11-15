// The switch that turns one guard of the update code off (break-for-test.ts)
// must stay out of reach of everything that is not a test. This reads every
// source file in the repository and fails when one that is not a test names
// the setter or the helper that calls it. It also keeps the list honest:
// every guard in it is read somewhere in the product, and some test turns it
// off and sees its rule fail.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BREAKS, breakForTest, brokenForTest } from "./break-for-test.ts";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const FOLDERS = ["apps", "packages", "scripts", "test", "lint"];
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const SKIPPED = new Set(["node_modules", "dist", "out", "build", "release", "coverage"]);

/** The two files that may name the setter: where it is, and the test helper that runs a rule with a guard off. */
const SWITCH = "packages/update/src/break-for-test.ts";
const HELPER = "packages/update/src/rules-testing.ts";

const isTest = (file: string) => /\.test\.[cm]?[jt]sx?$/.test(file);

function sources(): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || SKIPPED.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && SOURCE.test(entry.name)) found.set(path.relative(ROOT, full).split(path.sep).join("/"), readFileSync(full, "utf8"));
    }
  };
  for (const folder of FOLDERS) walk(path.join(ROOT, folder));
  return found;
}

/**
 * The files that could turn a guard off and are not tests: one that names the
 * setter, and one that takes in the helper that calls it. Only a test, or a
 * file whose name says it is for tests, may take in the helper.
 */
function reaches(files: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const [file, text] of files) {
    if (isTest(file) || file === SWITCH) continue;
    if (file !== HELPER && text.includes("breakForTest")) out.push(`${file} names breakForTest`);
    if (text.includes("rules-testing")) out.push(`${file} takes in the rule helper`);
  }
  return out.toSorted();
}

const files = sources();

describe("the switch that turns a guard off", () => {
  it("refuses outside the test runner, and nothing is switched off", () => {
    vi.stubEnv("VITEST", undefined);
    try {
      expect(() => breakForTest("go-back-over-edits")).toThrow("breakForTest is for tests only");
    } finally {
      vi.unstubAllEnvs();
    }
    expect(BREAKS.filter(name => brokenForTest(name))).toEqual([]);
  });

  it("turns one guard off at a time, and all back on", () => {
    try {
      breakForTest("go-back-over-edits");
      expect(BREAKS.filter(name => brokenForTest(name))).toEqual(["go-back-over-edits"]);
      breakForTest("deadline-read-once");
      expect(BREAKS.filter(name => brokenForTest(name))).toEqual(["deadline-read-once"]);
    } finally {
      breakForTest();
    }
    expect(BREAKS.filter(name => brokenForTest(name))).toEqual([]);
  });

  it("is named by no file that is not a test", () => {
    // The scan found the product: it is not passing over an empty list.
    expect(files.size).toBeGreaterThan(200);
    expect([...files.keys()]).toEqual(expect.arrayContaining([SWITCH, HELPER, "packages/update/src/apply.ts", "apps/desktop/src/main.ts", "apps/server/src/update/module.ts", "scripts/update.ts"]));
    expect(reaches(files)).toEqual([]);
  });

  it("the scan catches a product file that names the setter, or takes in the helper", () => {
    const planted = new Map(files);
    planted.set("apps/desktop/src/main.ts", `import { breakForTest } from "@gates-local/update/break-for-test";\nbreakForTest("go-back-over-edits");\n`);
    planted.set("apps/server/src/update/testing.ts", `export { rule } from "@gates-local/update/rules-testing";\n`);
    expect(reaches(planted)).toEqual(["apps/desktop/src/main.ts names breakForTest", "apps/server/src/update/testing.ts takes in the rule helper"]);
  });

  it("the setter reads nothing but the test runner's own mark: no flag, setting or file", () => {
    const text = files.get(SWITCH) ?? "";
    expect(text.match(/process\.env\[[^\]]+\]/g)).toEqual([`process.env["VITEST"]`]);
    expect(text).not.toMatch(/\bimport\b|\brequire\(|process\.argv/);
  });
});

describe("the list of guards", () => {
  const product = [...files].filter(([file]) => !isTest(file) && file !== SWITCH && file !== HELPER);
  const tests = [...files].filter(([file]) => isTest(file));

  it.each(BREAKS)("%s is read by the product, and a test turns it off", name => {
    const readBy = product.filter(([, text]) => text.includes(`brokenForTest("${name}")`)).map(([file]) => file);
    expect(readBy, "no product line asks about this guard").not.toEqual([]);
    const turnedOffBy = tests.filter(([, text]) => text.split("\n").some(line => line.includes("without:") && line.includes(`"${name}"`))).map(([file]) => file);
    expect(turnedOffBy, "no rule's test runs with this guard off").not.toEqual([]);
  });

  it("the product asks about no guard that is not in the list", () => {
    const asked = product.flatMap(([, text]) => [...text.matchAll(/brokenForTest\("([^"]+)"\)/g)].map(match => match[1] ?? ""));
    expect([...new Set(asked)].toSorted()).toEqual([...BREAKS].toSorted());
  });
});
