// Electron main: one window, one supervised server. Bundled to out/main.cjs
// by scripts/build.ts. See README.md for the server contract and the
// renderer's reconnect duties.

import { app, BrowserWindow, clipboard, ipcMain, Menu, net, protocol, session, shell, type IpcMainInvokeEvent } from "electron";
import { parseClipboardPaths, pathClipboardTypes } from "./clipboard.ts";
import { capturePaste, finishPaste, type PasteResult } from "./native-paste.ts";
import { randomUUID } from "node:crypto";
import { editMenu } from "./context-menu.ts";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { IPC, describeCrash, toBridgeState, type BridgeState, type UpdateAndRestartResult } from "./bridge.ts";
import { CLIENT_ORIGIN, CLIENT_SCHEME, clientResponse, originOf, sameClient } from "./client-protocol.ts";
import { modelFolderActions, serverDataDir } from "./data-dir.ts";
import { checkOwnership } from "../../server/src/runtime/ownership.ts";
import { ownedStateFile } from "../../server/src/runtime/paths.ts";
import { allowsMicrophone } from "./media-permission.ts";
import { hidesMenu, installWindowKeys } from "./keys.ts";
import { launchMode, quitOnAllClosed, secondInstanceAction, serverEnv, windowAtStart } from "./launch.ts";
import { guardNavigation } from "./links.ts";
import { clearRunning, writeRunning } from "./running.ts";
import { approvedHandoffEnv, cannotUpdate, launchApprovedUpdate, onceUntilFailed, updaterLaunch, validUpdateRequest, type UpdaterLaunch } from "./update-launch.ts";
import { withUpdateControl } from "./update-control.ts";
import type { UpdateInstallRequest } from "@gates-local/contracts";
import { acknowledgeStartup, reportStartupFailure, STARTUP_TOKEN_ENV } from "../../server/src/update/startup.ts";
import { dataUrl, renderStatusPage, type StatusView } from "./status-page.ts";
import { Supervisor, type SupervisorState } from "./supervisor.ts";
import { iconFile, windowOptions } from "./window.ts";

const DEV_WEB_URL = "http://127.0.0.1:5187/";

// out/main.cjs -> apps/desktop
const desktopDir = path.resolve(__dirname, "..");
// The clone, for "Update and restart" (apps/desktop -> the repo root).
const repoRoot = path.resolve(desktopDir, "..", "..");

