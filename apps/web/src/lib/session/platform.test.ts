import { methodNames, phoneMay } from "@gates-local/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { applyTheme, canOpenFolder, canShowUpdate, canUpdateHere, computerOnlyMethods, dataFolder, folderDialog, openDataFolder, showUpdate } from "./platform.ts";

afterEach(() => vi.unstubAllGlobals());

const bridge = (over: Record<string, unknown> = {}) => vi.stubGlobal("window", { gatesLocal: { getServerUrl: () => Promise.resolve(null), onState: () => () => undefined, ...over } });

it("marks exactly what the method table denies when the page came from the phone listener", () => {
  expect(Object.keys(computerOnlyMethods(true)).toSorted()).toEqual(methodNames.filter((m) => !phoneMay(m)).toSorted());
});

it("marks nothing on the computer, whatever the window's size", () => {
  expect(computerOnlyMethods(false)).toEqual({});
});

it("dark and light are set on the page root, and System takes the mark off so the computer's own setting decides", () => {
  const root = new Map<string, string>();
  vi.stubGlobal("document", { documentElement: { setAttribute: (k: string, v: string) => void root.set(k, v), removeAttribute: (k: string) => void root.delete(k) } });
  applyTheme("dark");
  expect(root.get("data-theme")).toBe("dark");
  applyTheme("light");
  expect(root.get("data-theme")).toBe("light");
  applyTheme("system");
  expect(root.has("data-theme")).toBe(false);
});

it("opening the data folder says why when the desktop could not open it, and nothing when it did", async () => {
  bridge({ openDataFolder: () => Promise.resolve("The folder could not be opened.") });
  expect(await openDataFolder()).toBe("The folder could not be opened.");
  bridge({ openDataFolder: () => Promise.resolve(null) });
  expect(await openDataFolder()).toBeNull();
});

it("outside the desktop app, showing a downloaded update says only the desktop app can open its folder", async () => {
  vi.stubGlobal("window", {});
  expect(await showUpdate("1.2.0")).toBe("Only the desktop app can open this folder.");
});

it("showing a downloaded update asks the desktop for that version, says why when it fails, and nothing when it is shown", async () => {
  const asked: string[] = [];
  bridge({ showUpdate: (v: string) => { asked.push(v); return Promise.resolve(v === "1.2.0" ? "The update file is missing." : null); } });
  expect(await showUpdate("1.2.0")).toBe("The update file is missing.");
  expect(await showUpdate("1.3.0")).toBeNull();
  expect(asked).toEqual(["1.2.0", "1.3.0"]);
});

it("a browser or a phone has no data folder, no folder dialog, no Open folder, no Show update and no Update and restart", async () => {
  vi.stubGlobal("window", {});
  expect(await dataFolder()).toBeNull();
  expect(folderDialog()).toBeUndefined();
  expect([canOpenFolder(), canShowUpdate(), canUpdateHere()]).toEqual([false, false, false]);
});

it("the desktop app has its data folder, a folder dialog that opens where asked, Open folder, Show update and Update and restart", async () => {
  const starts: (string | undefined)[] = [];
  bridge({
    updateApprovalVersion: 2,
    updateAndRestart: () => Promise.resolve({ ok: true }),
    dataFolder: () => Promise.resolve("/home/me/.gates-local"),
    pickFolder: (start?: string) => { starts.push(start); return Promise.resolve(null); },
    modelsFolder: () => Promise.resolve("/models"),
    openModelsFolder: () => Promise.resolve(null),
    showUpdate: () => Promise.resolve(null),
  });
  expect(await dataFolder()).toBe("/home/me/.gates-local");
  expect(await folderDialog()?.("/start")).toBeNull();
  expect(starts).toEqual(["/start"]);
  expect([canOpenFolder(), canShowUpdate(), canUpdateHere()]).toEqual([true, true, true]);
});

it("Open folder needs the desktop to both name the models folder and open it", () => {
  bridge({ modelsFolder: () => Promise.resolve("/models") });
  expect(canOpenFolder()).toBe(false);
  bridge({ openModelsFolder: () => Promise.resolve(null) });
  expect(canOpenFolder()).toBe(false);
});
