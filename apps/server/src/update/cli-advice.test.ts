import { expect, it } from "vitest";
import { refusalLines } from "./cli.ts";
import { resultLine } from "./module.ts";

it.each([
  { reason: "unfinished", target: "new", runningPid: 4242 },
  { reason: "still-running", target: "new", pid: 4242 },
] as const)("AW-04 $reason advice describes uncertainty and a real Restart", refusal => {
  const text = refusalLines(refusal).join("\n");
  expect(text).toContain("not been confirmed stopped");
  expect(text).toContain("Restart");
  expect(text).toContain("Fast Startup");
  expect(text).not.toContain("is still running");
  expect(text).not.toContain("ran too long");
});

it.each([
  ["updated", "Repaired chosen."],
  ["stopped", "The repair of chosen stopped at installing packages: install failed. Gates Local is still on chosen."],
  ["rollback-failed", "Repairing chosen stopped at installing packages: install failed. Retrying the repair did not finish either. Run the commands below in the Gates Local folder."],
] as const)("AW-05 %s record describes repair at the same commit", (outcome, line) => {
  const here = { commit: "chosen-commit", label: "chosen" };
  expect(resultLine({ at: 1, outcome, from: here, to: here, changes: 0, step: "install", reason: "install failed" })).toBe(line);
});
