import { expect, test } from "vitest";
import { runChecks, type Check } from "../scripts/pre-push.ts";

const node = (name: string, code: string): Check => ({ name, argv: [process.execPath, "-e", code] });
const quick = node("quick", "");
const slow = node("slow", "setTimeout(() => {}, 300)");
const broken = node("broken", "console.error('two errors'); process.exit(2)");

test("checks that pass inside the budget let the push go, and the line says each one's time", async () => {
  const result = await runChecks([quick, slow], process.cwd(), 20_000);
  expect(result.code).toBe(0);
  expect(result.lines.at(-1)).toMatch(/^pre-push: \d+\.\d s of a 20\.0 s budget \(quick \d+\.\d s, slow \d+\.\d s\)$/);
});

test("checks that pass but run past the budget stop the push with the budget and the reading", async () => {
  const result = await runChecks([quick, slow], process.cwd(), 100);
  expect(result.code).toBe(1);
  expect(result.lines.at(-1)).toMatch(/^pre-push: \d+\.\d s of a 0\.1 s budget \(quick .*, slow .*\): over budget, find what got slow$/);
});

test("a failed check stops the push and shows its own output", async () => {
  const result = await runChecks([quick, broken], process.cwd(), 20_000);
  expect(result.code).toBe(1);
  expect(result.lines).toContain("pre-push: broken failed (exit 2)");
  expect(result.lines).toContain("two errors");
});