app.setName("gates-local");
app.setPath("userData", process.env["GATES_LOCAL_USER_DATA"] ?? path.join(app.getPath("appData"), "gates-local"));
// Must run before ready. Standard + secure gives the scheme a real origin
// (gates-local://app) and lets the module scripts and fetch load from it.
protocol.registerSchemesAsPrivileged([
  { scheme: CLIENT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function isFolder(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function serverEntry(): string {
  const override = process.env["GATES_LOCAL_SERVER_ENTRY"];
  if (override !== undefined && override !== "") return path.resolve(override);
  // Packaged layout is provisional until packaging lands.
  if (app.isPackaged) return path.join(process.resourcesPath, "server", "main.ts");
  return path.resolve(desktopDir, "..", "server", "src", "main.ts");
}

/** The built web files that gates-local://app serves. */
function webRoot(): string {
  return app.isPackaged ? path.join(process.resourcesPath, "web") : path.resolve(desktopDir, "..", "web", "dist");
}

/** Dist (the default): the built web files on gates-local://app. Dev: the Vite dev server. */
function clientUrl(): string {
  const override = process.env["GATES_LOCAL_WEB_URL"];
  if (override !== undefined && override !== "") return override;
  if (process.env["GATES_LOCAL_WEB"] === "dev") return DEV_WEB_URL;
  return `${CLIENT_ORIGIN}/index.html`;
}

function isClientUrl(url: string): boolean {
  return sameClient(clientUrl(), url);
}

const mode = launchMode(process.argv, process.env);

// A second launch reaches this instance through the lock; it says whether it
// was itself a background launch (systemd starting it again wants no window).
if (!app.requestSingleInstanceLock({ background: mode.background })) {
  app.quit();
} else {
  run();
}

/** Starts the updater on its own, outside this app's process group, so it outlives the quit. */
function startDetached(plan: UpdaterLaunch, env: NodeJS.ProcessEnv): Promise<UpdateAndRestartResult> {
  return new Promise((resolve) => {
    const child = spawn(plan.command, [...plan.args], { cwd: plan.cwd, env, detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", (e) =>
      resolve({ ok: false, message: `The updater could not be started (${e.message}). Install Node 24 on your PATH, or run pnpm run app-update in the Gates Local folder.` }),
    );
    child.once("spawn", () => {
      child.unref();
      resolve({ ok: true });
    });
  });
}

function run(): void {
  const dataDir = serverDataDir({ platform: process.platform, env: process.env, home: app.getPath("home"), userData: app.getPath("userData") });
  // pnpm run app-update reads this to refuse while the app is open.
  try {
    writeRunning(dataDir, process.pid, Date.now());
  } catch (e) {
    console.error(`[desktop] could not write the pid file: ${(e as Error).message}`);
  }
  process.on("exit", () => clearRunning(dataDir, process.pid));
  // The server allows the client's WebSocket Origin; a file: client gets none, so it cannot connect.
  const env = serverEnv({ env: process.env, clientOrigin: originOf(clientUrl()), webRoot: webRoot() });
  const supervisor = new Supervisor({ entry: serverEntry(), dataDir, env });
  const modelFolders = modelFolderActions({ ownership: () => checkOwnership(ownedStateFile(dataDir)), isFolder, openPath: folder => shell.openPath(folder) });
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
    try {
      if (state.status === "ready") acknowledgeStartup(repoRoot, dataDir, process.env[STARTUP_TOKEN_ENV]);
      if (state.status === "crashed") reportStartupFailure(repoRoot, dataDir, process.env[STARTUP_TOKEN_ENV], "The new version failed before its server became ready.");
    } catch (error) { console.error(`[desktop] could not acknowledge update startup: ${(error as Error).message}`); }
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
  ipcMain.handle(IPC.titleBar, (event, colors: unknown) => {
    if (!fromOurWindow(event)) throw new Error("refused");
    if (typeof colors !== "object" || colors === null || !("color" in colors) || !("symbolColor" in colors)) return;
    const { color, symbolColor } = colors;
    if (typeof color !== "string" || typeof symbolColor !== "string" || !/^#[0-9a-f]{6}$/i.test(color) || !/^#[0-9a-f]{6}$/i.test(symbolColor)) return;
    win?.setBackgroundColor(color);
    // macOS owns the traffic-light colours; its overlay geometry still works.
    if (process.platform !== "darwin") win?.setTitleBarOverlay({ color, symbolColor });
  });
  ipcMain.handle(IPC.restart, (event) => {
    if (!fromOurWindow(event)) throw new Error("refused");
    return supervisor.restart();
  });
  ipcMain.handle(IPC.reloadClient, (event) => {
    if (!fromOurWindow(event)) throw new Error("refused");
    if (supervisor.state.status === "ready") showClient();
  });
  ipcMain.handle(IPC.dataFolder, (event) => {
    if (!fromOurWindow(event)) throw new Error("refused");
    return dataDir;
  });
  ipcMain.handle(IPC.modelsFolder, (event): string | null => {
    if (!fromOurWindow(event)) throw new Error("refused");
    return modelFolders.modelsFolder();
  });
  ipcMain.handle(IPC.openModelsFolder, async (event): Promise<string | null> => {
    if (!fromOurWindow(event)) throw new Error("refused");
    return modelFolders.openModelsFolder();
  });
  ipcMain.handle(IPC.openDataFolder, async (event): Promise<string | null> => {
    if (!fromOurWindow(event)) throw new Error("refused");
    // shell.openPath resolves to an error message, "" when it worked
    const failed = await shell.openPath(dataDir);
    return failed === "" ? null : `Couldn't open the folder: ${failed}`;
  });
  const startUpdate = onceUntilFailed(async (request: UpdateInstallRequest): Promise<UpdateAndRestartResult> => {
    const refused = cannotUpdate({ packaged: app.isPackaged, repoRoot, exists: existsSync });
    if (refused !== null) return { ok: false, message: refused };
    const state = supervisor.state;
    if (state.status !== "ready") return { ok: false, message: "The app server is not ready to approve an update. Try again after it reconnects." };
    return withUpdateControl(state.url, (control) => launchApprovedUpdate(request, control, async (approvedCommit) => {
      const plan = updaterLaunch({ repoRoot, pid: process.pid, dataDir, argv: process.argv, cwd: process.cwd(), env: process.env, exists: existsSync, approvedCommit });
      const started = await startDetached(plan, approvedHandoffEnv(process.env));
      if (started.ok) {
        console.error(`[desktop] approved updater started; quitting so it can update ${repoRoot}`);
        setTimeout(() => app.quit(), 200);
      }
      return started;
    })).catch(() => ({ ok: false, message: "Could not validate the update with the app server. Check for updates again to retry." }));
  });
  ipcMain.handle(IPC.updateAndRestart, (event, request: unknown): Promise<UpdateAndRestartResult> => {
    if (!fromOurWindow(event)) throw new Error("refused");
    if (!validUpdateRequest(request)) return Promise.resolve({ ok: false, message: "An exact checked commit and current server approval are required. Check for updates again." });
    return startUpdate(request);
  });

  supervisor.subscribe(route);

  function createWindow(): BrowserWindow {
    const window = new BrowserWindow(
      windowOptions({
        icon: iconFile({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, desktopDir }),
        preload: path.join(__dirname, "preload.cjs"),
      }),
    );
    const contents = window.webContents;
    // Only main can start this operation. There is no renderer clipboard request channel.
    const paste = async () => {
      const started = performance.now();
      const id = randomUUID();
      const inPasteWorld = (code: string): Promise<unknown> => contents.executeJavaScriptInIsolatedWorld(1004, [{ code }]);
      if (!isClientUrl(contents.getURL()) || !window.isFocused() || await inPasteWorld(capturePaste(id)) !== true) { contents.paste(); return; }
      if (performance.now() - started > 750) { await inPasteWorld(finishPaste(id)); return; }
      const deliver = (result?: PasteResult) => inPasteWorld(finishPaste(id, performance.now() - started <= 750 && isClientUrl(contents.getURL()) && window.isFocused() ? result : undefined));
      const copied: string[] = [];
      let skipped = false;
      try {
        // Electron 45 maps Windows CF_HDROP to file:// URIs in this privileged read.
        for (const item of await clipboard.read()) {
          for (const format of pathClipboardTypes(item.types)) {
            const parsed = parseClipboardPaths(await (await item.getType(format)).text(), process.platform);
            skipped ||= parsed.skipped;
            if (parsed.paths.length) { copied.push(...parsed.paths); break; }
          }
        }
        const delivered = await deliver({ paths: [...new Set(copied)], skipped });
        if (delivered === true && !copied.length && !skipped) contents.paste();
      } catch { await deliver({ paths: [], skipped: false, failed: true }); }
    };
    const trustedPaste = () => { void paste().catch(() => undefined); };
    contents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || input.key.toLowerCase() !== "v" || !(input.control || input.meta) || input.alt || input.isComposing) return;
      event.preventDefault();
      if (!input.isAutoRepeat) trustedPaste();
    });
    contents.on("context-menu", (event, params) => {
      event.preventDefault();
      const template = editMenu(params).map(item => item.role === "paste" ? {
        label: "Paste", enabled: item.enabled, accelerator: "CmdOrCtrl+V",
        click: trustedPaste,
      } : item);
      if (params.mediaType === "image") template.unshift({ label: "Copy Image", click: () => contents.copyImageAt(params.x, params.y) }, { type: "separator" });
      if (/^https?:\/\//i.test(params.linkURL)) template.unshift({ label: "Copy Link", click: () => { void clipboard.writeText(params.linkURL); } }, { type: "separator" });
      if (params.misspelledWord) template.unshift(
        ...(params.dictionarySuggestions.length ? params.dictionarySuggestions.slice(0, 5).map(label => ({ label, click: () => contents.replaceMisspelling(label) })) : [{ label: "No suggestions", enabled: false }]),
        { type: "separator" },
      );
      if (template.length) Menu.buildFromTemplate(template).popup({ window });
    });
    // The window never opens another window or leaves the client. A web
    // link (the Ollama library, a link in a reply) opens in the system browser.
    guardNavigation(contents, {
      isClientUrl,
      openExternal: (url) => shell.openExternal(url),
      log: (line) => console.error(`[desktop] ${line}`),
    });
    contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      // -3 is ERR_ABORTED: a newer navigation replaced this one.
      if (!isMainFrame || errorCode === -3 || !showingClient) return;
      showStatus({ kind: "client-load-failed", url: validatedUrl, error: `${errorDescription} (${errorCode})` });
    });
    // No menu on Linux and Windows, so reload, close, quit, full screen,
    // dev tools and zoom keys come from here (keys.ts).
    installWindowKeys(window, contents, { platform: process.platform, devTools: !app.isPackaged, quit: () => app.quit() });
    contents.on("render-process-gone", (_event, details) => {
      console.error(`[desktop] renderer gone: ${details.reason}`);
      route(supervisor.state);
    });
    window.on("closed", () => {
      if (win === window) win = null;
    });
    return window;
  }

  app.on("second-instance", (_event, _argv, _cwd, additionalData) => {
    const background = typeof additionalData === "object" && additionalData !== null && (additionalData as { background?: unknown }).background === true;
    const live = win !== null && !win.isDestroyed() ? win : null;
    switch (secondInstanceAction({ hasWindow: live !== null, minimized: live?.isMinimized() ?? false, background })) {
      case "none":
        return;
      case "create":
        // A launch can arrive before ready; the window waits for it.
        void app.whenReady().then(() => {
          if (win !== null && !win.isDestroyed()) return win.focus();
          win = createWindow();
          route(supervisor.state);
        });
        return;
      case "restore":
        live?.restore();
        live?.focus();
        return;
      case "focus":
        live?.focus();
        return;
    }
  });

  let quitting = false;
  app.on("before-quit", (event) => {
    if (supervisor.state.status === "stopped") return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void supervisor.stop().finally(() => app.quit());
  });
  // Background mode keeps the server up with no window; quit (or SIGTERM) still stops it.
  app.on("window-all-closed", () => {
    if (quitOnAllClosed(mode)) app.quit();
  });
  process.on("exit", () => supervisor.killNow());
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => app.quit());
  }

  void app.whenReady().then(() => {
    if (hidesMenu(process.platform)) Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(allowsMicrophone(contents.getURL(), permission, details.requestingUrl, "mediaTypes" in details ? details.mediaTypes ?? [] : [], details.isMainFrame));
    });
    session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) =>
      allowsMicrophone(contents?.getURL() ?? "", permission, origin, [details.mediaType ?? "unknown"], details.isMainFrame));
    const root = webRoot();
    protocol.handle(CLIENT_SCHEME, (request) => clientResponse(root, request.url, (fileUrl) => net.fetch(fileUrl)));
    if (windowAtStart(mode) && win === null) {
      win = createWindow();
      route(supervisor.state);
    }
    void supervisor.start();
  });
}
