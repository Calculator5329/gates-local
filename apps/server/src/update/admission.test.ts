import { afterEach, expect, it, vi } from "vitest";
import { createUpdateAdmission } from "./admission.ts";

afterEach(() => vi.useRealTimers());
it("AV-01 a committed handoff expires after its desktop connection disappears without quitting", async () => {
  vi.useFakeTimers();
  const admission = createUpdateAdmission();
  const connection = new AbortController();
  const token = admission.reserve("a".repeat(40));
  admission.commit(token, "a".repeat(40), "main-release", connection.signal);
  connection.abort();
  expect(admission.installing()).toBe(true);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(admission.installing()).toBe(false);
  expect(() => admission.admit()).not.toThrow();
});
it("AU-01 a reservation blocks work, rejects another lease, and only its token can reopen admission", () => {
  const admission = createUpdateAdmission();
  expect(() => admission.admit()).not.toThrow();
  const token = admission.reserve("a".repeat(40));
  expect(() => admission.admit()).toThrow("closing to update");
  expect(() => admission.reserve("b".repeat(40))).toThrow("closing to update");
  expect(admission.cancel("another reservation")).toBe(false);
  expect(admission.commit(token, "b".repeat(40), "main-release")).toBeNull();
  expect(admission.installing()).toBe(true);
  expect(admission.cancel(token)).toBe(true);
  expect(() => admission.admit()).not.toThrow();
});
it("AU-01 an abandoned handoff expires, but a committed install never reopens on a timer", async () => {
  vi.useFakeTimers();
  const admission = createUpdateAdmission();
  const token = admission.reserve("a".repeat(40));
  await vi.advanceTimersByTimeAsync(29_000);
  const release = admission.commit(token, "a".repeat(40), "main-release");
  expect(typeof release).toBe("string");
  expect(admission.cancel(token)).toBe(false);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(admission.installing()).toBe(true);
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(admission.installing()).toBe(true);
  expect(admission.cancel("main-release")).toBe(true);
  expect(() => admission.admit()).not.toThrow();
  admission.reserve("b".repeat(40));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(admission.installing()).toBe(false);
});
