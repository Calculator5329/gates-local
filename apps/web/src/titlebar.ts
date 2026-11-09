// Adapts apps/web/src/lib/windowControlsOverlay.ts in T3 Code (MIT),
// commit d137c5081ac5efb2b8ea9aec8b334e1bb4d0182a.
interface Overlay extends EventTarget { readonly visible: boolean }

export const windowOverlay = (navigator as Navigator & { windowControlsOverlay?: Overlay }).windowControlsOverlay;

/** The OS title remains available to the taskbar and window switcher. */
export function syncWindowTitle(title: string | null): void {
  if (windowOverlay && window.gatesLocal) document.title = `${title === null ? "" : `${title} · `}Gates Local`;
}

/** Only a desktop overlay changes the shell. Theme colours come from the same tokens as the page. */
export function syncTitleBar(): void {
  if (!windowOverlay) return;
  const root = document.documentElement;
  root.classList.toggle("wco", windowOverlay.visible);
  const css = getComputedStyle(root);
  void window.gatesLocal?.syncTitleBar?.({ color: css.getPropertyValue("--background").trim(), symbolColor: css.getPropertyValue("--foreground").trim() });
}

if (windowOverlay) {
  windowOverlay.addEventListener("geometrychange", syncTitleBar);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncTitleBar);
}
