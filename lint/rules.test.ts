import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { configuredRules, findings, type Finding } from "./ratchet.ts";

/** File text by repo path. */
type Files = Record<string, string>;
/** One mistake a rule exists to stop, and the same code written the way the rule asks. */
type Case = { rule: string; planted: Files; fixed: Files };

const text = (...lines: string[]) => `${lines.join("\n")}\n`;

const PORT = { "apps/server/src/port.ts": text("export const port = 4310;") };
const TYPES = { "apps/server/src/types.ts": text("export type Port = number;") };

/** A factory with a guard and the test-only switch that leaves the guard out. */
const DOOR = [
  'type DoorOptions = { faultForTest?: "left-open" };',
  'const createDoor = (options: DoorOptions = {}) => ({ shut: () => options.faultForTest !== "left-open" });',
];

const CASES: Case[] = [
  {
    rule: "gates/no-relative-import-across-packages",
    planted: { ...PORT, "apps/web/src/cross.ts": text('import { port } from "../../server/src/port.ts";', "export const where = port;") },
    fixed: { ...PORT, "apps/web/src/cross.ts": text('import { port } from "@gates-local/contracts";', "export const where = port;") },
  },
  {
    rule: "gates/closed-package",
    planted: { "packages/contracts/src/closed.ts": text('import { readFileSync } from "node:fs";', "export const read = readFileSync;") },
    fixed: { "packages/contracts/src/closed.ts": text('import { Schema } from "effect";', "export const Name = Schema.String;") },
  },
  {
    rule: "gates/effect-needs-reason",
    planted: {
      "apps/web/src/Title.tsx": text(
        'import { useEffect } from "react";',
        "export function Title({ title }: { title: string }) {",
        "  useEffect(() => { document.title = title; }, [title]);",
        "  return null;",
        "}",
      ),
    },
    fixed: {
      "apps/web/src/Title.tsx": text(
        'import { useEffect } from "react";',
        "export function Title({ title }: { title: string }) {",
        "  // oxlint-disable-next-line gates/effect-needs-reason -- keeps the tab title, which lives outside React, in step with the open chat",
        "  useEffect(() => { document.title = title; }, [title]);",
        "  return null;",
        "}",
      ),
    },
  },
  {
    rule: "gates/timer-needs-reason",
    planted: { "apps/web/src/later.ts": text("export function later(run: () => void) {", "  return window.setTimeout(run, 50);", "}") },
    fixed: {
      "apps/web/src/later.ts": text(
        "export function later(run: () => void) {",
        "  // oxlint-disable-next-line gates/timer-needs-reason -- a debounce: the search runs once typing has paused for 150 ms",
        "  return window.setTimeout(run, 150);",
        "}",
      ),
    },
  },
  {
    rule: "gates/no-wait-for-timeout",
    planted: {
      "test/e2e/wait.spec.ts": text(
        'import { test } from "@playwright/test";',
        'test("the reply shows", async ({ page }) => {',
        "  await page.waitForTimeout(500);",
        "});",
      ),
      "test/e2e/quiet.spec.ts": text(
        'import { test } from "@playwright/test";',
        'test("no tooltip comes up", async ({ page }) => {',
        "  // oxlint-disable-next-line gates/no-wait-for-timeout -- longer than the tooltip's delay",
        "  await page.waitForTimeout(800);",
        "});",
      ),
    },
    fixed: {
      "test/e2e/wait.spec.ts": text(
        'import { expect, test } from "@playwright/test";',
        'test("the reply shows", async ({ page }) => {',
        '  await expect(page.getByTestId("reply")).toBeVisible();',
        "});",
      ),
      "test/e2e/quiet.spec.ts": text(
        'import { test } from "@playwright/test";',
        'import { holds } from "./waits.ts";',
        'test("no tooltip comes up", async ({ page }) => {',
        '  await holds(page, 800, () => page.locator("#tip.open").count(), 0);',
        "});",
      ),
    },
  },
  {
    rule: "gates/test-switch-stays-in-tests",
    planted: {
      "apps/server/src/door.ts": text(
        ...DOOR,
        'export const door = createDoor({ faultForTest: "left-open" });',
      ),
      "apps/server/src/latch.ts": text(
        ...DOOR,
        "// oxlint-disable-next-line gates/test-switch-stays-in-tests -- only while this is tried out",
        'export const door = createDoor({ faultForTest: "left-open" });',
      ),
    },
    fixed: {
      "apps/server/src/door.ts": text(...DOOR, "export const door = createDoor();"),
      "apps/server/src/latch.ts": text(...DOOR, "export const door = createDoor();"),
    },
  },
  {
    rule: "gates/disable-needs-reason",
    planted: { "scripts/quiet.ts": text("// oxlint-disable-next-line no-console", 'console.log("done");') },
    fixed: { "scripts/quiet.ts": text("// oxlint-disable-next-line no-console -- this script's output is its result", 'console.log("done");') },
  },
  {
    rule: "import/no-cycle",
    planted: {
      "apps/server/src/loop-a.ts": text('import { b } from "./loop-b.ts";', "export const a = () => b();"),
      "apps/server/src/loop-b.ts": text('import { a } from "./loop-a.ts";', "export const b = (): number => (a.length > 9 ? a() : 1);"),
    },
    fixed: {
      "apps/server/src/loop-a.ts": text('import { b } from "./loop-b.ts";', "export type A = () => number;", "export const a: A = () => b();"),
      "apps/server/src/loop-b.ts": text('import type { A } from "./loop-a.ts";', "export const b: A = () => 1;"),
    },
  },
  {
    rule: "import/extensions",
    planted: { ...PORT, "apps/server/src/bare.ts": text('import { port } from "./port";', "export const bare = port;") },
    fixed: { ...PORT, "apps/server/src/bare.ts": text('import { port } from "./port.ts";', "export const bare = port;") },
  },
  {
    rule: "typescript/no-import-type-side-effects",
    planted: { ...TYPES, "apps/server/src/inline-type.ts": text('import { type Port } from "./types.ts";', "export const first: Port = 1;") },
    fixed: { ...TYPES, "apps/server/src/inline-type.ts": text('import type { Port } from "./types.ts";', "export const first: Port = 1;") },
  },
  {
    rule: "typescript/no-explicit-any",
    planted: { "apps/server/src/loose.ts": text("export const parse = (raw: any) => raw;") },
    fixed: { "apps/server/src/loose.ts": text("export const parse = (raw: unknown) => raw;") },
  },
  {
    rule: "typescript/ban-ts-comment",
    planted: { "apps/server/src/silenced.ts": text("// @ts-ignore", 'export const count: number = "one";') },
    fixed: { "apps/server/src/silenced.ts": text("export const count: number = 1;") },
  },
  {
    rule: "unicorn/no-abusive-eslint-disable",
    planted: { "scripts/blanket.ts": text("// eslint-disable-next-line -- the table below is generated", "export const table = [1, 2];") },
    fixed: { "scripts/blanket.ts": text("// eslint-disable-next-line no-magic-numbers -- the table below is generated", "export const table = [1, 2];") },
  },
  {
    rule: "eslint/no-warning-comments",
    planted: { "apps/server/src/later.ts": text("// TODO: handle the empty list", "export const rows: string[] = [];") },
    fixed: { "apps/server/src/later.ts": text("// An empty list shows the hint row.", "export const rows: string[] = [];") },
  },
  {
    rule: "vitest/no-focused-tests",
    planted: { "test/focused.test.ts": text('import { expect, it } from "vitest";', 'it.only("adds", () => { expect(1 + 1).toBe(2); });') },
    fixed: { "test/focused.test.ts": text('import { expect, it } from "vitest";', 'it("adds", () => { expect(1 + 1).toBe(2); });') },
  },
  {
    rule: "vitest/no-disabled-tests",
    planted: { "test/skipped.test.ts": text('import { expect, it } from "vitest";', 'it.skip("adds", () => { expect(1 + 1).toBe(2); });') },
    fixed: { "test/skipped.test.ts": text('import { expect, it } from "vitest";', 'it("adds", () => { expect(1 + 1).toBe(2); });') },
  },
  {
    rule: "react/no-danger",
    planted: { "apps/web/src/Raw.tsx": text("export const Raw = ({ html }: { html: string }) => <div dangerouslySetInnerHTML={{ __html: html }} />;") },
    fixed: { "apps/web/src/Raw.tsx": text("export const Raw = ({ html }: { html: string }) => <div>{html}</div>;") },
  },
  {
    rule: "react/forbid-elements",
    planted: { "apps/web/src/Pick.tsx": text("export const Pick = () => <select><option>One</option></select>;") },
    fixed: { "apps/web/src/Pick.tsx": text('export const Pick = () => <button type="button" aria-haspopup="listbox">One</button>;') },
  },
  {
    rule: "eslint/no-restricted-imports",
    planted: { "apps/desktop/src/preload.ts": text('import { join } from "node:path";', "export const joined = join;") },
    fixed: { "apps/desktop/src/preload.ts": text('import { contextBridge } from "electron/renderer";', "export const bridge = contextBridge;") },
  },
];

