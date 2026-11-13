// The E2E stack's default folders follow the checkout it runs from, so two
// checkouts (main and a lane worktree) never share data or results.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHECKOUT_CACHE, DATA_ROOT, RESULTS_DIR, ROOT, checkoutKey } from "./e2e/env.ts";

/** Where test code that starts the server lives: the e2e and perf stacks, desktop launches, packaged checks. */
const LAUNCH_DIRS = ["test", "apps/server/test", "apps/desktop/test", "apps/desktop/scripts"];
const source = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
/** Every file that gives a server its environment: each one names the Ollama it talks to. */
function launchers(): string[] {
  return LAUNCH_DIRS.flatMap((dir) => {
    let files: string[];
    try { files = readdirSync(path.join(ROOT, dir), { recursive: true, encoding: "utf8" }); } catch { return []; }
    return files.map((f) => `${dir}/${f.replaceAll("\\", "/")}`);
  }).filter((f) => /\.[cm]?[jt]s$/.test(f) && !f.includes("node_modules/") && /GATES_LOCAL_OLLAMA_URL\s*:/.test(source(f)));
}

describe("a server started by a test never reaches this machine's ComfyUI", () => {
  it("every launcher sets GATES_LOCAL_COMFY_URL, and none to the local 8188", () => {
    const found = launchers();
    expect(found, "the scan still finds the stacks").toEqual(expect.arrayContaining(["test/e2e/stack.ts", "test/perf/stack.ts", "apps/server/test/main.test.ts"]));
    // unset, the server uses 127.0.0.1:8188 and starts and stops comfyui.service through systemctl
    expect(found.filter((f) => !/GATES_LOCAL_COMFY_URL\s*:/.test(source(f))), "launchers that leave GATES_LOCAL_COMFY_URL unset").toEqual([]);
    expect(found.filter((f) => /GATES_LOCAL_COMFY_URL\s*:\s*["'`][^"'`]*:8188\b/.test(source(f))), "launchers that set it to the real port").toEqual([]);
  });
});

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
