// Behavior follows T3 Code chat/workspaceFileDrop.ts and TimelineOverlays.tsx at
// c55db3e9c7 (MIT, LICENSES/T3-Code-MIT.txt): only a drag that carries files is
// claimed; enter, over, leave and drop are all prevented so the window never
// opens the file; one plain status marker shows while files are over the window.
import { Icon } from "../lib/ui/icons.tsx";
import { attachFiles, splitDropped } from "./paste.ts";
import { getState, setState, useStore } from "../lib/store/store.ts";

// external: Chromium lists Files when an in-page image is dragged, after dragstart
let inPage = false;
const carriesFiles = (e: DragEvent) => !inPage && (e.dataTransfer?.types.includes("Files") ?? false);

// external: a browser window follows a dropped link
export function refusesDrop(target: EventTarget | null): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null;
  if (el === null || typeof el.closest !== "function") return true;
  const field = el.closest("input, textarea, [contenteditable]:not([contenteditable='false'])") as { tagName?: string; type?: string; disabled?: boolean; readOnly?: boolean } | null;
  if (field === null || field.disabled === true || field.readOnly === true) return true;
  return field.tagName === "INPUT" && !TYPED.has((field.type ?? "").toLowerCase());
}
const TYPED = new Set(["", "text", "search", "url", "email", "tel", "password", "number"]);
function refuse(e: DragEvent): boolean {
  if (inPage || carriesFiles(e) || !refusesDrop(e.target)) return false;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
  return true;
}

function mark(at: { x: number; y: number } | null): void {
  const was = getState().dropAt;
  if (was === at || (was !== null && at !== null && was.x === at.x && was.y === at.y)) return;
  setState({ dropAt: at });
}
// external: a browser repeats dragover every few hundred ms while a drag is over it
let stale: ReturnType<typeof setTimeout> | undefined;
const hide = () => { clearTimeout(stale); mark(null); };

function where(): { x: number; y: number } {
  const composer = document.querySelector(".composer")?.getBoundingClientRect();
  if (!composer) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  return { x: composer.left + composer.width / 2, y: Math.max(48, composer.top / 2) };
}

function usable(): boolean {
  if (getState().pop !== null) return false;
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
  mark(where());
  clearTimeout(stale);
  // oxlint-disable-next-line gates/timer-needs-reason -- the next dragover, which a drag still over the window sends within 550 ms
  stale = setTimeout(hide, 3000);
}

function leave(e: DragEvent): void {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  // external: a browser's dragleave names the next element, or null on leaving the window
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

export function DropMarker() {
  const at = useStore((s) => s.dropAt);
  if (!at) return null;
  return <div className="drop-mark" role="status" style={{ left: at.x, top: at.y }}><Icon id="clip" />Drop files to attach</div>;
}
