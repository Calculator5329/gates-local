// Electron main: one window, one supervised server. Bundled to out/main.cjs
// by scripts/build.ts. See README.md for the server contract and the
// renderer's reconnect duties.

import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, protocol, session, shell, type IpcMainInvokeEvent } from "electron";
import { parseClipboardPaths, pathClipboardTypes } from "./clipboard.ts";
import { capturePaste, finishPaste, type PasteResult } from "./native-paste.ts";
import { randomUUID } from "node:crypto";
import { editMenu } from "./context-menu.ts";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { IPC, describeCrash, toBridgeState, type BridgeState, type UpdateAndRestartResult } from "./bridge.ts";
import { CLIENT_ORIGIN, CLIENT_SCHEME, clientResponse, originOf, sameClient } from "./client-protocol.ts";
import { desktopUserDataDir, modelFolderActions, serverDataDir } from "./data-dir.ts";
import { checkOwnership } from "../../server/src/runtime/ownership.ts";
import { ownedStateFile } from "../../server/src/runtime/paths.ts";
import { allowsMicrophone } from "./media-permission.ts";
import { hidesMenu, installWindowKeys } from "./keys.ts";
import { launchMode, quitOnAllClosed, secondInstanceAction, serverEnv, windowAtStart } from "./launch.ts";
import { guardNavigation } from "./links.ts";
import { clearRunning, writeRunning } from "./running.ts";
import { approvedHandoffEnv, cannotUpdate, launchApprovedUpdate, onceUntilFailed, targetKind, updaterLaunch, validUpdateRequest, type UpdaterLaunch } from "./update-launch.ts";
import { withUpdateControl } from "./update-control.ts";
import type { UpdateInstallRequest } from "@gates-local/contracts";
import { acknowledgeStartup, reportStartupFailure, STARTUP_TOKEN_ENV } from "../../server/src/update/startup.ts";
import { verifyPrepared } from "../../server/src/update/installed/download.ts";
import { installedFeed, RESTART_ENV } from "../../server/src/update/installed/module.ts";
import { processRecord } from "../../server/src/update/identity.ts";
import { uptime } from "node:os";
import { writeAck } from "./installed-update/ack.ts";
import { startInstalledUpdate } from "./installed-update/click.ts";
import { routeInstalled, routeUnreplaceable, updatePageUrl, type StartApp } from "./installed-update/desktop.ts";
import { bootId, loggedStopAt, logLine, spawnWatcher, TEST_DEBUG_PORT_ENV } from "./installed-update/handoff.ts";
import { pageAction, type PageAction } from "./installed-update/page.ts";
import { replaceability } from "./installed-update/replaceable.ts";
import { hasEarlierFailure } from "./installed-update/results.ts";
import { copyOf, tokenWait } from "./installed-update/routing.ts";
import { beginUpdate } from "./installed-update/watch.ts";
import { goBackInstaller, settlePending, startInstaller, startWindowsUpdate } from "./installed-update/windows.ts";
import * as updateWords from "./installed-update/words.ts";
import type { Words } from "./installed-update/words.ts";
import { dataUrl, renderStatusPage, type StatusView } from "./status-page.ts";
import { Supervisor, type SupervisorState } from "./supervisor.ts";
import { iconFile, windowOptions } from "./window.ts";

const DEV_WEB_URL = "http://127.0.0.1:5187/";

// out/main.cjs -> apps/desktop
const desktopDir = path.resolve(__dirname, "..");
// The clone, for "Restart to update" (apps/desktop -> the repo root).
const repoRoot = path.resolve(desktopDir, "..", "..");

app.setName("gates-local");
app.setPath("userData", desktopUserDataDir({ platform: process.platform, env: process.env, appData: app.getPath("appData"), packaged: app.isPackaged }));
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
  if (app.isPackaged) return path.join(process.resourcesPath, "server", "main.mjs");
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

