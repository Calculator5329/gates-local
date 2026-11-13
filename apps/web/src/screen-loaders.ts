import { deferred } from "./deferred.ts";

export const settingsScreen = deferred(() => import("./Settings.tsx"));
export const firstRunScreen = deferred(() => import("./FirstRun.tsx"));
export const pickerScreen = deferred(() => import("./Picker.tsx"));
export const imagePickerScreen = deferred(() => import("./ImagePicker.tsx"));
export const threadScreen = deferred(() => import("./Thread.tsx"));
export const usageScreen = deferred(() => import("./Usage.tsx"));
export const picturesScreen = deferred(() => import("./Pictures.tsx"));
