import { deferred } from "./deferred.ts";

export const settingsScreen = deferred(() => import("./Settings.tsx"));
export const firstRunScreen = deferred(() => import("./FirstRun.tsx"));
export const pickerScreen = deferred(() => import("./Picker.tsx"));
export const threadScreen = deferred(() => import("./Thread.tsx"));
