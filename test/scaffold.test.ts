import { describe, expect, it } from "vitest";
import { CONTRACTS_VERSION } from "@gates-local/contracts";
import { HARNESS_VERSION } from "@gates-local/harness";

describe("workspace", () => {
  it("resolves workspace packages from source", () => {
    expect(CONTRACTS_VERSION).toBeTypeOf("number");
    expect(HARNESS_VERSION).toBeTypeOf("number");
  });
});
