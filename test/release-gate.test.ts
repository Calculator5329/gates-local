import { describe, expect, test } from "vitest";
import { listedCases, mergeGate, parseShard, parseTestList, unmatchedLines, type GateReport } from "../scripts/release-gate.ts";

const LIST = [
  "# comment",
  "",
  "[e2e] › actions.spec.ts:56:3 › while the server is down › a theme save fails cleanly",
  "first-run.spec.ts › first run finds its models",
  "[e2e] > mobile.spec.ts:128:1 > a message sends from the phone",
].join("\n");

// The shape `playwright test --list --reporter=json` prints: file suites, nested describes, specs.
const LISTED = { suites: [
  { title: "actions.spec.ts", file: "actions.spec.ts", specs: [], suites: [
    { title: "while the server is down", file: "actions.spec.ts", specs: [{ title: "a theme save fails cleanly", file: "actions.spec.ts", tests: [{ projectName: "e2e" }] }] },
  ] },
  { title: "first-run.spec.ts", file: "first-run.spec.ts", specs: [{ title: "first run finds its models", file: "first-run.spec.ts", tests: [{ projectName: "e2e" }] }] },
] };

describe("the journey list", () => {
  test("parses Playwright's --test-list lines: project, file without line and column, title path", () => {
    expect(parseTestList(LIST)).toEqual([
      { line: expect.any(String), project: "e2e", file: "actions.spec.ts", titlePath: ["while the server is down", "a theme save fails cleanly"] },
      { line: expect.any(String), file: "first-run.spec.ts", titlePath: ["first run finds its models"] },
      { line: expect.any(String), project: "e2e", file: "mobile.spec.ts", titlePath: ["a message sends from the phone"] },
    ]);
    expect(() => parseTestList("[e2e › a.spec.ts › t")).toThrow(/Malformed/);
  });
  test("a line no listed test matches is reported, so a renamed or deleted journey fails the gate", () => {
    const missing = unmatchedLines(parseTestList(LIST), listedCases(LISTED));
    expect(missing.map((line) => line.file)).toEqual(["mobile.spec.ts"]);
    expect(unmatchedLines(parseTestList("[timing] › first-run.spec.ts › first run finds its models"), listedCases(LISTED))).toHaveLength(1);
  });
  test("shards are I/N within range", () => {
    expect(parseShard("2/3")).toEqual({ current: 2, total: 3 });
    for (const bad of ["0/3", "4/3", "1", "a/b"]) expect(() => parseShard(bad)).toThrow();
  });
});

const base = (part: "checks" | "journeys", extra: Partial<GateReport> = {}): GateReport => ({
  schemaVersion: 1, commit: "a".repeat(40), remote: "origin", startedAt: "2026-11-21T00:00:00.000Z", finishedAt: "2026-11-21T00:01:00.000Z", durationMs: 60_000,
  status: "passed", tools: { node: "v1", git: "g", pnpm: "p", playwright: "pw" }, failures: [], part,
  steps: (part === "checks" ? ["typecheck", "lint", "build"] : ["build", "journeys-list", "e2e"]).map((name) => ({ name, blocking: true, status: "passed" as const, exitCode: 0, durationMs: 5 })),
  tests: { unit: { passed: 0, failed: 0, skipped: 0 }, e2e: part === "checks" ? { passed: 0, failed: 0, skipped: 0 } : { passed: 2, failed: 0, skipped: 0 } },
  ...extra,
});
const shard = (current: number, passed = 2) => base("journeys", { journeys: { list: "l", sha256: "s", lines: 4, tests: 4, shard: { current, total: 2 } }, tests: { unit: { passed: 0, failed: 0, skipped: 0 }, e2e: { passed, failed: 0, skipped: 0 } } });

describe("merging the gate's pieces", () => {
  test("one checks piece and every shard once make a passing gate", () => {
    const gate = mergeGate([base("checks"), shard(1), shard(2)]);
    expect(gate).toMatchObject({ part: "gate", status: "passed", tests: { e2e: { passed: 4 } } });
    expect(gate.steps.map((s) => s.name)).toEqual(["typecheck", "lint", "build", "journeys-list", "e2e"]);
  });
  test("a missing or repeated shard, a short count, two commits or a red piece make it red", () => {
    expect(mergeGate([base("checks"), shard(1)]).status).toBe("failed");
    expect(mergeGate([base("checks"), shard(1), shard(1)]).status).toBe("failed");
    expect(mergeGate([base("checks"), shard(1), shard(2, 1)]).status).toBe("failed");
    // Every line listed but one line matching two tests: the run must equal the line count.
    const wide = (current: number, passed: number) => ({ ...shard(current, passed), journeys: { list: "l", sha256: "s", lines: 4, tests: 5, shard: { current, total: 2 } } });
    expect(mergeGate([base("checks"), wide(1, 2), wide(2, 3)]).status).toBe("failed");
    expect(mergeGate([base("checks", { commit: "b".repeat(40) }), shard(1), shard(2)]).status).toBe("failed");
    expect(mergeGate([base("checks", { status: "failed" }), shard(1), shard(2)]).status).toBe("failed");
    expect(mergeGate([shard(1), shard(2)]).status).toBe("failed");
  });
});
