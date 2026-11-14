/// <reference lib="dom" />
// Pages in the desktop app: real Electron main, preload, built client and server; only the
// runtime/GPU are fakes. Each run owns its profile and data, never the person's open app.
// A page runs in a frame at the server's one-time address, main's frame guard keeps the frame
// there (a refresh tag included, with no blank frame allowed), and when Chromium's sandbox is off
// a page shows its code and runs only on a click.
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { openThreadStore } from "../../apps/server/src/threads/store.ts";
import { LEFT_PATH, MOVING, loanPage } from "../fake-ollama/page-replies.ts";
import { FAKE_URL, ROOT } from "./env.ts";
import { expect, test, waitReady } from "./fixtures.ts";

test.beforeAll(async () => {
  await promisify(execFile)("pnpm", ["--filter", "@gates-local/desktop", "build"], { cwd: ROOT });
});

const PAGE_ADDRESS = /^http:\/\/127\.0\.0\.1:\d{1,5}\/pages\/[0-9a-f]{32}$/;
const fenced = (code: string) => `Here it is.\n\n\`\`\`html\n${code}\n\`\`\`\n\nDone.`;
const leftRequests = async () => ((await (await fetch(`${FAKE_URL}/__fake/state`)).json()) as { requests: { path: string }[] }).requests.map((r) => r.path).filter((p) => p.startsWith(LEFT_PATH));

/** A thread holding the loan page, then each page that tries to move its frame. */
function seed(data: string): string {
  const store = openThreadStore(path.join(data, "threads.sqlite"));
  try {
    const now = Date.now();
    const thread = store.createThread({ title: "Pages test" }).id;
    const pages = [loanPage(), ...Object.values(MOVING).map((m) => m.code)];
    pages.forEach((code, i) => {
      store.appendMessage({ threadId: thread, role: "user", content: `page ${i + 1}`, createdAt: now + i * 2 });
      store.appendMessage({ threadId: thread, role: "assistant", content: fenced(code), createdAt: now + i * 2 + 1, model: "qwen3.5:9b" });
    });
    return thread;
  } finally {
    store.close();
  }
}

/**
 * Launches the app on a seeded thread. Playwright adds --no-sandbox to an Electron launch unless
 * told otherwise; with the sandbox off the app is launched as an AppImage launcher does.
 */
async function launch(sandbox: boolean): Promise<{ app: ElectronApplication; page: Page; stderr: string[] }> {
  const work = mkdtempSync(path.join(tmpdir(), "gates-pages-desktop-"));
  const data = path.join(work, "data");
  mkdirSync(data);
  const thread = seed(data);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GATES_LOCAL_USER_DATA: path.join(work, "profile"),
    GATES_LOCAL_DATA_DIR: data,
    GATES_LOCAL_OLLAMA_URL: FAKE_URL,
    GATES_LOCAL_COMFY_URL: "http://127.0.0.1:1",
    GATES_LOCAL_OLLAMA_BINARY: "none",
    GATES_LOCAL_RUNTIME: "discover-only",
    GATES_LOCAL_NVIDIA_SMI: path.join(ROOT, `test/fake-ollama/nvidia-smi.${process.platform === "linux" ? "sh" : "ts"}`),
    GATES_LOCAL_MEMINFO: path.join(ROOT, "test/fake-ollama/meminfo.txt"),
    XDG_DATA_HOME: path.join(work, "xdg"),
  };
  for (const key of ["ELECTRON_RUN_AS_NODE", "GATES_LOCAL_WEB_URL", "GATES_LOCAL_WEB", "GATES_LOCAL_SERVER_ENTRY"]) delete env[key];
  const app = await electron.launch({
    executablePath: createRequire(path.join(ROOT, "apps/desktop/package.json"))("electron") as string,
    args: [path.join(ROOT, "apps/desktop"), "--ozone-platform=x11", ...(sandbox ? [] : ["--no-sandbox"])],
    chromiumSandbox: sandbox,
    env: Object.fromEntries(Object.entries(env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]])),
  });
  const stderr: string[] = [];
  app.process().stderr?.on("data", (b: Buffer) => stderr.push(String(b)));
  const page = await app.firstWindow();
  await page.waitForURL("gates-local://app/index.html");
  await page.evaluate((id) => {
    localStorage.setItem("gates-local.first-run-done", "1");
    location.hash = `thread=${id}`;
  }, thread);
  await page.reload();
  await waitReady(page);
  return { app, page, stderr };
}

