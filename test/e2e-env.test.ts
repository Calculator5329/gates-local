// The E2E stack's default folders follow the checkout it runs from, so two
// checkouts (main and a lane worktree) never share data or results.
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHECKOUT_CACHE, DATA_ROOT, RESULTS_DIR, ROOT, checkoutKey } from "./e2e/env.ts";

const h = (rel: string) => checkoutKey(path.join(homedir(), rel));

describe("E2E env defaults", () => {
  it("names a checkout from its path under home", () => {
    expect(checkoutKey(path.join(homedir(), "projects/ai/gates-local"))).toMatch(/^projects-ai-gates-local-[0-9a-f]{8}$/);
    expect(checkoutKey(path.join(homedir(), ".cache/gates-local-lanes/e2e-fix/wt"))).toMatch(/^cache-gates-local-lanes-e2e-fix-wt-[0-9a-f]{8}$/);
    expect(checkoutKey(path.join(homedir(), "a/wt"))).not.toBe(checkoutKey(path.join(homedir(), "b/wt")));
    // Outside home the absolute path names it; on Windows that path starts with a drive.
    if (process.platform === "win32") expect(checkoutKey("D:\\srv\\gates-local")).toMatch(/^D-srv-gates-local-[0-9a-f]{8}$/);
    else expect(checkoutKey("/srv/gates-local")).toMatch(/^srv-gates-local-[0-9a-f]{8}$/);
    // the same checkout always gets the same folder
    expect(checkoutKey(path.join(homedir(), "projects/ai/gates-local"))).toBe(checkoutKey(path.join(homedir(), "projects/ai/gates-local/")));
  });

  it("two checkouts whose paths differ only in separators get different folders", () => {
    expect(h("a/b-wt")).not.toBe(h("a-b/wt"));
    expect(h(".cache/gates-local-lanes/e2e-fix/wt")).not.toBe(h(".cache/gates-local-lanes/e2e/fix/wt"));
    expect(checkoutKey("/srv/a.b")).not.toBe(checkoutKey("/srv/a-b"));
  });

  it("keeps data and results in this checkout's folder under ~/.cache unless overridden", () => {
    expect(CHECKOUT_CACHE).toBe(path.join(homedir(), ".cache", "gates-local-e2e", checkoutKey(ROOT)));
    if (process.env["GL_E2E_DATA_ROOT"] === undefined) expect(DATA_ROOT).toBe(path.join(CHECKOUT_CACHE, "e2e-data"));
    if (process.env["GL_E2E_RESULTS"] === undefined) expect(RESULTS_DIR).toBe(path.join(CHECKOUT_CACHE, "e2e-results"));
  });
});
