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
//   6. SIGKILL of Electron main takes the server down too (stdin EOF path).
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

function launch(work: string, debugPort: number | null): { electron: ChildProcess; dataDir: string; exited: Promise<number | null> } {
  const dataDir = path.join(work, `data-${Date.now()}`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GATES_LOCAL_SERVER_ENTRY: path.join(root, "test", "fixtures", "fake-server.ts"),
    GATES_LOCAL_WEB_URL: pathToFileURL(path.join(root, "test", "fixtures", "client.html")).toString(),
    GATES_LOCAL_DATA_DIR: dataDir,
    GATES_LOCAL_USER_DATA: path.join(work, "user-data"),
    FAKE_MODE: "ready",
  };
  delete env["DISPLAY"];
  delete env["WAYLAND_DISPLAY"];
  delete env["ELECTRON_RUN_AS_NODE"];
  const args = [root, "--ozone-platform=headless"];
  if (debugPort !== null) args.push(`--remote-debugging-port=${debugPort}`);
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

  static async connect(port: number): Promise<Cdp> {
    for (let i = 0; i < 150; i++) {
      try {
        const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
        const page = list.find((target) => target.type === "page");
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
    return fail("no DevTools page target");
  }

  async eval(expression: string): Promise<unknown> {
    const id = ++this.#id;
    return await new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    });
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

const work = mkdtempSync(path.join(tmpdir(), "gates-desktop-smoke-"));
try {
  await lifecycle(work);
  await parentDeath(work);
  log("ok");
} finally {
  rmSync(work, { recursive: true, force: true });
}
