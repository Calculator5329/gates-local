// Measure's page checks, run in this window (row 29). A model wrote a self-contained page; here it
// is loaded with its scripts on, used the way the check says (click, type, read), and what it
// showed goes back to the server, which grades it (apps/server/src/measure/score.ts).
//
// The page runs in an invisible frame built the way a chat's pages are (pages/page-doc.ts): the
// server's one-time page address, which holds no token, sandboxed with scripts only and no
// referrer, with the server's content policy as a header. The frame is laid out but never seen or
// clicked, and takes no focus from the app. Pages run only while the window is shown (see
// `shown`). A page that does not finish in time, loads a second document, or is too big for the
// server to serve, fails. A desktop app started with Chromium's
// sandbox off runs no pages here (pages/sandbox.ts): each goes back skipped, with that reason, and
// the score leaves Pages out rather than counting them failed.
import type { PageAction, PageSeen } from "@gates-local/contracts";
import { framed } from "./measure-harness.ts";
import { type PageServer, lockFrame, pageAddress, pageMb } from "./pages/page-doc.ts";
import { sandboxOff } from "./pages/sandbox.ts";
import { getState } from "./store.ts";

/** Why Measure ran no page, in a desktop app started with the sandbox off. */
export const SANDBOX_OFF_SKIP = "Pages were not run: Chromium's sandbox is off in this copy.";
/** Why Measure ran no page when this copy did not say in time whether its sandbox is on. */
export const SANDBOX_UNKNOWN_SKIP = "Pages were not run: this copy did not say whether Chromium's sandbox is on.";
/** Why a page did not run when the server did not take it: the app's doing, not the model's. */
export const SERVER_REFUSED_SKIP = "The server did not take the page, so it was not run.";
/** How long the pages wait for the desktop app to say whether its sandbox is on. */
export const SANDBOX_WAIT_MS = 10_000;

/** The server as this window knows it. */
const server = (): PageServer => ({ origin: getState().serverOrigin, token: getState().fileToken });

/** How long one page may take from load to its last action, while the window is shown. */
export const PAGE_MS = 5000;

/**
 * Pages run only while this window is shown. A hidden window gets about one timer a second and no
 * animation frames, so a page that is right would time out or never paint: that is where the window
 * was, not what the model wrote. A page waits for the window to be shown, and one the window hid
 * while it ran starts again from a fresh load once it is shown, with its whole time.
 */
const shown = () => typeof document === "undefined" || document.visibilityState !== "hidden";

/** Resolves once this window is shown. */
function whenShown(): Promise<void> {
  if (shown()) return Promise.resolve();
  return new Promise((resolve) => {
    const on = () => {
      if (!shown()) return;
      document.removeEventListener("visibilitychange", on);
      resolve();
    };
    document.addEventListener("visibilitychange", on);
  });
}

/** What has the app's focus now, for a page frame to give it back to. */
const focused = (): HTMLElement | undefined => (typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : undefined);

/**
 * One page, used in a sandboxed frame; resolves with what it showed, or why it could not be used.
 * `before` is what keeps the app's focus (by default what has it now).
 */
export async function runPage(id: string, page: string, script: readonly PageAction[], timeoutMs = PAGE_MS, at: PageServer = server(), before = focused()): Promise<PageSeen> {
  for (;;) {
    await whenShown();
    const seen = await runShown(id, page, script, timeoutMs, at, before);
    if (seen !== HIDDEN) return seen;
  }
}

/** The window hid while the page ran: what it saw does not count, and the page runs again. */
const HIDDEN = Symbol("hidden");

async function runShown(id: string, page: string, script: readonly PageAction[], timeoutMs: number, at: PageServer, before: HTMLElement | undefined): Promise<PageSeen | typeof HIDDEN> {
  const token = crypto.randomUUID();
  const address = await pageAddress(framed(page, token, script), at);
  // Too big is the model's page; a refusal or a dropped connection is not, so it counts for nothing.
  if ("error" in address) {
    return address.error === "too-big" ? { id, seen: [], error: `The page is too big to run here (${pageMb(page)} MB).` } : { id, seen: [], skipped: SERVER_REFUSED_SKIP };
  }
  if (!shown()) return HIDDEN;
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("data-measure-page", id);
    frame.tabIndex = -1;
    frame.style.cssText = "position:fixed;left:0;top:0;width:400px;height:300px;border:0;opacity:0;pointer-events:none;z-index:-1";
    let loads = 0;
    let timer = 0;
    const finish = (seen: PageSeen | typeof HIDDEN) => {
      clearTimeout(timer);
      removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", onHidden);
      frame.remove();
      resolve(seen);
    };
    const onHidden = () => {
      if (!shown()) finish(HIDDEN);
    };
    document.addEventListener("visibilitychange", onHidden);
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { token?: unknown; seen?: unknown; error?: unknown } | null;
      if (e.source !== frame.contentWindow || data?.token !== token) return;
      const seen = Array.isArray(data.seen) ? data.seen.map(String) : [];
      finish({ id, seen, ...(typeof data.error === "string" ? { error: data.error } : {}) });
    };
    addEventListener("message", onMessage);
    // A second load is the page going somewhere else: it is not the page that was written.
    frame.addEventListener("load", () => {
      loads += 1;
      if (loads > 1) finish({ id, seen: [], error: "The page left for another address." });
    });
    // The page may not take the app's focus.
    frame.addEventListener("focus", () => before?.focus({ preventScroll: true }));
    timer = window.setTimeout(() => finish({ id, seen: [], error: `The page did not finish within ${Math.round(timeoutMs / 1000)} seconds.` }), timeoutMs);
    lockFrame(frame, address.url, "Measure page");
    document.body.append(frame);
  });
}

/**
 * Each pending page of a measure, all at once, each in its own frame with its own token (the server
 * keeps 32 page addresses at a time, pages/route.ts); none with the sandbox off, nor when the
 * desktop app has not said within `waitMs` whether it is on. Focus goes back to what had it before
 * any of them started.
 */
export async function runPages(
  checks: readonly { id: string; state?: string; page?: string; script?: readonly PageAction[] }[],
  off: () => Promise<boolean> = sandboxOff,
  waitMs = SANDBOX_WAIT_MS,
): Promise<PageSeen[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<string>((resolve) => { timer = setTimeout(() => resolve(SANDBOX_UNKNOWN_SKIP), waitMs); });
  const skip = await Promise.race([off().then((o) => (o ? SANDBOX_OFF_SKIP : undefined), () => SANDBOX_UNKNOWN_SKIP), late]);
  clearTimeout(timer);
  const before = focused();
  return Promise.all(checks.filter((c) => c.state === "pending").map((c): PageSeen | Promise<PageSeen> =>
    skip !== undefined ? { id: c.id, seen: [], skipped: skip }
    : c.page && c.script ? runPage(c.id, c.page, c.script, PAGE_MS, server(), before)
    : { id: c.id, seen: [], error: "The page was not kept." }));
}
