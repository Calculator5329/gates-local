// Real-Electron smoke for the roadmap Accept line, with no visible window:
// Chromium's headless Ozone backend, DISPLAY and WAYLAND_DISPLAY removed.
// Uses the fake server and fake client from test/fixtures, drives the page
// over the DevTools protocol, and checks:
//   1. the client loads and the bridge gives a ws:// URL with a 64-hex token;
//   2. the renderer has no require/process (sandbox + context isolation);
//   3. SIGKILL of the server shows the local error view with the reason;
//   4. its Restart button brings the client back at the same route (#thread=42)
//      with a new token;
//   5. SIGTERM to Electron stops every server it spawned;
//   6. SIGKILL of Electron main takes the server down too (stdin EOF path);
//   7. no application menu and no menu bar, and Alt does not bring one back;
//   8. the window keys work without a menu: Ctrl +/-/0 zoom, F11 full
//      screen, Ctrl+Shift+I dev tools, Ctrl+R and Ctrl+Shift+R reload;
//   9. Ctrl+A, Ctrl+C, Ctrl+V and Ctrl+Z still edit a textarea;
//  10. Ctrl+W closes the window and the app quits, servers gone;
//  11. Ctrl+Q quits, servers gone.
// Keys 7-11 go in through webContents.sendInputEvent over the main
// process's inspector (--inspect): it enters where OS keys do, before
// before-input-event. DevTools-protocol key events skip that hook.
//  12. --background starts the server with no window, and the phone knobs
//      plus the dist dir (GATES_LOCAL_WEB_ROOT) reach the server child;
//  13. a second launch opens the window on the running instance, one server;
//  14. closing that window keeps Electron and the server running;
//  15. a second --background launch opens nothing; SIGTERM stops the server.
// Run: pnpm --filter @gates-local/desktop smoke (builds first). Not part of
// pnpm verify: it needs the downloaded Electron binary.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { findFreePort } from "../src/supervisor.ts";

const root = path.resolve(import.meta.dirname, "..");
const electronBin = createRequire(import.meta.url)("electron") as string;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (line: string) => console.log(`[smoke] ${line}`);

function fail(message: string): never {
  throw new Error(message);
}

function serverPids(dataDir: string): number[] {
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir)
    .filter((name) => name.startsWith("launch-"))
    .map((name) => (JSON.parse(readFileSync(path.join(dataDir, name), "utf8")) as { pid: number }).pid);
}

const alive = (pid: number) => existsSync(`/proc/${pid}`);

async function waitGone(pids: number[], ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end && pids.some(alive)) await sleep(50);
  return !pids.some(alive);
}

function launch(
  work: string,
  debugPort: number | null,
  extraArgs: readonly string[] = [],
  extraEnv: NodeJS.ProcessEnv = {},
  inspectPort: number | null = null,
): { electron: ChildProcess; dataDir: string; exited: Promise<number | null> } {
  const dataDir = path.join(work, `data-${Date.now()}`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extraEnv,
    GATES_LOCAL_SERVER_ENTRY: path.join(root, "test", "fixtures", "fake-server.ts"),
    GATES_LOCAL_WEB_URL: pathToFileURL(path.join(root, "test", "fixtures", "client.html")).toString(),
    GATES_LOCAL_DATA_DIR: dataDir,
    GATES_LOCAL_USER_DATA: path.join(work, "user-data"),
    FAKE_MODE: "ready",
  };
  delete env["DISPLAY"];
  delete env["WAYLAND_DISPLAY"];
  delete env["ELECTRON_RUN_AS_NODE"];
  const args = [root, "--ozone-platform=headless", ...extraArgs];
  if (debugPort !== null) args.push(`--remote-debugging-port=${debugPort}`);
  if (inspectPort !== null) args.push(`--inspect=127.0.0.1:${inspectPort}`);
  const electron = spawn(electronBin, args, { env, stdio: ["ignore", "ignore", "pipe"] });
  const stderr: string[] = [];
  electron.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
  const exited = new Promise<number | null>((resolve) => electron.once("exit", (code) => resolve(code)));
  electron.once("exit", (code, signal) => {
    if (code !== 0 && signal === null) console.error(stderr.join("").split("\n").filter((l) => !l.includes("ERROR:ui/gl") && !l.includes("ANGLE")).slice(-20).join("\n"));
  });
  return { electron, dataDir, exited };
}

