// Run with the external runner's virtual display. All app data and services are test-owned.
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { _electron, type ElectronApplication, type Page, type TestInfo } from "@playwright/test";
import type { DesktopApi } from "../../apps/desktop/test/paste-api.ts";
import { FAKE_URL, ROOT } from "./env.ts";
import { expect, sendMessage, test, waitReady } from "./fixtures.ts";

type NativeMenu = InstanceType<DesktopApi["Menu"]>;
type MenuProbe = typeof globalThis & { pasteMenus?: NativeMenu[] };
const VISION = "qwen3-vl:8b";
test.use({ installed: [VISION] });

test.beforeAll(async () => {
  await promisify(execFile)("pnpm", ["--filter", "@gates-local/desktop", "build"], { cwd: ROOT });
});

async function desktop(info: TestInfo) {
  const work = await mkdtemp(path.join(tmpdir(), "gates-paste-desktop-"));
  const desktopRoot = path.join(ROOT, "apps/desktop");
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  delete env["ELECTRON_RUN_AS_NODE"];
  delete env["GATES_LOCAL_WEB_URL"];
  delete env["GATES_LOCAL_WEB"];
  const app = await _electron.launch({
    executablePath: createRequire(path.join(desktopRoot, "package.json"))("electron") as string,
    args: [desktopRoot, ...(process.platform === "linux" ? ["--ozone-platform=x11"] : [])],
    env: {
      ...env,
      GATES_LOCAL_USER_DATA: path.join(work, "profile"),
      GATES_LOCAL_DATA_DIR: path.join(work, "data"),
      XDG_DATA_HOME: path.join(work, "xdg"),
      GATES_LOCAL_RUNTIME: "discover-only",
      GATES_LOCAL_OLLAMA_BINARY: "none",
      GATES_LOCAL_OLLAMA_URL: FAKE_URL,
      GATES_LOCAL_COMFY_URL: "http://127.0.0.1:1",
      GATES_LOCAL_NVIDIA_SMI: path.join(ROOT, "test/fake-ollama/nvidia-smi.ts"),
      GATES_LOCAL_MEMINFO: path.join(ROOT, "test/fake-ollama/meminfo.txt"),
    },
    recordVideo: { dir: info.outputPath("desktop-video"), size: { width: 1200, height: 800 } },
  });
  const page = await app.firstWindow();
  await page.waitForURL("gates-local://app/index.html");
  await page.evaluate(() => localStorage.setItem("gates-local.first-run-done", "1"));
  await page.reload();
  await waitReady(page);
  await app.evaluate(({ Menu }: DesktopApi) => {
    const probe = globalThis as MenuProbe;
    probe.pasteMenus = [];
    const popup = Menu.prototype.popup;
    Menu.prototype.popup = function (options) {
      probe.pasteMenus?.push(this);
      popup.call(this, options);
    };
  });
  if (process.env["GL_PASTE_MUTATION"] === "no-handler") await app.evaluate(({ BrowserWindow }: DesktopApi) => {
    BrowserWindow.getAllWindows()[0]!.webContents.removeAllListeners("context-menu");
  });
  return { app, page };
}

async function menuItems(app: ElectronApplication) {
  return app.evaluate(() => (globalThis as MenuProbe).pasteMenus?.at(-1)?.items.map(item => ({ role: item.role, label: item.label, enabled: item.enabled })) ?? []);
}

async function openMenu(app: ElectronApplication, page: Page, selector: string) {
  const before = await app.evaluate(() => (globalThis as MenuProbe).pasteMenus?.length ?? 0);
  // Right-click the caret's actual position: a center click would move it to the end.
  const position = selector === "#ta" ? await page.locator(selector).evaluate((el: HTMLTextAreaElement) => {
    const style = getComputedStyle(el);
    const lines = el.value.slice(0, el.selectionStart).split("\n");
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    return {
      x: parseFloat(style.paddingLeft) + context.measureText(lines.at(-1)!).width + 1 - el.scrollLeft,
      y: parseFloat(style.paddingTop) + (lines.length - 0.5) * parseFloat(style.lineHeight) - el.scrollTop,
    };
  }) : undefined;
  await page.locator(selector).click({ button: "right", ...(position ? { position } : {}) });
  await expect.poll(() => app.evaluate(() => (globalThis as MenuProbe).pasteMenus?.length ?? 0)).toBe(before + 1);
  return menuItems(app);
}

