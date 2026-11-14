// Measure's page checks, run in this window (row 29). A model wrote a self-contained page; here it
// is loaded with its scripts on, used the way the check says (click, type, read), and what it
// showed goes back to the server, which grades it (apps/server/src/measure/score.ts).
//
// The page runs in an invisible frame built the way a chat's pages are (pages/page-doc.ts): the
// server's one-time page address, which holds no token, sandboxed with scripts only and no
// referrer, with the server's content policy as a header. The frame is laid out but never seen or
// clicked, and takes no focus from the app. A page that does not finish in time, loads a second
// document, or is too big for the server to serve, fails. A desktop app started with Chromium's
// sandbox off runs no pages here (pages/sandbox.ts): each goes back skipped, with that reason, and
// the score leaves Pages out rather than counting them failed.
import type { PageAction, PageSeen } from "@gates-local/contracts";
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

/** How long one page may take from load to its last action. */
export const PAGE_MS = 5000;
const STEP_MS = 40;

/** Runs in the frame after the page's own scripts: does each action, then posts what it saw. */
function harness(token: string, script: readonly PageAction[], stepMs: number) {
  const seen: string[] = [];
  const wait = () => new Promise((resolve) => setTimeout(resolve, stepMs));
  // The frame runs this function from its source text, so every helper it uses lives inside it.
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const text = (el: Element) => (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ? el.value : el.textContent ?? "").trim();
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const shown = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const run = async () => {
    for (const a of script) {
      if (a.do === "visible") {
        seen.push([...document.querySelectorAll(a.target)].filter(shown).map(text).join("|"));
        continue;
      }
      const el = document.querySelector(a.target);
      if (!el) {
        if (a.do === "read") seen.push("");
        continue;
      }
      if (a.do === "read") seen.push(text(el));
      else if (a.do === "click") (el as HTMLElement).click();
      else if (a.do === "fill" && "value" in el) {
        (el as HTMLInputElement).value = a.text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await wait();
    }
  };
  addEventListener("load", () => {
    setTimeout(() => {
      run().then(
        () => parent.postMessage({ token, seen }, "*"),
        (e: unknown) => parent.postMessage({ token, seen, error: `The check could not use the page: ${String(e)}` }, "*"),
      );
    }, stepMs);
  });
}

/** The page with the harness last; the frame builder puts its policy first. */
export function framed(page: string, token: string, script: readonly PageAction[], stepMs = STEP_MS): string {
  return `${page}<script>(${harness.toString()})(${JSON.stringify(token)}, ${JSON.stringify(script)}, ${stepMs});</script>`;
}

/** One page, used in a sandboxed frame; resolves with what it showed, or why it could not be used. */
export async function runPage(id: string, page: string, script: readonly PageAction[], timeoutMs = PAGE_MS, at: PageServer = server()): Promise<PageSeen> {
  const token = crypto.randomUUID();
  const address = await pageAddress(framed(page, token, script), at);
  // Too big is the model's page; a refusal or a dropped connection is not, so it counts for nothing.
  if ("error" in address) {
    return address.error === "too-big" ? { id, seen: [], error: `The page is too big to run here (${pageMb(page)} MB).` } : { id, seen: [], skipped: SERVER_REFUSED_SKIP };
  }
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("data-measure-page", id);
    frame.tabIndex = -1;
    frame.style.cssText = "position:fixed;left:0;top:0;width:400px;height:300px;border:0;opacity:0;pointer-events:none;z-index:-1";
    let loads = 0;
    let timer = 0;
    const finish = (seen: PageSeen) => {
      clearTimeout(timer);
      removeEventListener("message", onMessage);
      frame.remove();
      resolve(seen);
    };
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
 * Each pending page of a measure, one after another; none with the sandbox off, nor when the
 * desktop app has not said within `waitMs` whether it is on.
 */
export async function runPages(
  checks: readonly { id: string; state?: string; page?: string; script?: readonly PageAction[] }[],
  off: () => Promise<boolean> = sandboxOff,
  waitMs = SANDBOX_WAIT_MS,
): Promise<PageSeen[]> {
  const seen: PageSeen[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<string>((resolve) => { timer = setTimeout(() => resolve(SANDBOX_UNKNOWN_SKIP), waitMs); });
  const skip = await Promise.race([off().then((o) => (o ? SANDBOX_OFF_SKIP : undefined), () => SANDBOX_UNKNOWN_SKIP), late]);
  clearTimeout(timer);
  for (const c of checks) {
    if (c.state !== "pending") continue;
    if (skip !== undefined) seen.push({ id: c.id, seen: [], skipped: skip });
    else seen.push(c.page && c.script ? await runPage(c.id, c.page, c.script) : { id: c.id, seen: [], error: "The page was not kept." });
  }
  return seen;
}
