import { describe, expect, it } from "vitest";
import { type UpdateCheck, decodeResult } from "../src/index.ts";
import { methodSamples } from "../src/testing.ts";

const checks: UpdateCheck[] = [
  { state: "up-to-date", checkedAt: 1, channel: "main", current: "85507ce" },
  { state: "available", checkedAt: 1, channel: "release", current: "v0.1.0", target: "v0.2.0", total: 1, changes: [], notes: "First release" },
  { state: "cannot-check", checkedAt: 1, reason: "remote", lines: ["Could not reach the remote.", "Check the connection."] },
];

describe("update contracts", () => {
  // A check answers with the status it leaves, so each check decodes inside one.
  const status = methodSamples["update.status"].result;
  it.each(checks)("decodes the $state check", (check) => {
    expect(decodeResult("update.check", { ...status, lastCheck: check })).toEqual({ ok: true, value: { ...status, lastCheck: check } });
  });

  it("refuses a check reason it does not know", () => {
    expect(decodeResult("update.check", { ...status, lastCheck: { state: "cannot-check", checkedAt: 1, reason: "sleepy", lines: [] } }).ok).toBe(false);
  });

  it("decodes every version kind", () => {
    for (const version of [
      { kind: "commit", commit: "85507ce", date: 1 },
      { kind: "not-a-clone" },
      { kind: "unreadable", detail: "git is not installed" },
    ] as const) {
      expect(decodeResult("update.status", { version, result: null, lastCheck: null }).ok).toBe(true);
    }
  });

  it("keeps settings saved before the update switch existed", () => {
    const { updateEveryChange: _, ...older } = { ...methodSamples["settings.get"].result, updateEveryChange: true };
    expect(decodeResult("settings.get", older).ok).toBe(true);
    expect(decodeResult("settings.get", { ...older, updateEveryChange: "yes" }).ok).toBe(false);
  });
});
