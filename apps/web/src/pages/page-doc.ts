import { downloadBlob } from "../lib/ui/kit/async.ts";

export const PAGE_SANDBOX = "allow-scripts";

export const PAGE_MAX = 2 * 1024 * 1024;

export const pageBytes = (code: string): number => new TextEncoder().encode(code).length;

export const pageMb = (code: string): string => (pageBytes(code) / (1024 * 1024)).toFixed(1);

export interface PageServer {
  readonly origin: string | null;
  readonly token: string | null;
}

export type PageAddress = { readonly url: string } | { readonly error: "too-big" | "no-server" | "refused" };

const ID = /^[0-9a-f]{32}$/;

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

export function lockFrame(frame: HTMLIFrameElement, url: string, title: string): void {
  frame.setAttribute("sandbox", PAGE_SANDBOX);
  frame.referrerPolicy = "no-referrer";
  frame.setAttribute("allow", "");
  frame.title = title;
  frame.src = url;
}

export function pageFileName(title: string): string {
  const base = title.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 60);
  return `${base === "" ? "page" : base}.html`;
}

export function savePage(code: string, title: string): void {
  downloadBlob(new Blob([code], { type: "text/html" }), pageFileName(title));
}

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