/** Code a rule must leave alone: each file sits just outside what one rule covers. */
const UNTOUCHED: Files = {
  // Effects and timers are a rule for the window's product code, not its tests or the server.
  "apps/web/src/Title.test.tsx": text(
    'import { useEffect } from "react";',
    "export function Probe() {",
    "  useEffect(() => { setTimeout(() => {}, 1); }, []);",
    "  return null;",
    "}",
  ),
  "apps/server/src/retry.ts": text("export const retry = (run: () => void) => setTimeout(run, 1000);"),
  // A relative import inside one package, and one from the repo's own scripts into an app.
  "apps/web/src/near.ts": text('import { where } from "./cross.ts";', "export const near = where;"),
  "scripts/report.ts": text('import { port } from "../apps/server/src/port.ts";', "export const reported = port;"),
  // The closed package's tests may use the test runner; other desktop files may use Node.
  "packages/contracts/src/closed.test.ts": text('import { expect, it } from "vitest";', 'it("holds", () => { expect(1).toBe(1); });'),
  "apps/desktop/src/main.ts": text('import { join } from "node:path";', "export const joined = join;"),
  // A test sets a guard's test-only switch, and so does the one world the GPU rules run in.
  "apps/server/src/door.test.ts": text(...DOOR, 'export const door = createDoor({ faultForTest: "left-open" });'),
  "apps/server/src/gpu/rules-harness.ts": text(...DOOR, 'export const door = createDoor({ faultForTest: "left-open" });'),
  // The one helper that may wait on the clock, because it checks its claim through the span.
  "test/e2e/waits.ts": text(
    'import type { Page } from "@playwright/test";',
    "export const pause = (page: Page, ms: number) => page.waitForTimeout(ms);",
  ),
};

