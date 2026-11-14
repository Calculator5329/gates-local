// Measure's page checks, run in this window (row 29). A model wrote a self-contained page; here it
// is loaded with its scripts on, used the way the check says (click, type, read), and what it
// showed goes back to the server, which grades it (apps/server/src/measure/score.ts).
//
// The page runs in an invisible frame, sandboxed with scripts only: no same origin (it can't
// reach this app, its storage or its cookies), no forms, popups, dialogs or top navigation. A
// content policy put first in the page refuses every network load. The frame is laid out but
// never seen or clicked, and takes no focus from the app. A page that does not finish in time,
// or leaves for another address, fails.
import type { PageAction, PageSeen } from "@gates-local/contracts";

/** How long one page may take from load to its last action. */
export const PAGE_MS = 5000;
const STEP_MS = 40;

const POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:";
const HEAD = `<meta http-equiv="Content-Security-Policy" content="${POLICY}"><meta http-equiv="x-dns-prefetch-control" content="off">`;

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

/** The page as the frame loads it: the policy first (after a doctype, so the page keeps its mode), the harness last. */
export function framed(page: string, token: string, script: readonly PageAction[], stepMs = STEP_MS): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(page)?.[0] ?? "";
  const tail = `<script>(${harness.toString()})(${JSON.stringify(token)}, ${JSON.stringify(script)}, ${stepMs});</script>`;
  return `${doctype}${HEAD}${page.slice(doctype.length)}${tail}`;
}

/** One page, used in a sandboxed frame; resolves with what it showed, or why it could not be used. */
export function runPage(id: string, page: string, script: readonly PageAction[], timeoutMs = PAGE_MS): Promise<PageSeen> {
  return new Promise((resolve) => {
    const token = crypto.randomUUID();
    const frame = document.createElement("iframe");
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    frame.setAttribute("sandbox", "allow-scripts");
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
    frame.srcdoc = framed(page, token, script);
    document.body.append(frame);
  });
}

/** Each pending page of a measure, one after another. */
export async function runPages(checks: readonly { id: string; state?: string; page?: string; script?: readonly PageAction[] }[]): Promise<PageSeen[]> {
  const seen: PageSeen[] = [];
  for (const c of checks) {
    if (c.state !== "pending") continue;
    seen.push(c.page && c.script ? await runPage(c.id, c.page, c.script) : { id: c.id, seen: [], error: "The page was not kept." });
  }
  return seen;
}