class Cdp {
  readonly #ws: WebSocket;
  readonly #pending = new Map<number, (value: unknown) => void>();
  #id = 0;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: { result?: { value?: unknown } } };
      if (message.id === undefined) return;
      this.#pending.get(message.id)?.(message.result?.result?.value);
      this.#pending.delete(message.id);
    });
  }

  /** The page target of --remote-debugging-port, or with "node" the main process of --inspect. */
  static async connect(port: number, type: "page" | "node" = "page"): Promise<Cdp> {
    for (let i = 0; i < 150; i++) {
      try {
        const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
        const page = list.find((target) => target.type === type);
        if (page !== undefined) {
          const ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise((resolve, reject) => {
            ws.addEventListener("open", resolve);
            ws.addEventListener("error", reject);
          });
          return new Cdp(ws);
        }
      } catch {
        // not up yet
      }
      await sleep(100);
    }
    return fail(`no DevTools ${type} target`);
  }

  async send(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++this.#id;
    return await new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** includeCommandLineAPI gives the main process's inspector require(). */
  async eval(expression: string): Promise<unknown> {
    return await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true });
  }

  async until(expression: string, label: string, ms = 15_000): Promise<unknown> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const value = await this.eval(expression).catch(() => null);
      if (value !== null && value !== undefined && value !== false && value !== "") return value;
      await sleep(100);
    }
    return fail(`timed out waiting for ${label}; page at ${String(await this.eval("location.href"))}`);
  }

  close(): void {
    this.#ws.close();
  }
}

const tokenOf = (url: string) => new URL(url).searchParams.get("token") ?? "";

async function lifecycle(work: string): Promise<void> {
  const debugPort = await findFreePort();
  const { electron, dataDir, exited } = launch(work, debugPort);
  try {
    const cdp = await Cdp.connect(debugPort);
    const url1 = String(await cdp.until(`location.protocol === "file:" && window.__serverUrl`, "client ready"));
    if (!/^ws:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{64}$/.test(url1)) fail(`unexpected server URL shape: ${url1.replace(/token=.*/, "token=…")}`);
    log("1 client loaded; bridge URL ws://127.0.0.1:<port>/?token=<64 hex>");
    const leaks = await cdp.eval(`[typeof require, typeof process].join(",")`);
    if (leaks !== "undefined,undefined") fail(`renderer sees Node globals: ${String(leaks)}`);
    log("2 renderer has no require/process");

    await cdp.eval(`location.hash = "#thread=42"`);
    const [first] = serverPids(dataDir);
    if (first === undefined) fail("no server launch recorded");
    process.kill(first, "SIGKILL");
    const text = String(await cdp.until(`location.protocol === "data:" && document.body.innerText.includes("SIGKILL") && document.body.innerText`, "error view"));
    log(`3 error view: ${JSON.stringify(text.split("\n").filter(Boolean).slice(0, 2).join(" / "))}`);

    await cdp.eval(`document.querySelector('button[data-action="restart"]').click(), true`);
    const url2 = String(await cdp.until(`location.protocol === "file:" && window.__serverUrl`, "client back after restart"));
    const hash = await cdp.eval("location.hash");
    if (hash !== "#thread=42") fail(`route not restored: ${String(hash)}`);
    if (tokenOf(url2) === tokenOf(url1)) fail("token did not change across launches");
    log("4 restart brought the client back at #thread=42 with a new token");
    cdp.close();

    const pids = serverPids(dataDir);
    electron.kill("SIGTERM");
    const code = await exited;
    if (!(await waitGone(pids, 4_000))) fail(`servers left after quit: ${pids.filter(alive).join(" ")}`);
    log(`5 SIGTERM to Electron: exit ${String(code)}, servers ${pids.join(", ")} gone`);
  } finally {
    if (electron.exitCode === null && electron.signalCode === null) electron.kill("SIGKILL");
  }
}