/** Writes the files as a small repo of their own and lints it with the project's real rules. */
function lint(files: Files): Finding[] {
  const root = mkdtempSync(path.join(os.tmpdir(), "lint-rules-"));
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), body);
  }
  return findings(root, ["apps", "packages", "scripts", "test"]);
}

const all = (pick: (each: Case) => Files): Files => Object.assign({}, ...CASES.map(pick)) as Files;
const firedIn = (found: Finding[], files: Files) =>
  [...new Set(found.filter(finding => finding.file in files).map(finding => finding.rule))];

describe("project lint rules", () => {
  let planted: Finding[] = [];
  let fixed: Finding[] = [];
  beforeAll(() => {
    planted = lint(all(each => each.planted));
    fixed = lint({ ...all(each => each.fixed), ...UNTOUCHED });
  });

  it("has a case for every rule the config names", () => {
    expect(CASES.map(each => each.rule).toSorted()).toEqual(configuredRules());
  });

  it.each(CASES)("$rule reports the planted mistake, and only that", ({ rule, planted: files }) => {
    expect(firedIn(planted, files)).toEqual([rule]);
  });

  it.each(CASES)("$rule passes the fixed form", ({ fixed: files }) => {
    expect(fixed.filter(finding => finding.file in files)).toEqual([]);
  });

  it("leaves alone the code just outside each rule", () => {
    expect(fixed.filter(finding => finding.file in UNTOUCHED)).toEqual([]);
  });
});