/** A test build (resources/test-build.json) reads test keys, a loopback feed and stop points; a release never does. */
function isTestBuild(): boolean {
  if (!app.isPackaged) return false;
  try {
    return statSync(path.join(process.resourcesPath, "test-build.json")).isFile();
  } catch {
    return false;
  }
}
const testBuild = isTestBuild();
if (testBuild) {
  // A test build never reaches this computer's Ollama or ComfyUI unless the probe names where they are:
  // the copy the Windows installer starts after an update may not carry the probe's environment.
  const safe = { GATES_LOCAL_RUNTIME: "discover-only", GATES_LOCAL_OLLAMA_BINARY: "none", GATES_LOCAL_OLLAMA_URL: "http://127.0.0.1:19750", GATES_LOCAL_COMFY_URL: "http://127.0.0.1:1" };
  for (const [key, value] of Object.entries(safe)) process.env[key] ??= value;
  // The copy the Windows installer starts (--updated) opens DevTools on the probe's port, as a watcher's launch does on Linux (handoff.ts forwardedArgs).
  const port = process.env[TEST_DEBUG_PORT_ENV] ?? "";
  if (process.platform === "win32" && process.argv.includes("--updated") && /^\d{2,5}$/.test(port)) app.commandLine.appendSwitch("remote-debugging-port", port);
}
// Read before the routing below can move a page-only process to its own profile folder.
const dataDir = serverDataDir({ platform: process.platform, env: process.env, home: app.getPath("home"), userData: app.getPath("userData"), packaged: app.isPackaged });
// Whether this copy can replace its own file (an AppImage on Linux, or an install the Windows installer made), and the file.
const replace = replaceability({ platform: process.platform, packaged: app.isPackaged, env: process.env, testBuild, execPath: process.execPath });
const installedCopy = replace.program === null ? null : copyOf(replace.program, dataDir);
const feed = installedFeed(process.env, { testBuild });
const appWindow = () => windowOptions({
  icon: iconFile({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, desktopDir }),
  preload: path.join(__dirname, "preload.cjs"),
});

