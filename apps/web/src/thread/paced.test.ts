import { describe, expect, it } from "vitest";
import { advancePace, createPace } from "./paced.ts";

describe("steady text pacing", () => {
  it.each([20, 60, 110])("absorbs 240 ms delivery bursts at %s tokens/s with bounded lag", (tokens) => {
    const rate = tokens * 6;
    const p = createPace(0, 0);
    const changes: number[] = [];
    let shown = 0;
    let maxLag = 0;
    for (let frame = 1; frame <= 300; frame++) {
      const now = frame * 1000 / 60;
      const target = Math.floor(Math.floor(now / 240) * .24 * rate);
      const next = advancePace(p, target, true, now);
      if (next > shown) changes.push(next - shown);
      maxLag = Math.max(maxLag, target - next);
      shown = next;
    }
    expect(changes.length).toBeGreaterThan(200);
    expect(Math.max(...changes)).toBeLessThan(rate / 20);
    expect(maxLag).toBeLessThan(rate * .3);
  });

  it("keeps up with a fast continuous model and finishes its tail within 120 ms", () => {
    const p = createPace(0, 0);
    const rate = 110 * 6;
    let shown = 0;
    for (let frame = 1; frame <= 180; frame++) shown = advancePace(p, Math.floor(frame / 60 * rate), true, frame / 60 * 1000);
    expect(3 * rate - shown).toBeLessThan(rate * .25);
    const final = 3 * rate + 100;
    advancePace(p, final, false, 3010);
    expect(advancePace(p, final, false, 3130)).toBe(final);
  });

  it("does not animate historical text or create a backwards prefix", () => {
    const p = createPace(1000, 0);
    expect(advancePace(p, 1000, false, 16)).toBe(1000);
    const live = createPace(0, 0);
    const a = advancePace(live, 100, true, 16);
    const b = advancePace(live, 100, true, 32);
    expect(b).toBeGreaterThan(a);
  });
});
