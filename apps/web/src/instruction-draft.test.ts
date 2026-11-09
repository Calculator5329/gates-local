import { describe, expect, it } from "vitest";
import { controlPatch, controlValues, editControl } from "./instruction-draft.ts";

describe("MS-01: edited controls", () => {
  it("sends only temperature when that is all the person edited", () => {
    const draft = editControl({}, {}, "temperature", "0.5");
    expect(controlPatch(draft)).toEqual({ temperature: 0.5 });
  });
  it("follows another client's untouched seed without overwriting the temperature draft", () => {
    const draft = editControl({}, {}, "temperature", "0.5");
    expect(controlValues({ temperature: 0.9, seed: 42 }, draft)).toMatchObject({ temperature: "0.5", seed: "42" });
    expect({ seed: 42, ...controlPatch(draft) }).toEqual({ temperature: 0.5, seed: 42 });
  });
  it("only clears the field explicitly reset, preserving a different client's new value", () => {
    const draft = editControl({ top_k: 12 }, {}, "top_k", null);
    expect(controlPatch(draft)).toEqual({ top_k: null });
    expect(controlValues({ top_k: 12, seed: 42 }, draft).seed).toBe("42");
  });
  it("keeps two deliberate edits when saved values change underneath them", () => {
    const first = editControl({}, {}, "temperature", "0.5");
    const next = editControl({ seed: 99 }, first, "seed", "42");
    expect(controlValues({ temperature: 1, seed: 100 }, next)).toMatchObject({ temperature: "0.5", seed: "42" });
  });
  it("drops a reverted field using its original value even if a remote change arrived during the edit", () => {
    const draft = editControl({ temperature: 0.5 }, {}, "temperature", "0.6");
    const reverted = editControl({ temperature: 0.7 }, draft, "temperature", "0.5");
    expect(reverted).toEqual({});
    expect(controlValues({ temperature: 0.7 }, reverted).temperature).toBe("0.7");
  });
  it("compares numeric values rather than their display spelling", () => {
    const draft = editControl({ temperature: 0.5 }, {}, "temperature", "0.6");
    expect(editControl({ temperature: 0.5 }, draft, "temperature", "0.50")).toEqual({});
  });
  it("keeps an empty numeric edit instead of treating it as a reversion to zero", () => {
    const draft = editControl({ temperature: 0 }, {}, "temperature", "");
    expect(controlValues({ temperature: 0 }, draft).temperature).toBe("");
    expect(draft).toHaveProperty("temperature");
  });
  it("drops an override when the person returns it to the original inherited state", () => {
    const draft = editControl({}, {}, "temperature", "0");
    expect(editControl({ temperature: 0.7 }, draft, "temperature", null)).toEqual({});
  });
});
