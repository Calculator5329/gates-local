import { useEffect, useSyncExternalStore } from "react";
import { afterFirstPaint, type deferred } from "./deferred.ts";
import { firstRunScreen, pickerScreen, settingsScreen } from "./screen-loaders.ts";
export { firstRunScreen, pickerScreen, settingsScreen } from "./screen-loaders.ts";

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
    void pickerScreen.load();
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
