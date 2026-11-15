// The Electron side of an installed Linux copy's update
// (docs/design/installed-updates.md, section 2): the launch routing that runs
// before any window or server, the watcher process, and the pages that need
// no server. main.ts calls routeInstalled for every launch of a copy whose
// program is an AppImage, and routeUnreplaceable for every other packaged
// Linux launch, which shares the data folder. A source checkout's start goes
// through routeCheckout: its update is the checkout's own (packages/update),
// and the same rule holds, nothing starts beside an unfinished update.
import { app, BrowserWindow, Menu, shell, type BrowserWindowConstructorOptions } from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { checkoutStartFacts, decideCheckoutStart, DID_NOT_START, FINISH_TRIED_FLAG } from "@gates-local/update/checkout-start";
import { UpdateGuardError } from "@gates-local/update/guard";
import { acquireFileLock } from "@gates-local/update/lock";
import { STARTUP_TOKEN_ENV } from "@gates-local/update/startup";
import { startCheckout, type Started } from "../checkout-start.ts";
import { hidesMenu } from "../keys.ts";
import { openOutside } from "../links.ts";
import { clearRunning, writeRunning } from "../running.ts";
import { dataUrl } from "../status-page.ts";
import { cannotStartUpdater, finisherEnv, finisherLaunch } from "../update-launch.ts";
import { logLine, sweepOwnTmp, watcherEffects } from "./handoff.ts";
import { decideLaunch, WATCH_FLAG } from "./launch-kinds.ts";
import { pageAction, renderUpdatePage, type PageAction } from "./page.ts";
import { launchFacts, routeUnrouted, takeProfileLock, type Copy } from "./routing.ts";
import { updateLockFile } from "@gates-local/update/installed/transaction";
import { resumeWatcher, retryCleanup, runWatcher } from "./watch.ts";
import type { Words } from "@gates-local/update/installed/words";

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

/** A window for pages with no server behind them. A release page link opens in the system browser; nothing else navigates. */
function pageWindow(host: PageHost): BrowserWindow {
  if (hidesMenu(process.platform)) Menu.setApplicationMenu(null);
  const window = new BrowserWindow(host.window());
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => {
    event.preventDefault();
    if (pageAction(url) === null) openOutside(url, { openExternal: (target) => shell.openExternal(target), log });
  });
  return window;
}

/** A window with one page. */
function openPage(host: PageHost, words: Words): BrowserWindow {
  const window = pageWindow(host);
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

export interface CheckoutHost extends PageHost {
  /** The checkout this app runs from: apps/desktop/../.. */
  readonly root: string;
  readonly dataDir: string;
  /** Whether this launch asked for no window: it then says what it has to say in the log. */
  readonly background: boolean;
}

/**
 * A source checkout's start (../checkout-start.ts has the order of its
 * steps). It reads the checkout's lock and saved update before anything
 * else. With no update in flight it takes the single-instance lock and calls
 * `start`. While an updater runs it shows a page and waits; an update a crash
 * left is handed to the updater to finish or take back; an update still
 * unfinished after that is said in the page, and nothing starts.
 */
export function routeCheckout(host: CheckoutHost, start: () => void): void {
  let window: BrowserWindow | null = null;
  let opening = false;
  let page: string | null = null;
  const put = (words: Words, lines: readonly string[] = []): void => {
    for (const line of [words.text, ...lines]) log(line);
    page = dataUrl(renderUpdatePage({ words, lines, releasePage: host.releasePage, actions: [] }));
    if (host.background) return;
    if (window !== null && !window.isDestroyed()) void window.loadURL(page);
    if (opening) return;
    opening = true;
    void app.whenReady().then(() => {
      window = pageWindow(host);
      // The updater, if one is running, goes on without this window and opens the app itself when it has finished.
      window.on("closed", () => app.exit(0));
      if (page !== null) void window.loadURL(page);
    });
  };
  /** The updater told only to finish or take back; `ended` settles when its process has gone. */
  const finisher = (quits: boolean): Promise<Started & { readonly ended?: Promise<void> }> =>
    new Promise((resolve) => {
      const plan = finisherLaunch({ repoRoot: host.root, pid: process.pid, dataDir: host.dataDir, argv: process.argv, cwd: process.cwd(), env: process.env, exists: existsSync, quits });
      const child = spawn(plan.command, [...plan.args], { cwd: plan.cwd, env: finisherEnv(process.env), detached: true, stdio: "ignore", windowsHide: true });
      const ended = new Promise<void>((done) => child.once("exit", () => done()));
      child.once("error", (e) => resolve({ ok: false, message: cannotStartUpdater(e.message) }));
      child.once("spawn", () => {
        if (quits) child.unref();
        resolve({ ok: true, ended });
      });
    });
  // startCheckout calls `start` before its first wait or not at all, so main's start runs here, in this call, and a throw from it is main's own.
  let go = false;
  const end = startCheckout({
    look: (tried) => {
      try {
        return decideCheckoutStart(checkoutStartFacts(host.root, { env: process.env, tried }));
      } catch (e) {
        // The test guard's refusal is the test's to see.
        if (e instanceof UpdateGuardError) throw e;
        // Not knowing whether an update is in flight is not a reason to start on one.
        return { kind: "say", lines: [DID_NOT_START, `This copy's update state could not be read (${(e as Error).message}).`] };
      }
    },
    claim: () => {
      if (!app.requestSingleInstanceLock({ background: host.background })) {
        // A second launch reaches the first through the lock; it says whether it was itself a background launch.
        app.quit();
        return false;
      }
      try {
        writeRunning(host.dataDir, process.pid, Date.now());
      } catch (e) {
        log(`could not write the pid file: ${(e as Error).message}`);
      }
      return true;
    },
    unclaim: () => {
      clearRunning(host.dataDir, process.pid);
      app.releaseSingleInstanceLock();
    },
    start: () => {
      go = true;
    },
    pagesOnly: () => ownProfile("update-pages"),
    show: (words) => put(words),
    say: (lines) => {
      put({ text: lines[0] ?? DID_NOT_START }, lines.slice(1));
      if (host.background) app.exit(1);
    },
    finish: async () => {
      const started = await finisher(false);
      if (!started.ok) return started;
      await started.ended;
      return { ok: true };
    },
    handOver: async () => {
      const started = await finisher(true);
      if (!started.ok) return started;
      log(`updater started to finish the update of ${host.root}; quitting so it can replace files`);
      setTimeout(() => app.exit(0), 200);
      return { ok: true };
    },
    again: () => {
      app.relaunch({ args: process.argv.slice(1).filter((a) => a !== FINISH_TRIED_FLAG) });
      app.exit(0);
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }, { tried: process.argv.includes(FINISH_TRIED_FLAG), quitsToFinish: process.platform === "win32" });
  void end.then(
    (how) => {
      if (how !== "started") log(`checkout start: ${how}`);
    },
    (error: unknown) => {
      log(`checkout start failed: ${(error as Error).message}`);
      app.exit(1);
    },
  );
  if (go) start();
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
