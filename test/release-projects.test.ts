import { execFileSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

// The listing goes to a file, not a pipe. Playwright exits as soon as it has
// printed the list, and whatever a pipe's reader has not taken by then is
// lost: on a busy machine the list arrived cut short with exit status 0. A
// file takes every write before the write returns.
function list(project: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "release-projects-"));
  const file = path.join(dir, "list.txt");
  const out = openSync(file, "w");
  try {
    execFileSync("pnpm", ["exec", "playwright", "test", "-c", "test/e2e/playwright.config.ts", `--project=${project}`, "--list"], { stdio: ["ignore", out, "inherit"] });
    return readFileSync(file, "utf8");
  } finally {
    closeSync(out);
    unlinkSync(file);
    rmdirSync(dir);
  }
}

test("RG-05: functional companions of timing measurements stay in the blocking project", () => {
  const blocking = list("e2e");
  const timing = list("timing");
  // A list without its last line is not a list of every test.
  for (const listing of [blocking, timing]) expect(listing).toMatch(/\nTotal: \d+ tests? in \d+ files?\n$/);
  for (const title of ["renders all 400 messages", "cold load reaches a ready composer without console errors", "typing preserves every character while idle, streaming and busy"]) {
    expect(blocking).toContain(title);
    expect(timing).not.toContain(title);
  }
}, 15_000);