/** Invoke the actual MenuItem role callback after a real right-click opened its native popup. */
async function choose(app: ElectronApplication, roleOrLabel: string) {
  await app.evaluate(({ BrowserWindow }: DesktopApi, key) => {
    const menu = (globalThis as MenuProbe).pasteMenus?.at(-1);
    const item = menu?.items.find(candidate => candidate.role === key || candidate.label.toLowerCase() === key.toLowerCase());
    const window = BrowserWindow.getAllWindows().find(w => !w.webContents.isDevToolsOpened());
    if (!menu || !item?.enabled || !window) throw new Error(`Native menu item ${key} is not available`);
    menu.closePopup(window);
    item.click({}, window, window.webContents);
  }, roleOrLabel);
}

async function screen(app: ElectronApplication, info: TestInfo, name: string) {
  const png = await app.evaluate(async ({ desktopCapturer }: DesktopApi) => {
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1440, height: 900 } });
    const source = sources[0];
    if (!source || source.thumbnail.isEmpty()) throw new Error("The virtual screen capture is empty");
    return source.thumbnail.toPNG().toString("base64");
  });
  await writeFile(info.outputPath(name), Buffer.from(png, "base64"));
}

// Guards a shipped bug fix: a paste that had not arrived yet landed in the next thread after New thread.
test("desktop clipboard paths cannot be read by a timer or a renderer keyboard event", async ({ seededThread }, info) => {
  void seededThread;
  const { app, page } = await desktop(info);
  try {
    await app.evaluate(async ({ clipboard, ClipboardItem }: DesktopApi) => clipboard.write([new ClipboardItem({ "text/uri-list": "file:///srv/docs/a%20b.pdf" })]));
    const read = () => page.evaluate(() => new Promise(resolve => setTimeout(async () => {
      const bridge = (window as Window & { gatesLocal?: { clipboardFilePaths?(): Promise<{ paths: string[]; skipped: boolean }> } }).gatesLocal;
      resolve(await bridge?.clipboardFilePaths?.());
    }, 0)));
    expect(await read()).toBeUndefined();
    await page.locator("#ta").dispatchEvent("keydown", { key: "v", ctrlKey: true });
    expect(await read()).toBeUndefined();
    await page.locator("#ta").focus();
    await page.evaluate(() => {
      Object.assign(window, { stolenPaths: [] });
      window.addEventListener("keydown", () => {
        const bridge = (window as Window & { gatesLocal?: { clipboardFilePaths?(): Promise<unknown> }; stolenPaths?: unknown[] });
        void bridge.gatesLocal?.clipboardFilePaths?.().then(value => bridge.stolenPaths?.push(value));
      }, true);
    });
    await app.evaluate(({ BrowserWindow }: DesktopApi) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      contents.sendInputEvent({ type: "keyDown", keyCode: "V", modifiers: ["control"] });
      contents.sendInputEvent({ type: "keyUp", keyCode: "V", modifiers: ["control"] });
    });
    await expect(page.locator("#ta")).toHaveValue("/srv/docs/a b.pdf");
    expect(await page.evaluate(() => (window as Window & { stolenPaths?: unknown[] }).stolenPaths)).toEqual([]);
    await page.locator("#ta").fill("");
    await app.evaluate(({ clipboard }: DesktopApi) => {
      const delayed = globalThis as typeof globalThis & { pasteReading?: boolean; releasePasteRead?: () => void };
      const original = clipboard.read.bind(clipboard);
      clipboard.read = async (...args) => {
        delayed.pasteReading = true;
        await new Promise<void>(resolve => { delayed.releasePasteRead = resolve; });
        clipboard.read = original;
        return original(...args);
      };
    });
    await page.locator("#ta").focus();
    await app.evaluate(({ BrowserWindow }: DesktopApi) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      contents.sendInputEvent({ type: "keyDown", keyCode: "V", modifiers: ["control"] });
      contents.sendInputEvent({ type: "keyUp", keyCode: "V", modifiers: ["control"] });
    });
    await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & { pasteReading?: boolean }).pasteReading)).toBe(true);
    await page.getByRole("complementary").getByRole("button", { name: /^New thread/ }).click();
    await page.locator("#ta").focus();
    await app.evaluate(() => (globalThis as typeof globalThis & { releasePasteRead?: () => void }).releasePasteRead?.());
    await expect.poll(() => app.evaluate(({ BrowserWindow }: DesktopApi) => BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScriptInIsolatedWorld(1004, [{ code: "globalThis.gatesNativePaste === undefined" }]))).toBe(true);
    await expect(page.locator("#ta")).toHaveValue("");
  } finally { await app.close(); }
});

