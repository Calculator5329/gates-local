// A page a model wrote, as the panel runs it. The page is the model's code, so
// it runs locked down: a data: URL (a srcdoc frame would inherit this
// window's address, and with it the server token), sandboxed to scripts only,
// with a policy at the top of its document that lets nothing load from or go
// out to anywhere, and the WebRTC constructors gone before its own code runs.

export const PAGE_POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:";
/** The frame's whole permission: its scripts run, and nothing else (no same origin, popups, forms, downloads or top navigation). */
export const PAGE_SANDBOX = "allow-scripts";

const RTC = ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCSessionDescription", "RTCIceCandidate"];
const HEAD =
  `<meta http-equiv="Content-Security-Policy" content="${PAGE_POLICY}">` +
  `<meta name="referrer" content="no-referrer">` +
  `<script>for(const k of ${JSON.stringify(RTC)}){try{Object.defineProperty(window,k,{value:undefined,writable:false,configurable:false})}catch{}}</script>`;

/** The page's code with the policy first in its document, after its doctype so it keeps standards mode. */
export function framedDoc(code: string): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(code);
  return doctype === null ? `<!doctype html>${HEAD}${code}` : `${doctype[0]}${HEAD}${code.slice(doctype[0].length)}`;
}

/** The address the frame loads: the whole document in the URL, so it has no origin and no address of the app's. */
export const pageUrl = (code: string): string => `data:text/html;charset=utf-8,${encodeURIComponent(framedDoc(code))}`;

/** Attributes every page frame carries, in the panel and in its own window. */
export function lockFrame(frame: HTMLIFrameElement, code: string, title: string): void {
  frame.setAttribute("sandbox", PAGE_SANDBOX);
  frame.referrerPolicy = "no-referrer";
  frame.setAttribute("allow", "");
  frame.title = title;
  frame.src = pageUrl(code);
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
 * The window is cut from this one once it is drawn.
 */
export function openPageWindow(code: string, title: string): boolean {
  const w = window.open("", "_blank");
  if (w === null) return false;
  const doc = w.document;
  doc.title = title;
  const style = doc.createElement("style");
  style.textContent = "html,body{margin:0;height:100%;background:#0f0f0f}iframe{display:block;width:100%;height:100%;border:0}";
  doc.head.append(style);
  const frame = doc.createElement("iframe");
  lockFrame(frame, code, title);
  doc.body.append(frame);
  w.opener = null;
  return true;
}
