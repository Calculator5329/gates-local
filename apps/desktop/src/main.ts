// Electron main: one window, one supervised server. Bundled to out/main.cjs
// by scripts/build.ts. See README.md for the server contract and the
// renderer's reconnect duties.

import { app, BrowserWindow, ipcMain, session, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { IPC, describeCrash, toBridgeState, type BridgeState } from "./bridge.ts";
import { dataUrl, renderStatusPage, type StatusView } from "./status-page.ts";
import { Supervisor, type SupervisorState } from "./supervisor.ts";

const DEV_WEB_URL = "http://127.0.0.1:5187/";

// out/main.cjs -> apps/desktop
const desktopDir = path.resolve(__dirname, "..");

app.setName("gates-local");
app.setPath("userData", process.env["GATES_LOCAL_USER_DATA"] ?? path.join(app.getPath("appData"), "gates-local"));

function serverEntry(): string {
  const override = process.env["GATES_LOCAL_SERVER_ENTRY"];
  if (override !== undefined && override !== "") return path.resolve(override);
  // Packaged layout is provisional until packaging lands.
  if (app.isPackaged) return path.join(process.resourcesPath, "server", "main.ts");
  return path.resolve(desktopDir, "..", "server", "src", "main.ts");
}

/** Dev: the Vite dev server. Dist: the built web files. */
function clientUrl(): string {
  const override = process.env["GATES_LOCAL_WEB_URL"];
  if (override !== undefined && override !== "") return override;
  const mode = process.env["GATES_LOCAL_WEB"] ?? (app.isPackaged ? "dist" : "dev");
  if (mode === "dev") return DEV_WEB_URL;
  const index = app.isPackaged
    ? path.join(process.resourcesPath, "web", "index.html")
    : path.resolve(desktopDir, "..", "web", "dist", "index.html");
  return pathToFileURL(index).toString();
}

function isClientUrl(url: string): boolean {
  const client = new URL(clientUrl());
  try {
    const target = new URL(url);
    if (client.protocol === "file:") return target.protocol === "file:" && target.pathname === client.pathname;
    return target.origin === client.origin;
  } catch {
    return false;
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  run();
}

function run(): void {
  const dataDir = process.env["GATES_LOCAL_DATA_DIR"] ?? path.join(app.getPath("userData"), "server-data");
  const supervisor = new Supervisor({ entry: serverEntry(), dataDir });
  let win: BrowserWindow | null = null;
  /** The client URL (with its route) to restore after a restart. */
  let lastClientUrl: string | null = null;
  let showingClient = false;

  const bridgeState = (): BridgeState => toBridgeState(supervisor.state);

  function showStatus(view: StatusView): void {
    if (win === null || win.isDestroyed()) return;
    showingClient = false;
    void win.loadURL(dataUrl(renderStatusPage(view)));
  }

  function showClient(): void {
    if (win === null || win.isDestroyed()) return;
    showingClient = true;
    void win.loadURL(lastClientUrl ?? clientUrl()).catch(() => {
      // did-fail-load shows the status page.
    });
  }

  function route(state: SupervisorState): void {
    if (win === null || win.isDestroyed()) return;
    win.webContents.send(IPC.state, toBridgeState(state));
    switch (state.status) {
      case "ready":
        showClient();
        break;
      case "crashed": {
        const current = win.webContents.getURL();
        if (showingClient && isClientUrl(current)) lastClientUrl = current;
        console.error(`[desktop] server crashed: ${describeCrash(state.reason)}`);
        showStatus({ kind: "server", state: toBridgeState(state) });
        break;
      }
      case "starting":
      case "restarting":
        showStatus({ kind: "server", state: toBridgeState(state) });
        break;
      case "idle":
      case "stopping":
      case "stopped":
        break;
    }
  }

  function fromOurWindow(event: IpcMainInvokeEvent): boolean {
    return win !== null && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;
  }

  ipcMain.handle(IPC.getState, (event) => {
    if (!fromOurWindow(event)) throw new Error("refused");
    return bridgeState();
  });
  ipcMain.handle(IPC.restart, (event) => {
    if (!fromOurWindow(event)) throw new Error("refused");
    return supervisor.restart();
  });
  ipcMain.handle(IPC.reloadClient, (event) => {
    if (!fromOurWindow(event)) throw new Error("refused");
    if (supervisor.state.status === "ready") showClient();
  });

  supervisor.subscribe(route);

  function createWindow(): BrowserWindow {
    const window = new BrowserWindow({
      width: 1200,
      height: 800,
      title: "Gates Local",
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    const contents = window.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, url) => {
      if (!isClientUrl(url)) event.preventDefault();
    });
    contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      // -3 is ERR_ABORTED: a newer navigation replaced this one.
      if (!isMainFrame || errorCode === -3 || !showingClient) return;
      showStatus({ kind: "client-load-failed", url: validatedUrl, error: `${errorDescription} (${errorCode})` });
    });
    contents.on("render-process-gone", (_event, details) => {
      console.error(`[desktop] renderer gone: ${details.reason}`);
      route(supervisor.state);
    });
    window.on("closed", () => {
      if (win === window) win = null;
    });
    return window;
  }

  app.on("second-instance", () => {
    if (win === null) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  let quitting = false;
  app.on("before-quit", (event) => {
    if (supervisor.state.status === "stopped") return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void supervisor.stop().finally(() => app.quit());
  });
  app.on("window-all-closed", () => app.quit());
  process.on("exit", () => supervisor.killNow());
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => app.quit());
  }

  void app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    win = createWindow();
    route(supervisor.state);
    void supervisor.start();
  });
}
