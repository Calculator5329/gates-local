import { useEffect, useSyncExternalStore } from "react";
import { afterFirstPaint, type deferred } from "./deferred.ts";
import { firstRunScreen, gpuScreen, settingsScreen } from "./screen-loaders.ts";
import { closeGpuPanel } from "./fit-actions.ts";
import { Icon } from "./icons.tsx";
export { firstRunScreen, gpuScreen, settingsScreen } from "./screen-loaders.ts";

export function useScreen<T>(screen: ReturnType<typeof deferred<T>>, needed: boolean) {
  const state = useSyncExternalStore(screen.subscribe, screen.get, screen.get);
  useEffect(() => {
    if (needed) void screen.load();
  }, [screen, needed]);
  return state;
}

export function preloadScreens(): () => void {
  return afterFirstPaint(() => {
    void settingsScreen.load();
    void firstRunScreen.load();
    void gpuScreen.load();
  });
}

/** Old tabs may request a chunk removed by an update. Leave a usable way back. */
export function ScreenError() {
  return (
    <p role="alert" className="na">
      This page couldn't load. The app may have updated. {" "}
      <button type="button" className="link" onClick={() => location.reload()}>Reload</button>
    </p>
  );
}

/** A failed phone sheet keeps the same close button and scrim as a loaded panel. */
export function GpuError() {
  useEffect(() => {
    document.getElementById("gpuErrorClose")?.focus({ preventScroll: true });
  }, []);
  return (
    <>
      <div className="scrim fp-scrim" aria-hidden="true" onClick={() => closeGpuPanel(true)} />
      <aside className="fpanel" id="fitPanel" aria-label="GPU memory">
        <div className="fpn-h">
          <span className="fp-h fp-t">GPU memory</span>
          <button type="button" className="ibtn xs fpn-x" id="gpuErrorClose" aria-label="Back to chat" onClick={() => closeGpuPanel(true)}>
            <Icon id="x" cls="s14" />
          </button>
        </div>
        <div className="fpn-b"><ScreenError /></div>
      </aside>
    </>
  );
}
