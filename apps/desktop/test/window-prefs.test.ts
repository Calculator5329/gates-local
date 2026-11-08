// The window's webPreferences, from windowOptions() in window.ts. Spellcheck
// stays off: Electron's default is on, and on Linux it downloads Hunspell
// dictionaries from a Google host (redirector.gvt1.com) when one is missing.
// The README's privacy list depends on this.
import { describe, expect, it } from "vitest";
import { windowOptions } from "../src/window.ts";

const prefs = windowOptions({ icon: "/x/icon.png", preload: "/x/preload.cjs" }).webPreferences!;

describe("the desktop window", () => {
  it("turns Electron's spellchecker off, so no dictionary is downloaded", () => {
    expect(prefs.spellcheck).toBe(false);
  });

  it("keeps the renderer sandboxed and isolated", () => {
    expect(prefs).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true });
  });
});
