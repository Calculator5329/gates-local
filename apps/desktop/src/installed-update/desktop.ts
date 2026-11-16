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
  readonly releasePage: string;
  readonly window: () => BrowserWindowConstructorOptions;
  readonly background: boolean;
}

export interface StartApp {
  readonly token?: string;
  readonly page?: Words;
  readonly hold?: boolean;
}

const log = (line: string) => console.error(`[desktop] ${line}`);

export const updatePageUrl = (words: Words, releasePage: string, actions: readonly PageAction[] = []): string =>
  dataUrl(renderUpdatePage({ words, releasePage, actions }));

export type PageHost = Pick<InstalledHost, "window" | "releasePage">;

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

function openPage(host: PageHost, words: Words): BrowserWindow {
  const window = pageWindow(host);
  void window.loadURL(updatePageUrl(words, host.releasePage));
  return window;
}

// why: a process that only shows pages must never share a profile folder with a running app.
function ownProfile(name: string): void {
  app.setPath("userData", path.join(app.getPath("userData"), name));
}

function pageCounter(host: PageHost): { show: (words: Words) => void; done: (code: number) => void } {
  let open = 0;
  let finished: number | null = null;
  // why: the watcher may still be working when the last page closes.
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

function sayAndExit(host: PageHost, words: Words): void {
  ownProfile("update-pages");
  const pages = pageCounter(host);
  pages.show(words);
  pages.done(0);
}

async function runAsWatcher(host: InstalledHost, file: string, resumed: boolean): Promise<void> {
  ownProfile("update-watcher");
  const pages = pageCounter(host);
  let code = 0;
  // why: a launch this watcher starts gets an empty folder that its runtime fills only later.
  sweepOwnTmp(process.env);
  try {
    const fx = watcherEffects({ program: host.copy.program, dataDir: host.copy.dataDir, env: process.env, argv: process.argv, testBuild: host.testBuild, trustedKeys: host.trustedKeys, showPage: pages.show });
    const outcome = await (resumed ? resumeWatcher : runWatcher)(file, fx);
    logLine(host.copy.dataDir, `watcher ended: ${outcome.outcome}`);
    // why: a stop that starts no app (the old app did not close in time) is said here or nowhere.
    if (outcome.outcome === "stopped" && !outcome.startApp && outcome.words !== null) pages.show(outcome.words);
  } catch (error) {
    // why: a watcher crash is no ending; the transaction stays for the next launch.
    logLine(host.copy.dataDir, `watcher crashed: ${(error as Error).message}`);
    code = 1;
  }
  pages.done(code);
}

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
  readonly root: string;
  readonly dataDir: string;
  readonly background: boolean;
}

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
      // why: a running updater goes on without this window and opens the app itself when done.
      window.on("closed", () => app.exit(0));
      if (page !== null) void window.loadURL(page);
    });
  };
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
  // why: startCheckout calls start before its first wait or not at all, so a throw is main's own.
  let go = false;
  const end = startCheckout({
    look: (tried) => {
      try {
        return decideCheckoutStart(checkoutStartFacts(host.root, { env: process.env, tried }));
      } catch (e) {
        // why: the test guard's refusal is the test's to see.
        if (e instanceof UpdateGuardError) throw e;
        // why: not knowing whether an update is in flight is no reason to start on one.
        return { kind: "say", lines: [DID_NOT_START, `This copy's update state could not be read (${(e as Error).message}).`] };
      }
    },
    claim: () => {
      if (!app.requestSingleInstanceLock({ background: host.background })) {
        // external: Electron hands the lock's data to the first instance's second-instance event.
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