// Guards the owner's ask (U09) for right-click paste of text, paths and images in the desktop app.
test("desktop paste: native menus, X11 clipboard, undo, toolbar and sidebar coexistence", async ({ seededThread }, info) => {
  void seededThread;
  // This is a new multi-step native journey, with one app launch and screen captures.
  test.setTimeout(60_000);
  const { app, page } = await desktop(info);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    const ta = page.locator("#ta");
    const send = page.getByRole("button", { name: "Send message", exact: true });
    await ta.fill("before after");
    await ta.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(7, 7));
    await app.evaluate(async ({ clipboard }: DesktopApi) => clipboard.writeText("one\ntwo\nthree\nfour\n"));
    const height = (await ta.boundingBox())!.height;
    const roles = await openMenu(app, page, "#ta");
    expect(await ta.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(7);
    expect(roles.map(item => item.role || item.label.toLowerCase())).toEqual(["cut", "copy", "paste", "selectall"]);
    expect(roles.find(item => item.label === "Paste")?.enabled).toBe(true);
    await screen(app, info, "native-paste-menu.png");
    await choose(app, "paste");
    await expect(ta).toHaveValue("before one\ntwo\nthree\nfour\nafter");
    expect((await ta.boundingBox())!.height).toBeGreaterThan(height);
    await ta.press("Control+z");
    await expect(ta).toHaveValue("before after");

    await ta.selectText();
    await openMenu(app, page, "#ta");
    await choose(app, "copy");
    expect(await app.evaluate(async ({ clipboard }: DesktopApi) => clipboard.readText())).toBe("before after");
    await openMenu(app, page, "#ta");
    await choose(app, "cut");
    await expect(ta).toHaveValue("");
    await ta.press("Control+z");
    await expect(ta).toHaveValue("before after");
    await ta.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(3, 3));
    await openMenu(app, page, "#ta");
    await choose(app, "selectall");
    expect(await ta.evaluate((el: HTMLTextAreaElement) => el.selectionEnd - el.selectionStart)).toBe(12);

    await app.evaluate(async ({ clipboard, ClipboardItem }: DesktopApi) => clipboard.write([new ClipboardItem({
      "text/uri-list": "file:///srv/docs/a%20b.pdf\r\nfile:///srv/pictures/%E9%9B%AA.png\r\nhttps://example.com/ignored\r\nfile:///srv/bad%0Aname.pdf",
    })]));
    // Timer-driven renderer code has no trusted paste gesture in main.
    expect(await page.evaluate(() => new Promise(resolve => setTimeout(async () => {
      const bridge = (window as Window & { gatesLocal?: { clipboardFilePaths?(): Promise<string[]> } }).gatesLocal;
      resolve(await bridge?.clipboardFilePaths?.());
    }, 0)))).toBeUndefined();
    await ta.fill("see  please");
    await ta.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(4, 4));
    await openMenu(app, page, "#ta");
    await choose(app, "paste");
    await expect(ta).toHaveValue("see /srv/docs/a b.pdf\n/srv/pictures/雪.png please");
    await expect(page.getByRole("status").filter({ hasText: "control characters" })).toBeVisible();
    await expect(page.locator(".att img")).toHaveCount(0);
    await ta.press("Control+z");
    await expect(ta).toHaveValue("see  please");

    // These are synthetic raw X11 payloads, not a real KDE/GNOME file-manager session.
    for (const format of ["application/x-kde4-urilist", "x-special/gnome-copied-files", "x-special/nautilus-clipboard"]) {
      await ta.fill("");
      await app.evaluate(async ({ clipboard, ClipboardItem }: DesktopApi, raw) => clipboard.write([new ClipboardItem({
        [`electron application/osclipboard;format="${raw}"`]: "copy\nfile:///srv/docs/a%20b.pdf\nfile:///srv/pictures/%E9%9B%AA.png",
        "text/plain": "Fallback text must not replace the file-list paths",
      })]), format);
      await openMenu(app, page, "#ta");
      await choose(app, "paste");
      await expect(ta).toHaveValue("/srv/docs/a b.pdf\n/srv/pictures/雪.png");
    }

    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 80; canvas.height = 48;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#666666"; context.fillRect(0, 0, 80, 48);
      context.fillStyle = "#eeeeee"; context.fillRect(8, 8, 24, 24);
      return canvas.toDataURL("image/png").split(",")[1]!;
    });
    await ta.fill("");
    const before = await send.boundingBox();
    await app.evaluate(async ({ clipboard, ClipboardItem }: DesktopApi, bytes) => clipboard.write([new ClipboardItem({
      "image/png": new Blob([Uint8Array.from(Buffer.from(bytes, "base64"))], { type: "image/png" }),
      "text/plain": "Mixed text loses to the copied image",
    })]), png);
    await openMenu(app, page, "#ta");
    await choose(app, "paste");
    await expect(page.locator(".att img")).toHaveCount(1);
    await expect(ta).toHaveValue("");
    await expect.poll(() => page.locator(".att img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(80);
    expect((await send.boundingBox())!.y).toBe(before!.y);
    await page.mouse.move(20, 20);
    await page.screenshot({ path: info.outputPath("desktop-attachment.png") });

    const imageMenu = await openMenu(app, page, ".att img");
    expect(imageMenu.some(item => item.label === "Copy Image" && item.enabled)).toBe(true);
    await screen(app, info, "native-copy-image-menu.png");
    await app.evaluate(({ clipboard }: DesktopApi) => clipboard.clear());
    await choose(app, "Copy Image");
    await expect.poll(() => app.evaluate(({ clipboard }: DesktopApi) => clipboard.has("image/png"))).toBe(true);
    await page.getByRole("button", { name: "Remove image 1", exact: true }).click();
    expect((await send.boundingBox())!.y).toBe(before!.y);
    await ta.focus();
    await app.evaluate(({ BrowserWindow }: DesktopApi) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      contents.sendInputEvent({ type: "keyDown", keyCode: "V", modifiers: ["control"] });
      contents.sendInputEvent({ type: "keyUp", keyCode: "V", modifiers: ["control"] });
    });
    await expect(page.locator(".att img")).toHaveCount(1);
    await expect.poll(() => page.locator(".att img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(80);

    await sendMessage(page, "Describe the pasted image");
    await expect(page.locator(".turn.a.done")).toHaveCount(1);
    const menuCount = await app.evaluate(() => (globalThis as MenuProbe).pasteMenus?.length ?? 0);
    await page.locator(".sb-row").first().click({ button: "right" });
    await expect(page.getByRole("menu", { name: "Thread actions", exact: true })).toBeVisible();
    expect(await app.evaluate(() => (globalThis as MenuProbe).pasteMenus?.length ?? 0)).toBe(menuCount);
    await page.screenshot({ path: info.outputPath("sidebar-menu.png") });
    await screen(app, info, "sidebar-screen.png");
    await page.keyboard.press("Escape");
    await page.locator(".turn.a .md").evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el);
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    });
    const selected = await openMenu(app, page, ".turn.a .md");
    expect(selected.find(item => item.role === "copy")?.enabled).toBe(true);
    await choose(app, "copy");
    expect(await app.evaluate(async ({ clipboard }: DesktopApi) => clipboard.readText())).not.toBe("");
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});
