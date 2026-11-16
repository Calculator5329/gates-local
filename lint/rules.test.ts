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
    rule: "gates/class-in-css",
    planted: {
      "apps/web/src/banner.css": text(".ba{display:flex}", ".ba .ok{color:green}"),
      "apps/web/src/Banner.tsx": text('export const Banner = () => <div className="bx"><span className="ok" /></div>;'),
    },
    fixed: {
      "apps/web/src/banner.css": text(".ba{display:flex}", ".ba .ok{color:green}"),
      "apps/web/src/Banner.tsx": text('export const Banner = () => <div className="ba"><span className="ok" /></div>;'),
    },
  },
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
    planted: { "scripts/silenced.ts": text("// @ts-ignore", 'export const count: number = "one";') },
    fixed: { "scripts/silenced.ts": text("export const count: number = 1;") },
  },
  {
    rule: "unicorn/no-abusive-eslint-disable",
    planted: { "scripts/blanket.ts": text("// eslint-disable-next-line -- the table below is generated", "export const table = [1, 2];") },
    fixed: { "scripts/blanket.ts": text("// eslint-disable-next-line no-magic-numbers -- the table below is generated", "export const table = [1, 2];") },
  },
  {
    rule: "eslint/no-warning-comments",
    planted: { "scripts/later.ts": text("// TODO: handle the empty list", "export const rows: string[] = [];") },
    fixed: { "scripts/later.ts": text("// An empty list shows the hint row.", "export const rows: string[] = [];") },
  },
  {
    rule: "gates/comment-is-a-kind",
    planted: {
      "apps/server/src/pull.ts": text(
        "// The first answer is often a 503 while the runtime wakes, so one more try.",
        "export const tries = 2;",
      ),
    },
    fixed: {
      "apps/server/src/pull.ts": text(
        "// external: Ollama answers 503 while it wakes.",
        "export const WAKING_TRIES = 2;",
      ),
    },
  },
  {
    rule: "eslint/id-length",
    planted: {
      "apps/server/src/build-log.ts": text(
        "export const failureLoggedOnceThoughTheTableRebuildsEverySecond = { yes: false };",
      ),
    },
    fixed: {
      "apps/server/src/build-log.ts": text(
        "// why: the table is rebuilt every second, so a failure is logged once.",
        "export const failureLogged = { yes: false };",
      ),
    },
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
    rule: "react/jsx-no-comment-textnodes",
    planted: { "apps/web/src/Row.tsx": text("export const Row = () => (", "  <li>", "    // external: a browser reads this line out", "    <span />", "  </li>", ");") },
    fixed: { "apps/web/src/Row.tsx": text("export const Row = () => (", "  <li>", "    {/* external: a browser reads this line out */}", "    <span />", "  </li>", ");") },
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
  // A class in a test's own markup styles nothing by design.
  "apps/web/src/Row.test.tsx": text('export const Row = () => <div className="probe-only" />;'),
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

const COMMENT_RULE = "gates/comment-is-a-kind";

/** The small repo the comment rule's cases sit in: two decision pages and a package with a public surface. */
const COMMENT_WORLD: Files = {
  "docs/decisions.md": text("# Decisions", "", "## 2026-01-02 · The phone is for chat only", "", "Words.", "", "## Undated row"),
  "docs/design.md": text("# Interface rules", "", "## Placeholders", "", "Words."),
  "packages/kit/package.json": text('{ "name": "kit", "exports": { ".": "./src/index.ts", "./extra/*": "./src/extra/*.ts" } }'),
};

/** One file, and the lines where the comment rule must refuse a comment in it (none: every comment in it is a kind). */
type CommentCase = { name: string; file: string; body: string; refused: number[] };

const COMMENT_CASES: CommentCase[] = [
  {
    name: "an origin header that opens the file",
    file: "apps/web/src/Ported.tsx",
    body: text(
      "// Layout adapts Some Project (MIT, Copyright (c) 2026 Its Authors); full notice in LICENSES/Some-MIT.txt.",
      "export const Ported = () => <div />;",
    ),
    refused: [],
  },
  {
    name: "licence words below the top of the file are not a header",
    file: "apps/web/src/late-header.ts",
    body: text("export const first = 1;", "// Adapted from Some Project (MIT).", "export const second = 2;"),
    refused: [2],
  },
  {
    name: "a comment that opens the file without licence words is not a header",
    file: "apps/server/src/opening.ts",
    body: text("// Reads the settings file and hands back what it holds.", "export const opening = 1;"),
    refused: [1],
  },
  {
    name: "directives that carry their reason, and tool pragmas",
    file: "apps/web/src/directives.ts",
    body: text(
      '/// <reference types="vite/client" />',
      "export function later(run: () => void, where: string) {",
      "  // oxlint-disable-next-line gates/timer-needs-reason -- a debounce: the search runs once typing has paused",
      "  window.setTimeout(run, 150);",
      "  // @ts-expect-error the library's types leave this field out",
      "  run.missing = 1;",
      "  /* oxlint-disable gates/timer-needs-reason -- every timer below paces one reveal */",
      "  /* oxlint-enable gates/timer-needs-reason */",
      "  return import(/* @vite-ignore */ where);",
      "}",
    ),
    refused: [],
  },
  {
    name: "a directive with no reason",
    file: "apps/server/src/bare-directives.ts",
    body: text(
      "export function bare(run: { missing?: number }) {",
      "  // oxlint-disable-next-line no-console",
      '  console.log("done");',
      "  // @ts-expect-error",
      "  run.missing = 1;",
      "}",
    ),
    refused: [2, 4],
  },
  {
    name: "prose riding above a directive is its own comment",
    file: "apps/web/src/riding.ts",
    body: text(
      "export function later(run: () => void) {",
      "  // The search box calls this on every key.",
      "  // oxlint-disable-next-line gates/timer-needs-reason -- a debounce: the search runs once typing has paused",
      "  window.setTimeout(run, 150);",
      "}",
    ),
    refused: [2],
  },
  {
    name: "external: naming the outside thing, on one line, over several, in a block and in JSX",
    file: "apps/web/src/Forced.tsx",
    body: text(
      "// external: Ollama answers 404 for a model it has not pulled.",
      "export const MISSING = 404;",
      "// external: a browser pauses timers in a hidden tab,",
      "// so the count is taken from the clock.",
      "export const fromClock = true;",
      "/* external: nvidia-smi prints MiB. */",
      "export const UNIT = 1024 * 1024;",
      "/**",
      " * external: /proc/net/tcp prints each word in host byte order.",
      " */",
      "export const WORD = 4;",
      "export const Forced = () => <div>{/* external: Chromium's own date picker cannot be styled. */}</div>;",
    ),
    refused: [],
  },
  {
    name: "external: that names nothing the rule knows",
    file: "apps/server/src/unnamed.ts",
    body: text(
      "// external: the other side sometimes answers late.",
      "export const LATE = 1;",
      "// external: uvicorn and browserslist only hold a known name inside a longer word.",
      "export const WORDS = 2;",
      "// external:",
      "export const EMPTY = 3;",
    ),
    refused: [1, 3, 5],
  },
  {
    name: "decision: with a row or a heading that exists",
    file: "apps/server/src/decided.ts",
    body: text(
      '// decision: docs/decisions.md "The phone is for chat only"',
      "export const phone = 1;",
      '// decision: docs/decisions.md "2026-01-02 · The phone is for chat only": the phone gets no settings call.',
      "export const dated = 2;",
      '// decision: docs/decisions.md "Undated row"',
      "export const undated = 3;",
      '/* decision: docs/design.md "Placeholders" */',
      "export const held = 4;",
    ),
    refused: [],
  },
  {
    name: "decision: with no row behind it",
    file: "apps/server/src/undecided.ts",
    body: text(
      '// decision: docs/decisions.md "The phone does everything"',
      "export const phone = 1;",
      "// decision: the maintainer said so in chat",
      "export const said = 2;",
      '// decision: docs/roadmap.md "Placeholders"',
      "export const elsewhere = 3;",
      '// decision: docs/design.md "The phone is for chat only"',
      "export const wrongPage = 4;",
    ),
    refused: [1, 3, 5, 7],
  },
  {
    name: "a tag that is not a kind",
    file: "apps/server/src/tagged.ts",
    body: text("// reason: the list is short", "export const SHORT = 3;", "// note: external: Ollama", "export const LATER = 4;"),
    refused: [1, 3],
  },
  {
    name: "why: as one line directly above the code, at the top level, indented, and at exactly 100 characters",
    file: "apps/server/src/reasons.ts",
    body: text(
      "// why: the table is rebuilt every second, so a failure is logged once.",
      "let logged = false;",
      "export function note(failed: boolean) {",
      "  // why: a second log line would bury the first.",
      "  if (failed && !logged) logged = true;",
      `  // why: ${"x".repeat(92)}`,
      "  return logged;",
      "}",
    ),
    refused: [],
  },
  {
    name: "why: over two lines, or with prose riding under it",
    file: "apps/server/src/reasons-two-lines.ts",
    body: text(
      "// why: the table is rebuilt every second,",
      "// why: so a failure is logged once.",
      "export const once = true;",
      "// why: the list is short,",
      "// and stays short.",
      "export const SHORT = 3;",
    ),
    refused: [1, 4],
  },
  {
    name: "why: one character past 100, slashes included",
    file: "apps/server/src/reasons-long.ts",
    body: text("export function long() {", `  // why: ${"x".repeat(93)}`, "  return 1;", "}"),
    refused: [2],
  },
  {
    name: "why: behind code on the same line",
    file: "apps/server/src/reasons-trailing.ts",
    body: text("export const once = true; // why: the table is rebuilt every second.", "export const twice = false;"),
    refused: [1],
  },
  {
    name: "why: in a block comment, in JSDoc and in JSX",
    file: "apps/web/src/ReasonsBlock.tsx",
    body: text(
      "/* why: the table is rebuilt every second. */",
      "export const once = true;",
      "/** why: the list is short. */",
      "export const SHORT = 3;",
      "export const Reasons = () => (",
      "  <div>",
      "    {/* why: the heading is drawn by the list. */}",
      "    <span />",
      "  </div>",
      ");",
    ),
    refused: [1, 3, 7],
  },
  {
    name: "why: with no code on the next line: a blank line, a comment, the end of a block, the end of the file, no words",
    file: "apps/server/src/reasons-adrift.ts",
    body: text(
      "// why: the table is rebuilt every second.",
      "",
      "export const once = true;",
      "// why: the next line is a directive, which carries its own reason.",
      "// oxlint-disable-next-line no-console -- this file's output is its result",
      'console.log("done");',
      "export function drop(run: () => void) {",
      "  try { run(); } catch {",
      "    // why: a failure here is the caller's to see.",
      "  }",
      "}",
      "// why:",
      "export const EMPTY = 1;",
      "// why: nothing follows this line.",
    ),
    refused: [1, 4, 9, 12, 14],
  },
  {
    name: "prose in every shape; a run of lines is one comment, a blank line starts the next",
    file: "apps/web/src/Prose.tsx",
    body: text(
      "// Counts the rows.",
      "// Then doubles them,",
      "// for the header.",
      "export const rows = 2; // the header counts twice",
      "",
      "/* A block. */",
      "export const block = 1;",
      "// One thought.",
      "",
      "// Another thought.",
      "export const Prose = () => <div>{/* the empty state */}</div>;",
    ),
    refused: [1, 4, 6, 8, 10, 11],
  },
  {
    name: "JSDoc on an export inside an app",
    file: "apps/server/src/documented.ts",
    body: text("/** How many rows a page holds. */", "export const PAGE = 20;"),
    refused: [1],
  },
  {
    name: "JSDoc on what a package's entry declares",
    file: "packages/kit/src/index.ts",
    body: text(
      'export * from "./whole.ts";',
      'export { picked, type Chosen } from "./part.ts";',
      "/** The version callers compare. */",
      "export const VERSION = 1;",
      "/** A plain block comment is not JSDoc on anything. */",
      "const local = 2;",
      "/* The version, again. */",
      "export const AGAIN = local;",
    ),
    refused: [5, 7],
  },
  {
    name: "JSDoc in a file the entry re-exports whole: on exports only, and not on a member",
    file: "packages/kit/src/whole.ts",
    body: text(
      "/** What a caller passes. */",
      "export type Input = {",
      "  /** The file to read. */",
      "  file: string;",
      "};",
      "/** Reads one file. */",
      "export function read(input: Input) { return helper(input.file); }",
      "/** Trims the name. */",
      "function helper(file: string) { return file.trim(); }",
      "/** The default reader. */",
      "export default read;",
    ),
    refused: [3, 8],
  },
  {
    name: "JSDoc in a file the entry re-exports by name: on those names only",
    file: "packages/kit/src/part.ts",
    body: text(
      "/** The one the entry offers. */",
      "export const picked = 1;",
      "/** A type the entry offers. */",
      "export type Chosen = number;",
      "/** Exported for the package's own files. */",
      "export const unpicked = 2;",
    ),
    refused: [5],
  },
  {
    name: "JSDoc in a package file no entry reaches",
    file: "packages/kit/src/inner.ts",
    body: text("/** Used by whole.ts alone. */", "export const inner = 1;"),
    refused: [1],
  },
  {
    name: "JSDoc in a file a pattern in `exports` offers",
    file: "packages/kit/src/extra/more.ts",
    body: text("/** One more thing callers may import. */", "export const more = 1;"),
    refused: [],
  },
  {
    name: "a test beside the source",
    file: "apps/server/src/pull.test.ts",
    body: text("// The fake answers 503 twice.", "export const answers = [503, 503, 200];"),
    refused: [],
  },
  {
    name: "a helper in a test folder under src",
    file: "packages/kit/src/test/world.ts",
    body: text("// Builds the world the tests run in.", "export const world = 1;"),
    refused: [],
  },
  {
    name: "a script",
    file: "scripts/report-rows.ts",
    body: text("// Prints one row per file.", "export const printed = 1;"),
    refused: [],
  },
  {
    name: "a package's own test folder",
    file: "packages/kit/test/helpers.ts",
    body: text("// Shared by the package's tests.", "export const shared = 1;"),
    refused: [],
  },
];

describe(COMMENT_RULE, () => {
  let found: Finding[] = [];
  beforeAll(() => {
    found = lint({ ...COMMENT_WORLD, ...Object.fromEntries(COMMENT_CASES.map(each => [each.file, each.body])) })
      .filter(finding => finding.rule === COMMENT_RULE);
  });
  const messageAt = (file: string, line: number) => found.find(finding => finding.file === file && finding.line === line)?.message ?? "";

  it.each(COMMENT_CASES)("$name", ({ file, refused }) => {
    expect(found.filter(finding => finding.file === file).map(finding => finding.line).toSorted((a, b) => a - b)).toEqual(refused);
  });

  it("tells the reader what to do with each sort of comment", () => {
    const message = messageAt("apps/web/src/Prose.tsx", 1);
    for (const advice of ["delete it", "make the name say so", "write the check", "start it `external:`", "write the one `why:` line", "never a sentence in a name", "the import or the name already does"]) {
      expect(message).toContain(advice);
    }
  });

  it("says what shape a why: line has when one is refused", () => {
    for (const [file, line] of [["apps/server/src/reasons-two-lines.ts", 1], ["apps/server/src/reasons-long.ts", 2], ["apps/server/src/reasons-trailing.ts", 1], ["apps/web/src/ReasonsBlock.tsx", 1], ["apps/server/src/reasons-adrift.ts", 9]] as const) {
      expect(messageAt(file, line)).toContain("with the code it explains on the next line");
    }
  });

  it("says which page lacks the row a decision names", () => {
    expect(messageAt("apps/server/src/undecided.ts", 1)).toContain('docs/decisions.md has no "The phone does everything"');
    expect(messageAt("apps/server/src/undecided.ts", 3)).toContain("names neither");
  });

  it("lists the outside things it knows when external: names none", () => {
    expect(messageAt("apps/server/src/unnamed.ts", 1)).toContain("Ollama");
  });

  it("asks a bare directive for its reason", () => {
    expect(messageAt("apps/server/src/bare-directives.ts", 2)).toContain("-- <reason>");
  });
});

const CLASS_RULE = "gates/class-in-css";

/** The CSS and the browser test the class rule's cases are judged against. */
const CLASS_WORLD: Files = {
  "apps/web/src/app/styles.css": text(
    "/* .commented{color:red} names nothing */",
    ".row{display:flex}.row.on{font-weight:600}",
    "@media (width < 600px){.row .tag-small{display:none}}",
    ".btn-primary,.btn-ghost{padding:4px}",
  ),
  "test/e2e/rows.spec.ts": text(
    'import { expect, test } from "@playwright/test";',
    'test("rows", async ({ page }) => {',
    '  await expect(page.locator(".row.hooked")).toHaveCount(1);',
    '  await expect(page.locator("#one")).toHaveClass(/\\bpicked\\b/);',
    "});",
  ),
  "apps/web/src/Tested.test.tsx": text(
    'import { expect, it } from "vitest";',
    'it("marks the row", () => { expect(String(1)).toBe("1"); const node = { props: { className: "" } };',
    '  expect(node.props.className).toBe("row tested"); });',
  ),
};

/** One component, and the class names the rule must refuse in it, in the order it reports them. */
type ClassCase = { name: string; file: string; body: string; refused: string[] };

const CLASS_CASES: ClassCase[] = [
  {
    name: "a class in a compound selector, under a media query, or in a selector list",
    file: "apps/web/src/Styled.tsx",
    body: text('export const Styled = () => <div className="row on"><b className="tag-small btn-ghost" /></div>;'),
    refused: [],
  },
  {
    name: "a class only a comment in the CSS names",
    file: "apps/web/src/Commented.tsx",
    body: text('export const Commented = () => <div className="row commented" />;'),
    refused: ["commented"],
  },
  {
    name: "a class a browser test looks up, by selector or by toHaveClass",
    file: "apps/web/src/Hooked.tsx",
    body: text('export const Hooked = ({ on }: { on: boolean }) => <div className={on ? "row hooked picked" : "row"} />;'),
    refused: [],
  },
  {
    name: "a class a unit test reads off a className",
    file: "apps/web/src/Tested.tsx",
    body: text('export const Tested = ({ on }: { on: boolean }) => <div className={on ? "row tested" : "row tsted"} />;'),
    refused: ["tsted"],
  },
  {
    name: "both arms of a condition, but never a string it compares",
    file: "apps/web/src/Arms.tsx",
    body: text('export const Arms = ({ kind }: { kind: string }) => <div className={kind === "ghost-kind" ? "row" : "rwo"} />;'),
    refused: ["rwo"],
  },
  {
    name: "template text and the strings beside it, but not a name cut by an expression",
    file: "apps/web/src/Built.tsx",
    body: text(
      'export const Built = ({ on, kind }: { on: boolean; kind: string }) =>',
      '  <div className={`row${on ? " on" : " of"} btn-${kind} ${on ? "btn-ghost" : "btn-gost"}`} />;',
    ),
    refused: ["of", "btn-gost"],
  },
  {
    name: "the items of a joined list and the arguments of a class helper",
    file: "apps/web/src/Joined.tsx",
    body: text(
      "const cx = (...names: string[]) => names.join(\" \");",
      'export const Joined = ({ on }: { on: boolean }) => <div className={[on && "on", "row", "rows"].join(" ")}><b className={cx("row", "btn-primry")} /></div>;',
    ),
    refused: ["rows", "btn-primry"],
  },
];

describe(CLASS_RULE, () => {
  let found: Finding[] = [];
  beforeAll(() => {
    found = lint({ ...CLASS_WORLD, ...Object.fromEntries(CLASS_CASES.map(each => [each.file, each.body])) })
      .filter(finding => finding.rule === CLASS_RULE);
  });

  it.each(CLASS_CASES)("$name", ({ file, refused }) => {
    expect(found.filter(finding => finding.file === file).map(finding => /`([^`]+)`/.exec(finding.message)?.[1])).toEqual(refused);
  });

  it("says the class styles nothing and what to do about it", () => {
    const message = found.find(finding => finding.file === "apps/web/src/Arms.tsx")?.message ?? "";
    expect(message).toContain("`rwo`");
    expect(message).toContain("fix the name, add its rule to the package's CSS, or drop it");
  });
});
