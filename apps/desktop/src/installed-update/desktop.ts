// The Electron side of an installed Linux copy's update
// (docs/design/installed-updates.md, section 2): the launch routing that runs
// before any window or server, the watcher process, and the pages that need
// no server. main.ts calls routeInstalled for every launch of a copy whose
// program is an AppImage, and routeUnreplaceable for every other packaged
// Linux launch, which shares the data folder.
import { app, BrowserWindow, Menu, shell, type BrowserWindowConstructorOptions } from "electron";
import path from "node:path";
import { acquireFileLock } from "../../../server/src/update/lock.ts";
import { STARTUP_TOKEN_ENV } from "../../../server/src/update/startup.ts";
import { hidesMenu } from "../keys.ts";
import { openOutside } from "../links.ts";
import { dataUrl } from "../status-page.ts";
import { logLine, sweepOwnTmp, watcherEffects } from "./handoff.ts";
import { decideLaunch, WATCH_FLAG } from "./launch-kinds.ts";
import { pageAction, renderUpdatePage, type PageAction } from "./page.ts";
import { launchFacts, routeUnrouted, takeProfileLock, type Copy } from "./routing.ts";
import { updateLockFile } from "./transaction.ts";
import { resumeWatcher, retryCleanup, runWatcher } from "./watch.ts";
import type { Words } from "./words.ts";

export interface InstalledHost {
  readonly copy: Copy;
  readonly testBuild: boolean;
  readonly trustedKeys: readonly string[];
  /** The release page the words send a person to. */
  readonly releasePage: string;
  /** The app's own window options (window.ts), so a page looks like the app. */
  readonly window: () => BrowserWindowConstructorOptions;
  /** Whether this launch asked for no window (a background start). */
  readonly background: boolean;
}

/** How main starts the app once the routing says so. */
export interface StartApp {
  /** A token launch: T1 or T2, admission closed until a result carries the token. */
  readonly token?: string;
  /** Shown instead of the client: the update startup page, or the earlier failure page. */
  readonly page?: Words;
  /** The earlier failure: the server waits for the page's one button. */
  readonly hold?: boolean;
}

const log = (line: string) => console.error(`[desktop] ${line}`);

/** The page's URL: the words once, the release page only where they send the person there. */
export const updatePageUrl = (words: Words, releasePage: string, actions: readonly PageAction[] = []): string =>
  dataUrl(renderUpdatePage({ words, releasePage, actions }));

/** What a page-only process needs: the app's window options and the release page. */
export type PageHost = Pick<InstalledHost, "window" | "releasePage">;

/** A window with one page and no server behind it. A release page link opens in the system browser; nothing else navigates. */
function openPage(host: PageHost, words: Words): BrowserWindow {
  if (hidesMenu(process.platform)) Menu.setApplicationMenu(null);
  const window = new BrowserWindow(host.window());
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => {
    event.preventDefault();
    if (pageAction(url) === null) openOutside(url, { openExternal: (target) => shell.openExternal(target), log });
  });
  void window.loadURL(updatePageUrl(words, host.releasePage));
  return window;
}

/** A process that only shows pages uses its own profile folder, so it never shares one with a running app. */
function ownProfile(name: string): void {
  app.setPath("userData", path.join(app.getPath("userData"), name));
}

/** Pages this process shows; it exits once its work is done and the last page is closed. */
function pageCounter(host: PageHost): { show: (words: Words) => void; done: (code: number) => void } {
  let open = 0;
  let finished: number | null = null;
  // Closing a page never quits by itself: the watcher may still be working.
  app.on("window-all-closed", () => undefined);
  return {
    show: (words) => {
      open++;
      void app.whenReady().then(() => {
        openPage(host, words).on("closed", () => {
          open--;
          if (finished !== null && open === 0) app.exit(finished);
        });
      });
    },
    done: (code) => {
      finished = code;
      if (open === 0) app.exit(code);
    },
  };
}

/** Say this and exit when the person closes the page. */
function sayAndExit(host: PageHost, words: Words): void {
  ownProfile("update-pages");
  const pages = pageCounter(host);
  pages.show(words);
  pages.done(0);
}

/**
 * Watcher mode (spawned at row H, or an ordinary launch that found an
 * unfinished update with update.lock free): no profile lock and no server.
 * The watcher's own pages (stuck, rollback failed) and a stop the person must
 * hear about open here; everything else ends without a window.
 */
