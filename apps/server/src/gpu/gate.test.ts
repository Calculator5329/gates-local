import { describe, expect, it } from "vitest";
import { createFifoGate } from "./gate.ts";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("the load gate", () => {
  it("runs one at a time in arrival order, and a run that throws lets the next one in", async () => {
    const gate = createFifoGate();
    const seen: string[] = [];
    let open!: () => void;
    const first = gate(async () => {
      seen.push("first in");
      await new Promise<void>((resolve) => { open = resolve; });
      seen.push("first out");
      throw new Error("first failed");
    });
    const second = gate(async () => { seen.push("second in"); return 2; });
    await turn();
    expect(seen).toEqual(["first in"]);
    open();
    await expect(first).rejects.toThrow("first failed");
    await expect(second).resolves.toBe(2);
    expect(seen).toEqual(["first in", "first out", "second in"]);
  });
});
