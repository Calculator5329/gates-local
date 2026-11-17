import { expect, test } from "vitest";
import { defaultShards, durationsFrom, fileFilter, parseListing, planShards } from "../scripts/e2e-shards.ts";

const listing = (files: Record<string, number>) => ({
  config: {}, errors: [], stats: { expected: 0, unexpected: 0, flaky: 0, skipped: Object.values(files).reduce((a, b) => a + b, 0) },
  suites: Object.entries(files).map(([file, n]) => ({ title: file, file, specs: [{ title: "top", file, tests: [{}] }], suites: [{ title: "group", file, specs: Array.from({ length: n - 1 }, () => ({ title: "inner", file, tests: [{}] })), suites: [] }] })),
});

test("the listing counts every test of a file, nested groups included", () => {
  expect(parseListing(listing({ "b.spec.ts": 3, "a.spec.ts": 1 }))).toEqual({ files: [{ file: "a.spec.ts", tests: 1 }, { file: "b.spec.ts", tests: 3 }], total: 4 });
  expect(() => parseListing({ suites: [] })).toThrow(/not a JSON report/);
});

test("shards balance measured seconds, longest first, and every file lands in exactly one shard", () => {
  const files = [{ file: "measure.spec.ts", tests: 9 }, { file: "a.spec.ts", tests: 2 }, { file: "b.spec.ts", tests: 2 }, { file: "c.spec.ts", tests: 2 }, { file: "new.spec.ts", tests: 4 }];
  const seconds = { "measure.spec.ts": 120, "a.spec.ts": 60, "b.spec.ts": 50, "c.spec.ts": 10 };
  const plan = planShards(files, 2, seconds);
  expect(plan.flat().toSorted()).toEqual(files.map((f) => f.file).toSorted());
  // new.spec.ts has no reading: 4 tests at the measured 240 s / 15 tests = 64 s
  const load = (shard: string[]) => shard.reduce((s, f) => s + ((seconds as Record<string, number>)[f] ?? 64), 0);
  expect(plan.map(load).toSorted((a, b) => a - b)).toEqual([134, 170]);
  expect(planShards(files, 9)).toHaveLength(files.length);
  expect(planShards([], 4)).toEqual([[]]);
});

test("a file filter matches its own spec file and no other", () => {
  const filter = fileFilter("/repo/test/e2e", "pages.spec.ts");
  const re = new RegExp(filter.slice(1, -1));
  expect(re.test("/repo/test/e2e/pages.spec.ts")).toBe(true);
  for (const other of ["/repo/test/e2e/pages-desktop.spec.ts", "/repo/test/e2e/my-pages.spec.ts", "/repo/test/e2e/pagesXspec.ts", "/repo/test/e2e/pages.spec.ts.bak"]) expect(re.test(other), other).toBe(false);
});

const timedReport = (ms: number) => ({ suites: [{ file: "a.spec.ts", specs: [{ tests: [{ results: [{ duration: ms }] }] }], suites: [{ specs: [{ tests: [{ results: [{ duration: 1000 }] }] }] }] }] });

test("durations are seconds per file, the mean across reports", () => {
  expect(durationsFrom([timedReport(2000), timedReport(4000)])).toEqual({ "a.spec.ts": 4 });
});

test("shards default to half the cores, between one and eight", () => {
  expect([1, 2, 6, 8, 20, 64].map((n) => defaultShards(n))).toEqual([1, 1, 3, 4, 8, 8]);
});
