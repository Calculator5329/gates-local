import type { PageAction, PageSeen } from "@gates-local/contracts";
import { framed } from "./measure-harness.ts";
import { type PageServer, lockFrame, pageAddress, pageMb } from "../pages/page-doc.ts";
import { sandboxOff } from "../pages/sandbox.ts";
import { getState } from "../lib/store/store.ts";
import { withTimeout } from "../lib/ui/kit/async.ts";

export const SANDBOX_OFF_SKIP = "Pages were not run: Chromium's sandbox is off in this copy.";
export const SANDBOX_UNKNOWN_SKIP = "Pages were not run: this copy did not say whether Chromium's sandbox is on.";
export const SERVER_REFUSED_SKIP = "The server did not take the page, so it was not run.";
export const SANDBOX_WAIT_MS = 10_000;

const server = (): PageServer => ({ origin: getState().serverOrigin, token: getState().fileToken });

export const PAGE_MS = 5000;

const shown = () => typeof document === "undefined" || document.visibilityState !== "hidden";

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

const focused = (): HTMLElement | undefined => (typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : undefined);

export async function runPage(id: string, page: string, script: readonly PageAction[], timeoutMs = PAGE_MS, at: PageServer = server(), before = focused()): Promise<PageSeen> {
  for (;;) {
    await whenShown();
    const seen = await runShown(id, page, script, timeoutMs, at, before);
    if (seen !== HIDDEN) return seen;
  }
}

const HIDDEN = Symbol("hidden");

async function runShown(id: string, page: string, script: readonly PageAction[], timeoutMs: number, at: PageServer, before: HTMLElement | undefined): Promise<PageSeen | typeof HIDDEN> {
  const token = crypto.randomUUID();
  const address = await pageAddress(framed(page, token, script), at);
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
    frame.addEventListener("load", () => {
      loads += 1;
      if (loads > 1) finish({ id, seen: [], error: "The page left for another address." });
    });
    frame.addEventListener("focus", () => before?.focus({ preventScroll: true }));
    // oxlint-disable-next-line gates/timer-needs-reason -- a written page may never post back; finish clears this with the frame's listeners
    timer = window.setTimeout(() => finish({ id, seen: [], error: `The page did not finish within ${Math.round(timeoutMs / 1000)} seconds.` }), timeoutMs);
    lockFrame(frame, address.url, "Measure page");
    document.body.append(frame);
  });
}

export async function runPages(
  checks: readonly { id: string; state?: string; page?: string; script?: readonly PageAction[] }[],
  off: () => Promise<boolean> = sandboxOff,
  waitMs = SANDBOX_WAIT_MS,
): Promise<PageSeen[]> {
  const skip = await withTimeout(off().then((o) => (o ? SANDBOX_OFF_SKIP : undefined), () => SANDBOX_UNKNOWN_SKIP), waitMs, () => SANDBOX_UNKNOWN_SKIP);
  const before = focused();
  return Promise.all(checks.filter((c) => c.state === "pending").map((c): PageSeen | Promise<PageSeen> =>
    skip !== undefined ? { id: c.id, seen: [], skipped: skip }
    : c.page && c.script ? runPage(c.id, c.page, c.script, PAGE_MS, server(), before)
    : { id: c.id, seen: [], error: "The page was not kept." }));
}
