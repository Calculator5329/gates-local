import { deferred } from "./deferred.ts";

export const settingsScreen = deferred(() => import("./Settings.tsx"));
export const firstRunScreen = deferred(() => import("./FirstRun.tsx"));
export const pickerScreen = deferred(() => import("./Picker.tsx"));
export const imagePickerScreen = deferred(() => import("./ImagePicker.tsx"));
// the page panel beside the chat comes with the chat
export const threadScreen = deferred(async () => {
  const [thread, pages] = await Promise.all([import("./Thread.tsx"), import("./pages/PagePanel.tsx")]);
  return { ...thread, PagePanel: pages.PagePanel };
});
export const usageScreen = deferred(() => import("./Usage.tsx"));
export const picturesScreen = deferred(() => import("./Pictures.tsx"));
