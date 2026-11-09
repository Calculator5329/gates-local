import { deferred } from "./deferred.ts";

export const settingsScreen = deferred(() => import("./Settings.tsx"));
export const firstRunScreen = deferred(() => import("./FirstRun.tsx"));