async function parentDeath(work: string): Promise<void> {
  const { electron, dataDir, exited } = launch(work, null);
  try {
    const end = Date.now() + 15_000;
    while (serverPids(dataDir).length === 0 && Date.now() < end) await sleep(100);
    await sleep(500);
    const pids = serverPids(dataDir);
    if (pids.length === 0 || !pids.every(alive)) fail("server did not come up");
    electron.kill("SIGKILL");
    await exited;
    if (!(await waitGone(pids, 4_000))) fail(`server ${pids.join(" ")} outlived a SIGKILLed Electron main`);
    log(`6 SIGKILL of Electron main: server ${pids.join(", ")} gone`);
  } finally {
    if (electron.exitCode === null && electron.signalCode === null) electron.kill("SIGKILL");
  }
}

/** The one window, as main's inspector sees it. */
const WIN = `require("electron").BrowserWindow.getAllWindows()[0]`;

type Mod = "control" | "shift" | "alt";

/** A key into the window the way the OS delivers one; down only for keys that end the window. */
async function press(main: Cdp, keyCode: string, modifiers: Mod[] = [], up = true): Promise<void> {
  const event = (type: string) => `${WIN}.webContents.sendInputEvent(${JSON.stringify({ type, keyCode, modifiers })})`;
  const sent = await main.eval(`(${event("keyDown")}, ${up ? `${event("keyUp")}, ` : ""}true)`);
  if (sent !== true) fail(`could not send ${[...modifiers, keyCode].join("+")}`);
}

