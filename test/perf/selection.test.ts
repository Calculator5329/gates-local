import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { ROOT } from "../e2e/env.ts";
import { selectJourneys, PRIORITY } from "./selection.ts";

test("focus is explicit, validated and deduplicated", () => {
  expect(selectJourneys()).toBeUndefined();
  expect(selectJourneys("priority")).toEqual(PRIORITY);
  expect(selectJourneys("threads,queue,threads")).toEqual(["threads", "queue"]);
  expect(() => selectJourneys("threadz")).toThrow("Unknown performance journey");
  expect(() => selectJourneys("")).toThrow("Unknown performance journey");
});

test("focused comparison prepares archived inputs without starting a browser", () => {
  const cache = path.join(homedir(), ".cache", "gates-local-perf-test"); mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(path.join(cache, "selection-"));
  try {
    const result = spawnSync(process.execPath, ["test/perf/compare.ts", "--prepare", "HEAD", "HEAD", "--only", "threads,queue", "--out", directory], { cwd: ROOT, encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(path.join(directory, "commits.json"), "utf8"))).toMatchObject({ base: expect.stringMatching(/^[a-f0-9]{40}$/), candidate: expect.stringMatching(/^[a-f0-9]{40}$/) });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
