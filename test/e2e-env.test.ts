// The E2E stack's default folders follow the checkout it runs from, so two
// checkouts (main and a lane worktree) never share data or results.
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHECKOUT_CACHE, DATA_ROOT, RESULTS_DIR, ROOT, checkoutKey } from "./e2e/env.ts";

describe("E2E env defaults", () => {
  it("names a checkout from its path under home", () => {
    expect(checkoutKey(path.join(homedir(), "projects/ai/gates-local"))).toBe("projects-ai-gates-local");
    expect(checkoutKey(path.join(homedir(), ".cache/gates-local-lanes/e2e-fix/wt"))).toBe("cache-gates-local-lanes-e2e-fix-wt");
    expect(checkoutKey(path.join(homedir(), "a/wt"))).not.toBe(checkoutKey(path.join(homedir(), "b/wt")));
    expect(checkoutKey("/srv/gates-local")).toBe("srv-gates-local");
  });

  it("keeps data and results in this checkout's folder under ~/.cache unless overridden", () => {
    expect(CHECKOUT_CACHE).toBe(path.join(homedir(), ".cache", "gates-local-e2e", checkoutKey(ROOT)));
    if (process.env["GL_E2E_DATA_ROOT"] === undefined) expect(DATA_ROOT).toBe(path.join(CHECKOUT_CACHE, "e2e-data"));
    if (process.env["GL_E2E_RESULTS"] === undefined) expect(RESULTS_DIR).toBe(path.join(CHECKOUT_CACHE, "e2e-results"));
  });
});
