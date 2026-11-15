// Behavior follows T3 Code chat/workspaceFileDrop.ts and TimelineOverlays.tsx at
// c55db3e9c7 (MIT, LICENSES/T3-Code-MIT.txt): only a drag that carries files is
// claimed; enter, over, leave and drop are all prevented so the window never
// opens the file; one plain status marker shows while files are over the window.
import { useEffect, useState } from "react";
import { Icon } from "./icons.tsx";
import { attachFiles, splitDropped } from "./paste.ts";
import { getState } from "./store.ts";

// Chromium lists "Files" when an image already in the page is dragged (a
// reply's image, a draft chip). Such a drag starts with a dragstart in this
// window; a file from outside never does. Those are left to the browser.
let inPage = false;
const carriesFiles = (e: DragEvent) => !inPage && (e.dataTransfer?.types.includes("Files") ?? false);

/**
 * A drag from outside the window that carries no files (a link, some text)
 * lands only where the person could type. Anywhere else the window would
 * follow a dropped link, and a page in a frame can offer one to drag: the
 * drag is refused there, so nothing navigates.
 */
export function refusesDrop(target: EventTarget | null): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null;
  if (el === null || typeof el.closest !== "function") return true;
  const field = el.closest("input, textarea, [contenteditable]:not([contenteditable='false'])") as { tagName?: string; type?: string; disabled?: boolean; readOnly?: boolean } | null;
  if (field === null || field.disabled === true || field.readOnly === true) return true;
  return field.tagName === "INPUT" && !TYPED.has((field.type ?? "").toLowerCase());
}
/** The inputs a person types text into. A checkbox, a slider or a button takes none, so the window would follow a link dropped there. */
const TYPED = new Set(["", "text", "search", "url", "email", "tel", "password", "number"]);
/** Refuses a drag this window does not take; true when it did. */
function refuse(e: DragEvent): boolean {
  if (inPage || carriesFiles(e) || !refusesDrop(e.target)) return false;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
  return true;
}

/** Set while a composer is mounted; when it cannot be used a drop is still claimed, and nothing is attached. */
let mark: ((at: { x: number; y: number } | null) => void) | null = null;
// A drag that ends outside the window without a leave event (Esc, a lost
// pointer) must not leave the marker up. Browsers repeat dragover at least
// every 550 ms while files are over the window, so 3 s of silence means gone.
let stale: ReturnType<typeof setTimeout> | undefined;
const hide = () => { clearTimeout(stale); mark?.(null); };

function where(): { x: number; y: number } {
  const composer = document.querySelector(".composer")?.getBoundingClientRect();
  if (!composer) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  return { x: composer.left + composer.width / 2, y: Math.max(48, composer.top / 2) };
}

/**
 * A drop attaches only where the person could type: a composer on screen with
 * no inert ancestor (the first-run cover, the thread drawer, a phone sheet)
 * and no popover open. T3 Code drops onto the chat canvas and never closes a
 * popover for it; here an open popover owns the window, so the drop waits.
 */
function usable(): boolean {
  if (!mark || getState().pop !== null) return false;
  const composer = document.querySelector(".composer");
  return composer !== null && composer.closest("[inert]") === null;
}

function over(e: DragEvent): void {
  if (refuse(e)) return;
  if (!carriesFiles(e)) return;
  e.preventDefault();
  const ok = usable();
  if (e.dataTransfer) e.dataTransfer.dropEffect = ok ? "copy" : "none";
  if (!ok) { hide(); return; }
  mark?.(where());
  clearTimeout(stale);
  stale = setTimeout(hide, 3000);
}

function leave(e: DragEvent): void {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  // Moving between elements inside the window names the next one; leaving the window names none.
  if (e.relatedTarget === null) hide();
}

function drop(e: DragEvent): void {
  if (inPage) { inPage = false; return; }
  if (refuse(e)) return;
  if (!carriesFiles(e)) return;
  e.preventDefault();
  const attaching = usable();
  hide();
  if (!attaching || !e.dataTransfer) return;
  const { files, folders } = splitDropped(e.dataTransfer);
  void attachFiles(files, folders);
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("dragenter", over, true);
  window.addEventListener("dragover", over, true);
  window.addEventListener("dragleave", leave, true);
  window.addEventListener("drop", drop, true);
  window.addEventListener("dragstart", () => { inPage = true; }, true);
  window.addEventListener("dragend", () => { inPage = false; hide(); }, true);
}

/** The composer's drop target: while it is mounted, file drops attach to its draft. */
export function DropMarker() {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const show = (next: { x: number; y: number } | null) => setAt(prev => prev && next && prev.x === next.x && prev.y === next.y ? prev : next);
    mark = show;
    return () => { if (mark === show) { mark = null; clearTimeout(stale); } };
  }, []);
  if (!at) return null;
  return <div className="drop-mark" role="status" style={{ left: at.x, top: at.y }}><Icon id="clip" />Drop files to attach</div>;
}
