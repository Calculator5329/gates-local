import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";

const list = (project: string) => execFileSync("pnpm", ["exec", "playwright", "test", "-c", "test/e2e/playwright.config.ts", `--project=${project}`, "--list"], { encoding: "utf8" });
test("RG-05: functional companions of timing measurements stay in the blocking project", () => {
  const blocking = list("e2e");
  const timing = list("timing");
  for (const title of ["renders all 400 messages", "cold load reaches a ready composer without console errors", "typing preserves every character while idle, streaming and busy"]) {
    expect(blocking).toContain(title);
    expect(timing).not.toContain(title);
  }
}, 15_000);