async function runAsWatcher(host: InstalledHost, file: string, resumed: boolean): Promise<void> {
  ownProfile("update-watcher");
  const pages = pageCounter(host);
  let code = 0;
  // Earlier launches' extract folders, swept before this watcher starts any
  // launch: a launch it starts gets an empty folder that its runtime fills
  // only later. This watcher's own folder is in use, so it stays.
  sweepOwnTmp(process.env);
  try {
    const fx = watcherEffects({ program: host.copy.program, dataDir: host.copy.dataDir, env: process.env, argv: process.argv, testBuild: host.testBuild, trustedKeys: host.trustedKeys, showPage: pages.show });
    const outcome = await (resumed ? resumeWatcher : runWatcher)(file, fx);
    logLine(host.copy.dataDir, `watcher ended: ${outcome.outcome}`);
    // A stop that starts no app (the old version did not close in time) is said here, or nowhere.
    if (outcome.outcome === "stopped" && !outcome.startApp && outcome.words !== null) pages.show(outcome.words);
  } catch (error) {
    // A crash of the watcher: nothing is turned into an ending, the transaction stays for the next launch.
    logLine(host.copy.dataDir, `watcher crashed: ${(error as Error).message}`);
    code = 1;
  }
  pages.done(code);
}

/**
 * A packaged Linux launch with no program file to replace, holding the
 * profile lock: it reads this data folder's transaction and update.lock before
 * it opens anything, and while either says an update is unfinished it says
 * so and exits, never opening the store (launch-kinds.ts, decideUnrouted).
 */
export function routeUnreplaceable(host: PageHost, dataDir: string, start: (o?: StartApp) => void): void {
  const kind = routeUnrouted(dataDir, {
    start,
    sayAndExit: (words) => {
      app.releaseSingleInstanceLock();
      sayAndExit(host, words);
    },
  });
  if (kind.kind !== "ordinary") log(`launch with no program to replace: ${kind.kind}`);
}

/**
 * The three kinds of launch (launch-kinds.ts): an ordinary launch decides
 * holding the profile lock, the watcher never takes it, and a token launch
 * takes it itself, retrying, because a double-click may hold it on its way out.
 */
export function routeInstalled(host: InstalledHost, start: (o?: StartApp) => void): void {
  const watching = process.argv.some(a => a.startsWith(`${WATCH_FLAG}=`));
  const hasToken = (process.env[STARTUP_TOKEN_ENV] ?? "") !== "";
  if (!watching && !hasToken && !app.requestSingleInstanceLock({ background: host.background })) {
    app.quit();
    return;
  }
  const kind = decideLaunch(launchFacts(host.copy, process.argv, process.env));
  if (kind.kind !== "ordinary") logLine(host.copy.dataDir, `launch: ${kind.kind}${"why" in kind ? ` (${kind.why})` : ""}`);
  switch (kind.kind) {
    case "watcher":
      void runAsWatcher(host, kind.transactionFile, false);
      return;
    case "exit-unchanged":
    case "token-refused":
      app.exit(0);
      return;
    case "token-launch":
      void takeProfileLock(() => app.requestSingleInstanceLock({ background: false }), kind.profileLockRetryMs).then((taken) => {
        if (taken) start({ token: kind.token, page: kind.words });
        else {
          logLine(host.copy.dataDir, "token launch: the profile lock stayed held");
          app.exit(1);
        }
      });
      return;
    case "ordinary":
      start();
      return;
    case "show-earlier-failure":
      start({ page: kind.words, hold: true });
      return;
    case "say-and-exit":
      app.releaseSingleInstanceLock();
      sayAndExit(host, kind.words);
      return;
    case "become-watcher":
      app.releaseSingleInstanceLock();
      void runAsWatcher(host, kind.transactionFile, true);
      return;
    case "ordinary-after-cleanup": {
      const taken = acquireFileLock(updateLockFile(host.copy.dataDir));
      if (taken.ok) {
        try {
          if (!retryCleanup(kind.transactionFile)) logLine(host.copy.dataDir, "cleanup is still pending");
        } finally {
          taken.lock.release();
        }
      }
      start();
      return;
    }
    case "transaction-unreadable":
      sayAndExit(host, kind.words);
      return;
  }
}
