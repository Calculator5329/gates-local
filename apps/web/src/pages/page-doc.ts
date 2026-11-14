// A page a model wrote, as the panel runs it. The page is the model's code, so
// it runs locked down, and its limits come from the server, not from the page:
// the code goes to the server's page route (apps/server/src/pages/route.ts),
// which keeps it under a one-time id and serves it once, with its content
// policy and sandbox as response headers. The frame loads that address, which
// carries no token, sandboxed to scripts only, with no referrer; the app's own
// policy (index.html) lets a frame load nothing but that route. Measure's page
// checks (measure-pages.ts) take the same way to their frame.

/** The frame's whole permission: its scripts run, and nothing else (no same origin, popups, forms, downloads or top navigation). */
export const PAGE_SANDBOX = "allow-scripts";

/** The largest page the server serves, in bytes of UTF-8 (PAGE_MAX_BYTES in the server's page route). */
export const PAGE_MAX = 2 * 1024 * 1024;

/** The page's size in bytes of UTF-8. */
export const pageBytes = (code: string): number => new TextEncoder().encode(code).length;

/** The page's size as a person reads it: megabytes with one decimal. */
export const pageMb = (code: string): string => (pageBytes(code) / (1024 * 1024)).toFixed(1);

/** Where the server is, as the session knows it: its http origin, and the token when its address had one (the phone's has none). */
export interface PageServer {
  readonly origin: string | null;
  readonly token: string | null;
}

/** The frame's address for a page, or why there is none. */
export type PageAddress = { readonly url: string } | { readonly error: "too-big" | "no-server" | "refused" };

const ID = /^[0-9a-f]{32}$/;

/**
 * Hands a page to the server and gives the address its frame loads: the server's origin, /pages/
 * and the id it answered with. The token goes only on the hand-over, never in the frame's address.
 */
export async function pageAddress(code: string, server: PageServer): Promise<PageAddress> {
  if (pageBytes(code) > PAGE_MAX) return { error: "too-big" };
  if (server.origin === null) return { error: "no-server" };
  try {
    const r = await fetch(`${server.origin}/pages${server.token ? `?token=${encodeURIComponent(server.token)}` : ""}`, {
      method: "POST",
      body: code,
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    if (r.status === 413) return { error: "too-big" };
    const id = r.ok ? ((await r.json()) as { id?: unknown }).id : undefined;
    return typeof id === "string" && ID.test(id) ? { url: `${server.origin}/pages/${id}` } : { error: "refused" };
  } catch {
    return { error: "refused" };
  }
}

/** Attributes every page frame carries, in the panel, in its own window and in Measure's checks; `url` is a pageAddress. */
export function lockFrame(frame: HTMLIFrameElement, url: string, title: string): void {
  frame.setAttribute("sandbox", PAGE_SANDBOX);
  frame.referrerPolicy = "no-referrer";
  frame.setAttribute("allow", "");
  frame.title = title;
  frame.src = url;
}

/** A file name for the page: its title in plain letters, else "page". */
export function pageFileName(title: string): string {
  const base = title.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 60);
  return `${base === "" ? "page" : base}.html`;
}

/** Save the page as the model wrote it, as an .html file. */
export function savePage(code: string, title: string): void {
  const url = URL.createObjectURL(new Blob([code], { type: "text/html" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = pageFileName(title);
  a.rel = "noopener";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * The page in its own window: a blank window of the app's holding the same
 * locked frame, never a blob: page (that would run with the app's origin).
 * The window opens on the click, is cut from this one, and gets its frame
 * once the server has the page.
 */
export function openPageWindow(code: string, title: string, server: PageServer): boolean {
  const w = window.open("", "_blank");
  if (w === null) return false;
  const doc = w.document;
  doc.title = title;
  const style = doc.createElement("style");
  style.textContent = "html,body{margin:0;height:100%;background:#0f0f0f}iframe{display:block;width:100%;height:100%;border:0}";
  doc.head.append(style);
  w.opener = null;
  void pageAddress(code, server).then((a) => {
    if (w.closed) return;
    if ("error" in a) {
      doc.body.textContent = "This page could not be run.";
      return;
    }
    const frame = doc.createElement("iframe");
    lockFrame(frame, a.url, title);
    doc.body.append(frame);
  });
  return true;
}
