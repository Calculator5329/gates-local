import { useSyncExternalStore } from "react";
import { afterFirstPaint, type deferred } from "../lib/session/deferred.ts";
import { firstRunScreen, settingsScreen } from "./screen-loaders.ts";
export { firstRunScreen, imagePickerScreen, pickerScreen, settingsScreen, threadScreen } from "./screen-loaders.ts";

const unwatched = () => () => {};

export function useScreen<T>(screen: ReturnType<typeof deferred<T>>, needed: boolean) {
  return useSyncExternalStore(needed ? screen.need : unwatched, screen.get, screen.get);
}

export function preloadScreens(): () => void {
  return afterFirstPaint(() => {
    void settingsScreen.load();
    void firstRunScreen.load();
  });
}

export function ScreenError() {
  return (
    <p role="alert" className="na">
      This page couldn't load. The app may have updated. {" "}
      <button type="button" className="link" data-testid="ui.screen-error.reload" onClick={() => location.reload()}>Reload</button>
    </p>
  );
}
