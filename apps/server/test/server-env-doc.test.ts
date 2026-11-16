import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const SOURCES = ["apps/server/src", "packages/update/src"];
const UPDATE_CLI = "packages/update/src/cli.ts";
const KNOB = /["'`](GATES_LOCAL_[A-Z0-9_]*[A-Z0-9])["'`]/g;

function readKnobs(): Set<string> {
  const files = SOURCES.flatMap((dir) => readdirSync(path.join(ROOT, dir), { recursive: true, encoding: "utf8" }).map((f) => `${dir}/${f.replaceAll("\\", "/")}`))
    .filter((f) => f.endsWith(".ts") && !/\.test\.ts$|testing\.ts$/.test(f) && f !== UPDATE_CLI);
  return new Set(files.flatMap((f) => [...readFileSync(path.join(ROOT, f), "utf8").matchAll(KNOB)].map((m) => m[1] ?? "")));
}

function documentedKnobs(): Set<string> {
  const doc = readFileSync(path.join(ROOT, "docs/server-env.md"), "utf8");
  return new Set([...doc.matchAll(/^\| `(GATES_LOCAL_[A-Z0-9_]+)` \|/gm)].map((m) => m[1] ?? ""));
}

describe("docs/server-env.md is the server's list of environment knobs", () => {
  it("every knob the server source reads has a row, and every row names a knob it reads", () => {
    const read = readKnobs();
    const documented = documentedKnobs();
    expect(read.size, "the scan still finds the knobs").toBeGreaterThan(20);
    expect([...read].filter((k) => !documented.has(k)).toSorted(), "read but not documented").toEqual([]);
    expect([...documented].filter((k) => !read.has(k)).toSorted(), "documented but never read").toEqual([]);
  });
});
