import { expect, test } from "vitest";
import { accountWindows, accountingMarkdown, parseCpuSample, parseJourneyWindow } from "./accounting.ts";

const window = (start = 105, end = 115) => parseJourneyWindow(JSON.stringify({ name: "send", kind: "timed", repeat: 0, elapsed: end - start, epochStart: start, epochEnd: end }));
const sample = (epochMs: number, runtime: number, boxCpuNs: number) => parseCpuSample(JSON.stringify({ epochMs, scanMs: 2, boxCpuNs, rows: [
  [1, "birth", 1, "server", runtime, true, [0]],
  [2, "birth", 2, "gpu", runtime * 3, false, [1, 2]],
  [3, "birth", 3, "unassigned", runtime / 2, true, [0]],
] }));

test("CPU accounting clips both ends to page marks and keeps outside overlap separate", async () => {
  const readings = [sample(100, 0, 0), sample(110, 4e6, 8e6), sample(120, 10e6, 20e6)];
  const [result] = await accountWindows([window()], readings);
  expect(result).toMatchObject({ insideMs: { server: 5, unassigned: 2.5, gpu: 0 }, outsideMs: { gpu: 15, server: 0 }, boxCpuMs: 10, differenceMs: 2.5, unassignedMs: 5, coveredMs: 10, maxGapMs: 10, maxScanMs: 2 });
  expect(accountingMarkdown({ base: [], candidate: [result!] })).toContain("0.0 / 15.0");
  expect(accountingMarkdown({ base: [], candidate: [] })).toBe("");
});

test("CPU accounting preserves negative differences, incomplete coverage and recycled process identities", async () => {
  const end = sample(110, 8e6, 4e6);
  const [over] = await accountWindows([window(100, 120)], [sample(100, 0, 0), end]);
  expect(over).toMatchObject({ differenceMs: -8, unassignedMs: -4, coveredMs: 10 });
  expect(accountingMarkdown({ base: [over!], candidate: [] })).toContain("50.0");
  const recycled = parseCpuSample(JSON.stringify({ ...end, rows: end.rows.map(row => [row[0], "another birth", ...row.slice(2)]) }));
  const [missing] = await accountWindows([window()], [sample(100, 0, 0), recycled]);
  expect(missing).toMatchObject({ insideMs: { server: 0 }, boxCpuMs: 2, differenceMs: 2 });
  const [absent] = await accountWindows([window()], []);
  expect(absent).toMatchObject({ boxCpuMs: null, unassignedMs: null, coveredMs: 0 });
  expect(accountingMarkdown({ base: [absent!], candidate: [] })).toContain("n/a");
});

test("stored CPU samples and marks reject malformed or inverted data", () => {
  expect(() => parseCpuSample('{"rows":[]}')).toThrow("CPU sample");
  expect(() => parseJourneyWindow('{"name":"send"}')).toThrow("journey marks");
  expect(() => window(120, 100)).toThrow("journey marks");
});