const chip = (page: Page, n: number) => page.getByTestId("pages.chip").nth(n);
const outline = (page: Page, testid: string) => page.getByTestId(testid).evaluate((el: HTMLElement) => { el.style.outline = "3px solid #ff2d55"; el.style.outlineOffset = "2px"; });

test("desktop: a page runs by itself at its one-time address, and in its own window", async ({ seededThread }, info) => {
  void seededThread;
  const { app, page } = await launch(true);
  try {
    // the loan page runs, framed at the server's page address, with no blank frame first
    await chip(page, 0).click();
    await expect(page.frameLocator('[data-testid="pages.frame"]').locator("#monthly")).toHaveText("$489.15");
    await expect(page.getByTestId("pages.held")).toHaveCount(0);
    expect(await page.getByTestId("pages.frame").evaluate((f: HTMLIFrameElement) => f.src)).toMatch(PAGE_ADDRESS);
    await outline(page, "pages.panel");
    await page.screenshot({ path: info.outputPath("desktop-page-runs.png") });

    // its own window: a blank window (a window, not a frame) holding the page's frame
    const [popup] = await Promise.all([app.waitForEvent("window"), page.getByTestId("pages.panel.open-window").click()]);
    await expect(popup.frameLocator("iframe").locator("#monthly")).toHaveText("$489.15");
    expect(await popup.evaluate(() => document.querySelector("iframe")?.src ?? "")).toMatch(PAGE_ADDRESS);
    await popup.close();
  } finally {
    await app.close();
  }
});

test("desktop with the sandbox off: a page shows its code and runs only on Run, and main's guard keeps every frame where it is", async ({ seededThread }, info) => {
  void seededThread;
  const { app, page, stderr } = await launch(false);
  try {
    await chip(page, 0).click();
    const held = page.getByTestId("pages.held");
    await expect(held).toHaveText(/Chromium's sandbox is off in this copy, so pages run only on Run/);
    await expect(page.getByTestId("pages.panel.source")).toContainText("<title>Loan calculator</title>");
    await expect(page.getByTestId("pages.frame")).toHaveCount(0);
    await expect(page.getByTestId("pages.panel.open-window")).toBeDisabled();
    await outline(page, "pages.held");
    await page.screenshot({ path: info.outputPath("desktop-sandbox-off-before.png") });

    await page.getByTestId("pages.run").click();
    await expect(page.frameLocator('[data-testid="pages.frame"]').locator("#monthly")).toHaveText("$489.15");
    await expect(held).toHaveCount(0);
    await outline(page, "pages.panel");
    await page.screenshot({ path: info.outputPath("desktop-sandbox-off-after.png") });

    // each page that moves its frame, run, stays put or ends on the error page, and reaches nothing
    const before = await leftRequests();
    for (const [i, label] of Object.keys(MOVING).entries()) {
      await chip(page, i + 1).click();
      await page.getByTestId("pages.run").click();
      await expect(page.getByTestId("pages.frame")).toBeAttached();
      await page.waitForTimeout(1500);
      const urls = page.frames().filter((f) => f !== page.mainFrame()).map((f) => f.url());
      info.annotations.push({ type: "frames", description: `${label}: ${urls.join(" ")}` });
      expect(urls.length, label).toBeGreaterThan(0);
      for (const url of urls) expect(PAGE_ADDRESS.test(url) || url.startsWith("chrome-error:"), `${label}: ${url}`).toBe(true);
    }
    expect(page.url()).toContain("gates-local://app/index.html");
    expect(await leftRequests()).toEqual(before);
    const refusals = stderr.join("").split("\n").filter((l) => l.includes("refused a navigation inside a frame"));
    info.annotations.push({ type: "guard", description: refusals.join(" | ") || "the guard logged no refusal" });
    await appendFile(info.outputPath("notes.txt"), info.annotations.map((a) => `${a.type}: ${a.description}`).join("\n") + "\n");
  } finally {
    await app.close();
  }
});
