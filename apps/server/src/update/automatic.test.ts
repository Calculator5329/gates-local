import { afterEach, expect, it, vi } from "vitest";
import { automaticChecks } from "./automatic.ts";

afterEach(() => vi.useRealTimers());
function setup(desktop = true, initial = true) {
  vi.useFakeTimers();
  let enabled = initial;
  let changed: () => void = vi.fn();
  const check = vi.fn(async () => undefined);
  const stop = automaticChecks({ desktop, enabled: () => enabled, check, onChange: (l) => { changed = l; return () => { changed = vi.fn(); }; } });
  return { check, stop, enable: (on: boolean) => { enabled = on; changed(); } };
}
it("checks at 15 seconds, then hourly", async () => {
  const s = setup();
  await vi.advanceTimersByTimeAsync(14_999);
  expect(s.check).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(s.check).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(3_599_999);
  expect(s.check).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(s.check).toHaveBeenCalledTimes(2);
  s.stop();
});
it("off means no check, including after disabling a pending timer", async () => {
  const s = setup(true, false);
  await vi.advanceTimersByTimeAsync(7_200_000);
  expect(s.check).not.toHaveBeenCalled();
  s.enable(true);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(s.check).toHaveBeenCalledTimes(1);
  s.enable(false);
  await vi.advanceTimersByTimeAsync(7_200_000);
  expect(s.check).toHaveBeenCalledTimes(1);
  s.stop();
});
it("does not run in a browser-only server", async () => {
  const s = setup(false);
  await vi.advanceTimersByTimeAsync(7_200_000);
  expect(s.check).not.toHaveBeenCalled();
  s.stop();
});
it("offline stays silent and a later check still runs", async () => {
  const s = setup();
  s.check.mockRejectedValueOnce(new Error("offline"));
  await vi.advanceTimersByTimeAsync(15_000);
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(s.check).toHaveBeenCalledTimes(2);
  s.stop();
});
it("shutdown cancels the timer", async () => {
  const s = setup();
  s.stop();
  await vi.advanceTimersByTimeAsync(7_200_000);
  expect(s.check).not.toHaveBeenCalled();
});
