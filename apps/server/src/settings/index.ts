// Settings: one JSON file in the data dir. Other modules read it through SettingsReader.
export { applyPatch, defaultSettings, openSettingsStore, SETTINGS_FILE_NAME, type SettingsReader, type SettingsStore } from "./store.ts";
export { createSettingsHandlers } from "./handlers.ts";