if (installedCopy !== null) {
  // An AppImage: an update may be in flight, so the launch is routed first (installed-update/desktop.ts).
  routeInstalled({ copy: installedCopy, testBuild, trustedKeys: feed.keys, releasePage: feed.page, window: appWindow, background: mode.background }, run);
} else if (!app.requestSingleInstanceLock({ background: mode.background })) {
  // A second launch reaches this instance through the lock; it says whether it
  // was itself a background launch (systemd starting it again wants no window).
  app.quit();
} else if (process.platform === "linux" && app.isPackaged) {
  // Packaged Linux with no program to replace (a renamed file, AppRun alone): it shares the data folder, so it reads the update first.
  routeUnreplaceable({ window: appWindow, releasePage: feed.page }, dataDir, run);
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

function run(start: StartApp = {}): void {
  // pnpm run app-update reads this to refuse while the app is open.
  try {
    writeRunning(dataDir, process.pid, Date.now());
  } catch (e) {
    console.error(`[desktop] could not write the pid file: ${(e as Error).message}`);
  }
  process.on("exit", () => clearRunning(dataDir, process.pid));
  // Windows W-A step 6: the note the click left becomes the result the server shows once, before the server starts.
  const windowsUpdates = replace.restart === "windows";
  if (windowsUpdates) {
    try {
      const settled = settlePending(dataDir, app.getVersion());
      if (settled.kind !== "none") console.error(`[desktop] Windows update note: ${settled.kind === "dropped" ? `dropped, ${settled.why}` : `${settled.kind} ${settled.to}`}`);
    } catch (e) {
      console.error(`[desktop] could not read the Windows update note: ${(e as Error).message}`);
    }
  }
  // The server allows the client's WebSocket Origin; a file: client gets none, so it cannot connect.
  const env = serverEnv({ env: process.env, clientOrigin: originOf(clientUrl()), webRoot: webRoot(), installedVersion: app.isPackaged ? app.getVersion() : null });
  // The server offers "Restart to update" only when this copy can replace its file, and says why not otherwise.
  if (app.isPackaged) env[RESTART_ENV] = replace.restart;
  const supervisor = new Supervisor({ entry: serverEntry(), dataDir, env });
  const modelFolders = modelFolderActions({ ownership: () => checkOwnership(ownedStateFile(dataDir)), isFolder, openPath: folder => shell.openPath(folder) });
  let win: BrowserWindow | null = null;
  /** The client URL (with its route) to restore after a restart. */
  let lastClientUrl: string | null = null;
  let showingClient = false;
  /** An update page shown in place of the client: a token launch's "finishing" page, the earlier failure, the watcher's death. */
  let held: { readonly words: Words; readonly actions: readonly PageAction[] } | null =
    start.page === undefined ? null : { words: start.page, actions: start.hold === true ? ["continue"] : [] };

  const bridgeState = (): BridgeState => toBridgeState(supervisor.state);

  function showHeld(): boolean {
    if (held === null) return false;
    if (win !== null && !win.isDestroyed()) {
      showingClient = false;
      void win.loadURL(updatePageUrl(held.words, feed.page, held.actions));
    }
    return true;
  }

  // The earlier failure page's one button carries on with a normal start.
  let serverWaits = start.hold === true;
  function carryOn(): void {
    if (!serverWaits) return;
    serverWaits = false;
    held = null;
    void supervisor.start();
  }

  // A token launch acks on ready, then waits for a result carrying its token
  // (the server opens admission on the same result). If the watcher dies
  // first, it stops its server and says so; the next launch finishes the update.
  let acked = false;
  if (start.token !== undefined) {
    const token = start.token;
    const timer = setInterval(() => {
      const now = tokenWait(dataDir, token);
      if (now === "waiting") return;
      clearInterval(timer);
      logLine(dataDir, `token launch: ${now}`);
      if (now === "released") {
        held = null;
        route(supervisor.state);
        return;
      }
      held = { words: updateWords.watcherDied(), actions: [] };
      void supervisor.stop().finally(() => showHeld());
    }, 500);
  }

  function showStatus(view: StatusView): void {
    if (win === null || win.isDestroyed()) return;
    showingClient = false;
    void win.loadURL(dataUrl(renderStatusPage(view)));
  }

  // Windows W-A step 7: a crashed server's page names the kept installer of the version before, looked up (and checked) on the first crash.
  let goBack: { readonly file: string | null } | "looking" | null = null;
  function showCrashed(state: SupervisorState): void {
    const file = goBack !== null && goBack !== "looking" ? goBack.file : null;
    showStatus({ kind: "server", state: toBridgeState(state), ...(file === null ? {} : { goBack: file }) });
    if (!windowsUpdates || goBack !== null) return;
    goBack = "looking";
    void goBackInstaller({ dataDir, running: app.getVersion(), keys: feed.keys, platform: process.platform, arch: process.arch })
      .catch(() => null)
      .then((found) => {
        goBack = { file: found };
        if (found !== null && supervisor.state.status === "crashed") showStatus({ kind: "server", state: toBridgeState(supervisor.state), goBack: found });
      });
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
      if (start.token !== undefined) {
        // The ack is a request, not a decision: the watcher decides, and a crash is seen as no ack.
        if (state.status === "ready" && !acked) {
          writeAck(dataDir, start.token);
          acked = true;
          logLine(dataDir, "token launch: server ready, ack written");
        }
      } else {
        if (state.status === "ready") acknowledgeStartup(repoRoot, dataDir, process.env[STARTUP_TOKEN_ENV]);
        if (state.status === "crashed") reportStartupFailure(repoRoot, dataDir, process.env[STARTUP_TOKEN_ENV], "The new version failed before its server became ready.");
      }
    } catch (error) { console.error(`[desktop] could not acknowledge update startup: ${(error as Error).message}`); }
    if (win === null || win.isDestroyed()) return;
    win.webContents.send(IPC.state, toBridgeState(state));
    switch (state.status) {
      case "ready":
        if (!showHeld()) showClient();
        break;
      case "crashed": {
        const current = win.webContents.getURL();
        if (showingClient && isClientUrl(current)) lastClientUrl = current;
        console.error(`[desktop] server crashed: ${describeCrash(state.reason)}`);
        showCrashed(state);
        break;
      }
      case "starting":
      case "restarting":
        if (!showHeld()) showStatus({ kind: "server", state: toBridgeState(state) });
        break;
      case "idle":
        // The earlier failure page waits for its button before the server starts.
        showHeld();
        break;
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
  // The image download folder's change control: the system dialog, nothing read or written here.
  ipcMain.handle(IPC.pickFolder, async (event, from: unknown): Promise<string | null> => {
    if (!fromOurWindow(event) || win === null) throw new Error("refused");
    const picked = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"], ...typeof from === "string" && from !== "" ? { defaultPath: from } : {} });
    return picked.canceled ? null : picked.filePaths[0] ?? null;
  });
  ipcMain.handle(IPC.openDataFolder, async (event): Promise<string | null> => {
    if (!fromOurWindow(event)) throw new Error("refused");
    // shell.openPath resolves to an error message, "" when it worked
    const failed = await shell.openPath(dataDir);
    return failed === "" ? null : `Couldn't open the folder: ${failed}`;
  });
  // Row H for an installed copy: after the server commits the approval, re-verify, write `approved`, start the watcher, quit.
  const startInstalled = (request: UpdateInstallRequest): Promise<UpdateAndRestartResult> => {
    const state = supervisor.state;
    if (state.status !== "ready") return Promise.resolve({ ok: false, message: "The app server is not ready to approve an update. Try again after it reconnects." });
    if (windowsUpdates) {
      // Windows W-A step 4: re-verify, write the note, start the checked installer; a refused start leaves this app as it was.
      return withUpdateControl(state.url, (control) => launchApprovedUpdate(request, control, (target) => startWindowsUpdate(target, {
        dataDir,
        running: app.getVersion(),
        verify: (version) => verifyPrepared({ dataDir, running: app.getVersion(), keys: feed.keys, platform: process.platform, arch: process.arch, version }),
        start: (installer) => startInstaller(installer),
        log: (line) => console.error(`[desktop] ${line}`),
        quit: () => {
          console.error("[desktop] installer started; quitting so it can replace this install");
          setTimeout(() => app.quit(), 200);
        },
      }))).catch(() => ({ ok: false, message: "Could not validate the update with the app server. Check for updates again to retry." }));
    }
    const stopAt = loggedStopAt(dataDir, process.env, testBuild);
    return withUpdateControl(state.url, (control) => launchApprovedUpdate(request, control, (target) => startInstalledUpdate(target, {
      restart: replace.restart,
      copy: installedCopy,
      running: app.getVersion(),
      serverPid: supervisor.pid,
      verify: (version) => verifyPrepared({ dataDir, running: app.getVersion(), keys: feed.keys, platform: process.platform, arch: process.arch, version }),
      begin: (approval) => beginUpdate(approval, {
        spawnWatcher: spawnWatcher({ program: approval.copy.program, dataDir, env: process.env, argv: process.argv, testBuild, trustedKeys: feed.keys, showPage: () => undefined }),
        earlierFailure: hasEarlierFailure(dataDir),
        ...(stopAt === undefined ? {} : { stopAt }),
      }),
      record: (pid) => processRecord(pid),
      uptime,
      bootId,
      quit: () => {
        console.error("[desktop] update watcher started; quitting so it can replace the program file");
        setTimeout(() => app.quit(), 200);
      },
    }))).catch(() => ({ ok: false, message: "Could not validate the update with the app server. Check for updates again to retry." }));
  };
  const startUpdate = onceUntilFailed(async (request: UpdateInstallRequest): Promise<UpdateAndRestartResult> => {
    if (targetKind(request.target) === "installed") return startInstalled(request);
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
    // An update page's one button is a link only main acts on; the guard below still refuses to navigate.
    contents.on("will-navigate", (_event, url) => {
      if (pageAction(url) === "continue") carryOn();
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
    // The earlier failure page shows even on a background start: it comes before the server.
    if ((windowAtStart(mode) || serverWaits) && win === null) {
      win = createWindow();
      route(supervisor.state);
    }
    if (!serverWaits) void supervisor.start();
  });
}