async function keys(work: string): Promise<void> {
  const debugPort = await findFreePort();
  const inspectPort = await findFreePort();
  const { electron, dataDir, exited } = launch(work, debugPort, [], {}, inspectPort);
  try {
    const main = await Cdp.connect(inspectPort, "node");
    const page = await Cdp.connect(debugPort);
    await page.until(`location.protocol === "file:" && window.__serverUrl`, "client ready");
    await main.until(`${WIN}.webContents.getURL().startsWith("file:")`, "window on the client");

    const menu = async () => String(await main.eval(`[require("electron").Menu.getApplicationMenu() === null, ${WIN}.isMenuBarVisible()].join(",")`));
    if ((await menu()) !== "true,false") fail(`menu (none set, bar hidden) expected true,false, got ${await menu()}`);
    await press(main, "Alt");
    await press(main, "Alt");
    if ((await menu()) !== "true,false") fail(`Alt brought a menu back: ${await menu()}`);
    log("7 no application menu, no menu bar, Alt leaves it so");

    const zoom = async () => Number(await main.eval(`${WIN}.webContents.getZoomLevel()`));
    const steps: Array<[string, Mod[], number]> = [["=", ["control"], 0.5], ["Plus", ["control", "shift"], 1], ["-", ["control"], 0.5], ["0", ["control"], 0]];
    for (const [keyCode, mods, want] of steps) {
      await press(main, keyCode, mods);
      if ((await zoom()) !== want) fail(`${[...mods, keyCode].join("+")} gave zoom ${await zoom()}, want ${want}`);
    }
    // Headless Ozone has no full screen (setFullScreen(true) leaves
    // isFullScreen() false, measured 2026-11-07), so the window's own
    // setFullScreen records what F11 asked for, and isFullScreen answers
    // from that record.
    await main.eval(`(() => { const w = ${WIN}; const set = w.setFullScreen.bind(w); globalThis.__full = []; w.setFullScreen = (flag) => { __full.push(flag); set(flag); }; w.isFullScreen = () => __full.at(-1) === true; return true; })()`);
    await press(main, "F11");
    await press(main, "F11");
    const full = JSON.stringify(await main.eval(`globalThis.__full`));
    if (full !== "[true,false]") fail(`F11 twice asked the window for full screen ${full}, want [true,false]`);
    await press(main, "I", ["control", "shift"]);
    await main.until(`${WIN}.webContents.isDevToolsOpened()`, "Ctrl+Shift+I dev tools open");
    await press(main, "I", ["control", "shift"]);
    await main.until(`!${WIN}.webContents.isDevToolsOpened()`, "Ctrl+Shift+I dev tools closed");
    for (const [keyCode, mods] of [["R", ["control"]], ["R", ["control", "shift"]]] as Array<[string, Mod[]]>) {
      await page.eval(`window.__mark = 1`);
      await press(main, keyCode, mods);
      await page.until(`window.__mark === undefined && window.__serverUrl`, `${[...mods, keyCode].join("+")} reload`);
    }
    log("8 Ctrl +/-/0 zoom 0.5, 1, 0.5, 0; F11 asked for full screen on, then off; Ctrl+Shift+I dev tools on/off; Ctrl+R and Ctrl+Shift+R reload");

    await page.eval(`(() => { const t = document.createElement("textarea"); t.id = "ta"; document.body.append(t); return true; })()`);
    await main.eval(`${WIN}.webContents.focus()`);
    await page.eval(`document.getElementById("ta").focus()`);
    await page.send("Input.insertText", { text: "hello" });
    const ta = async () => JSON.stringify(await page.eval(`(() => { const t = document.getElementById("ta"); return [t.value, t.selectionStart, t.selectionEnd]; })()`));
    await press(main, "a", ["control"]);
    if ((await ta()) !== `["hello",0,5]`) fail(`Ctrl+A did not select all: ${await ta()}`);
    await press(main, "c", ["control"]);
    await press(main, "End");
    await press(main, "v", ["control"]);
    await page.until(`document.getElementById("ta").value === "hellohello"`, "Ctrl+C then Ctrl+V");
    await press(main, "z", ["control"]);
    await page.until(`document.getElementById("ta").value === "hello"`, "Ctrl+Z");
    log("9 Ctrl+A selected hello, Ctrl+C then Ctrl+V gave hellohello, Ctrl+Z gave hello");

    const pids = serverPids(dataDir);
    page.close();
    await press(main, "w", ["control"], false);
    main.close();
    const code = await Promise.race([exited, sleep(10_000).then(() => "timeout")]);
    if (code !== 0) fail(`Ctrl+W: Electron did not quit cleanly (${String(code)})`);
    if (!(await waitGone(pids, 4_000))) fail(`servers left after Ctrl+W: ${pids.filter(alive).join(" ")}`);
    log(`10 Ctrl+W closed the window: exit 0, servers ${pids.join(", ")} gone`);
  } finally {
    if (electron.exitCode === null && electron.signalCode === null) electron.kill("SIGKILL");
  }
}

async function quitKey(work: string): Promise<void> {
  const inspectPort = await findFreePort();
  const { electron, dataDir, exited } = launch(work, null, [], {}, inspectPort);
  try {
    const main = await Cdp.connect(inspectPort, "node");
    await main.until(`${WIN}?.webContents.getURL().startsWith("file:")`, "window on the client");
    const pids = serverPids(dataDir);
    if (pids.length === 0) fail("server did not come up");
    await press(main, "q", ["control"], false);
    main.close();
    const code = await Promise.race([exited, sleep(10_000).then(() => "timeout")]);
    if (code !== 0) fail(`Ctrl+Q: Electron did not quit cleanly (${String(code)})`);
    if (!(await waitGone(pids, 4_000))) fail(`servers left after Ctrl+Q: ${pids.filter(alive).join(" ")}`);
    log(`11 Ctrl+Q quit: exit 0, servers ${pids.join(", ")} gone`);
  } finally {
    if (electron.exitCode === null && electron.signalCode === null) electron.kill("SIGKILL");
  }
}

async function pages(debugPort: number): Promise<number> {
  const list = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) as Array<{ type: string }>;
  return list.filter((target) => target.type === "page").length;
}

async function untilTrue(probe: () => Promise<boolean> | boolean, label: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await Promise.resolve(probe()).catch(() => false)) return;
    await sleep(100);
  }
  fail(`timed out waiting for ${label}`);
}

