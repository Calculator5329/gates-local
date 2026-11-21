import { deferred } from "../lib/session/deferred.ts";

export const settingsScreen = deferred(() => import("../settings/Settings.tsx"));
export const firstRunScreen = deferred(() => import("../first-run/FirstRun.tsx"));
export const pickerScreen = deferred(() => import("../picker/Picker.tsx"));
export const imagePickerScreen = deferred(() => import("../image/ImagePicker.tsx"));
export const threadScreen = deferred(async () => {
  const [thread, pages] = await Promise.all([import("../thread/Thread.tsx"), import("../pages/PagePanel.tsx")]);
  return { ...thread, PagePanel: pages.PagePanel };
});
export const measureScreen = deferred(() => import("../measure/MeasureChat.tsx"));
export const usageScreen =deferred(() => import("../usage/Usage.tsx"));
export const picturesScreen = deferred(() => import("../pictures/Pictures.tsx"));
