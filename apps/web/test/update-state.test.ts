import { expect, it } from "vitest";
import type { UpdateStatus } from "@gates-local/contracts";
import { updateButton } from "../src/update-state.ts";

const status: UpdateStatus = { version: { kind: "commit", commit: "abc1234" }, result: null, lastCheck: null };
const check = { state: "available", checkedAt: 1, current: "abc1234", target: "def5678", channel: "main", total: 1, changes: ["Faster chat"] } as const;
const available: UpdateStatus = { ...status, lastCheck: check };

it("hides idle, current and background check errors", () => {
  expect(updateButton(null, true)).toBeNull();
  expect(updateButton(status, true)).toBeNull();
  expect(updateButton({ ...status, lastCheck: { state: "up-to-date", checkedAt: 1, channel: "main", current: "abc1234" } }, true)).toBeNull();
  expect(updateButton({ ...status, lastCheck: { state: "cannot-check", checkedAt: 1, reason: "remote", lines: ["offline"] } }, true)).toBeNull();
});
it("names the target and what is new", () => {
  expect(updateButton(available, true)).toMatchObject({ state: "available", label: "Update def5678", detail: expect.stringContaining("Faster chat"), disabled: false });
});
it("uses release notes when supplied", () => {
  expect(updateButton({ ...available, lastCheck: { ...check, notes: "New settings" } }, true)?.detail).toContain("New settings");
});
it("disables installation while closing", () => {
  expect(updateButton(available, true, true)).toMatchObject({ state: "installing", disabled: true });
});
it("offers retry after a clicked failure", () => {
  expect(updateButton(available, true, false, "Could not start the updater")).toMatchObject({ state: "failed", label: "Retry update", detail: "Could not start the updater", disabled: false });
});
it("keeps the transaction record and log visible after rollback", () => {
  expect(updateButton({ ...status, result: { at: 1, outcome: "stopped", line: "Build failed; still on abc1234.", logPath: "update-logs/run.log" } }, true)?.detail).toContain("update-logs/run.log");
});
it("never offers installation in a browser or phone", () => {
  expect(updateButton(available, false)).toBeNull();
  expect(updateButton(available, false, true, "failure")).toBeNull();
});