/** A second launch must hand off to the running instance and exit 0 within 10 s; the caller kills it in finally either way. */
async function handsOff(second: ReturnType<typeof launch>, label: string): Promise<number> {
  const code = await Promise.race([second.exited, sleep(10_000).then(() => "hung" as const)]);
  if (code === "hung") fail(`${label} did not hand off to the running instance and exit within 10 s`);
  if (code !== 0) fail(`${label} exited ${String(code)}, not 0`);
  return code;
}

/** Background mode: no window at start, a second launch opens one, closing it keeps the one server, SIGTERM stops it. */
async function background(work: string): Promise<void> {
  const debugPort = await findFreePort();
  const phone = {
    GATES_LOCAL_WEB_LISTEN: `unix:${path.join(work, "run", "phone.sock")}`,
    GATES_LOCAL_WEB_ORIGIN: "https://hub.example.ts.net:8456",
    GATES_LOCAL_WEB_USER: "owner@example.com",
  };
  const { electron, dataDir, exited } = launch(work, debugPort, ["--background"], phone);
  // Every second launch, so a hung one never outlives the smoke.
  const seconds: ChildProcess[] = [];
  try {
    await untilTrue(() => serverPids(dataDir).length === 1 && serverPids(dataDir).every(alive), "the background server");
    const [pid] = serverPids(dataDir);
    await untilTrue(async () => (await pages(debugPort)) >= 0, "DevTools up");
    await sleep(1000);
    if ((await pages(debugPort)) !== 0) fail("a background launch opened a window");
    const record = JSON.parse(readFileSync(path.join(dataDir, `launch-${String(pid)}.json`), "utf8")) as { webRoot?: string; phoneUser?: string };
    if (record.webRoot !== path.resolve(root, "..", "web", "dist")) fail(`server child got GATES_LOCAL_WEB_ROOT=${String(record.webRoot)}`);
    if (record.phoneUser !== phone.GATES_LOCAL_WEB_USER) fail("server child did not get GATES_LOCAL_WEB_USER");
    log("12 --background: server up, no window, phone knobs and the dist dir passed to the server");

    const again = launch(work, null);
    seconds.push(again.electron);
    const againCode = await handsOff(again, "a second launch");
    const cdp = await Cdp.connect(debugPort);
    await cdp.until(`location.protocol === "file:" && window.__serverUrl`, "client in the window the second launch opened");
    if (serverPids(dataDir).length !== 1) fail(`a second launch started another server: ${serverPids(dataDir).join(" ")}`);
    log(`13 second launch (exit ${String(againCode)}) opened the window on the running instance; still one server`);

    await cdp.eval("window.close(), true").catch(() => undefined);
    cdp.close();
    await untilTrue(async () => (await pages(debugPort)) === 0, "the window to close", 5000);
    await sleep(500);
    if (electron.exitCode !== null || electron.signalCode !== null) fail("closing the last window quit a background instance");
    if (pid === undefined || !alive(pid)) fail("closing the last window stopped the server");
    log("14 closing the last window: Electron and the server keep running");

    const quiet = launch(work, null, ["--background"]);
    seconds.push(quiet.electron);
    const quietCode = await handsOff(quiet, "a second --background launch");
    await sleep(1000);
    if ((await pages(debugPort)) !== 0) fail("a second background launch opened a window");
    if (serverPids(dataDir).length !== 1) fail(`a second --background launch started another server: ${serverPids(dataDir).join(" ")}`);

    electron.kill("SIGTERM");
    const code = await exited;
    if (!(await waitGone(serverPids(dataDir), 4_000))) fail("the server outlived SIGTERM to a background instance");
    log(`15 second --background launch (exit ${String(quietCode)}) opened nothing; SIGTERM: exit ${String(code)}, server ${String(pid)} gone`);
  } finally {
    for (const child of [electron, ...seconds]) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

const work = mkdtempSync(path.join(tmpdir(), "gates-desktop-smoke-"));
try {
  await lifecycle(work);
  await parentDeath(work);
  await keys(work);
  await quitKey(work);
  await background(work);
  log("ok");
} finally {
  rmSync(work, { recursive: true, force: true });
}
