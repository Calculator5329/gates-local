/// <reference lib="dom" />
// Real Electron main, preload, built client and server; only the runtime/GPU
// are fakes. Each run owns its profile and data, never the person's open app.
import { mkdtempSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "@playwright/test";
import { openThreadStore } from "../../apps/server/src/threads/store.ts";
import { FAKE_URL, ROOT } from "./env.ts";
import { expect, test, waitReady } from "./fixtures.ts";
import { seedLong } from "./seed.ts";

test("Electron's denied clipboard permission still copies messages and code", async ({ seededThread }, info) => {
  void seededThread;
  const work = mkdtempSync(path.join(tmpdir(), "gates-copy-desktop-"));
  const data = path.join(work, "data");
  mkdirSync(data);
  const thread = seedLong(path.join(data, "threads.sqlite"), 2, Date.now(), "Clipboard test");
  const message = "  Exact **markdown**, café 🦀\n\tsecond line  \n";
  const code = "  echo 'café 🦀'\n\tprintf '%s' exact  \n";
  const store = openThreadStore(path.join(data, "threads.sqlite"));
  try {
    store.appendMessage({ threadId: thread, role: "user", content: message, createdAt: Date.now() });
    store.appendMessage({ threadId: thread, role: "assistant", content: `A block:\n\n\`\`\`sh\n${code}\n\`\`\``, createdAt: Date.now(), model: "qwen3.5:9b" });
  } finally {
    store.close();
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GATES_LOCAL_USER_DATA: path.join(work, "profile"),
    GATES_LOCAL_DATA_DIR: data,
    GATES_LOCAL_OLLAMA_URL: FAKE_URL,
    GATES_LOCAL_OLLAMA_BINARY: "none",
    GATES_LOCAL_RUNTIME: "discover-only",
    GATES_LOCAL_NVIDIA_SMI: path.join(ROOT, "test/fake-ollama/nvidia-smi.ts"),
    GATES_LOCAL_MEMINFO: path.join(ROOT, "test/fake-ollama/meminfo.txt"),
    XDG_DATA_HOME: path.join(work, "xdg"),
  };
  for (const key of ["ELECTRON_RUN_AS_NODE", "GATES_LOCAL_WEB_URL", "GATES_LOCAL_WEB", "GATES_LOCAL_SERVER_ENTRY"]) delete env[key];
  const app = await electron.launch({
    executablePath: createRequire(path.join(ROOT, "apps/desktop/package.json"))("electron") as string,
    args: [path.join(ROOT, "apps/desktop"), "--ozone-platform=x11"],
    env: Object.fromEntries(Object.entries(env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]])),
  });
  try {
    const page = await app.firstWindow();
    await page.waitForURL("gates-local://app/index.html");
    await page.evaluate((id) => {
      localStorage.setItem("gates-local.first-run-done", "1");
      location.hash = `thread=${id}`;
    }, thread);
    await page.reload();
    await waitReady(page);
    await expect(page.locator(".turn")).toHaveCount(4);
    expect(await page.evaluate(() => typeof navigator.clipboard?.writeText), "the native API must exist for a permission-denial check").toBe("function");
    const denied = await page.evaluate(async () => {
      try {
        await navigator.clipboard.writeText("permission probe");
        return "allowed";
      } catch (error) {
        return error instanceof DOMException ? error.name : "unexpected error";
      }
    });
    expect(denied, "the production permission handler denies the native API").toBe("NotAllowedError");
    for (const [selector, expected] of [
      [".turn.u [data-copy]", message],
      [".cb-copy", code],
    ]) {
      if (!selector || expected === undefined) throw new Error("Missing clipboard case");
      await app.evaluate(({ clipboard }) => clipboard.writeText("clipboard sentinel"));
      await page.locator(selector).last().click();
      await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(expected);
    }
    await page.screenshot({ path: info.outputPath("electron-copy.png") });
  } finally {
    await app.close();
  }
});
