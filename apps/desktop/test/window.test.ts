import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { iconFile, windowOptions } from "../src/window.ts";

const desktopDir = path.resolve(import.meta.dirname, "..");

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: string): [number, number] {
  const bytes = readFileSync(file);
  expect(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  expect(bytes.subarray(12, 16).toString("latin1")).toBe("IHDR");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

describe("window options", () => {
  it.each(["linux", "win32", "darwin"] as const)("integrates the titlebar on %s without removing native controls", (platform) => {
    const options = windowOptions({ icon: "/i.png", preload: "/x/preload.cjs", platform });
    expect(options.titleBarStyle).toBe(platform === "darwin" ? "hiddenInset" : "hidden");
    expect(options.titleBarOverlay).toEqual({ height: 52 });
    expect(options.frame).not.toBe(false);
    if (platform === "darwin") expect(options.trafficLightPosition).toEqual({ x: 16, y: 18 });
  });

  it("give the window the gate mark: the 512x512 assets/icon.png in an unpackaged run", () => {
    const icon = iconFile({ packaged: false, resourcesPath: "/unused", desktopDir });
    const options = windowOptions({ icon, preload: "/x/preload.cjs" });
    expect(options.icon).toBe(path.join(desktopDir, "assets", "icon.png"));
    expect(pngSize(icon)).toEqual([512, 512]);
  });

  it("take icon.png from the resources folder once packaged", () => {
    expect(iconFile({ packaged: true, resourcesPath: "/opt/gates/resources", desktopDir })).toBe(path.join("/opt/gates/resources", "icon.png"));
  });

  it("keep the renderer sandboxed and isolated", () => {
    expect(windowOptions({ icon: "/i.png", preload: "/x/preload.cjs" }).webPreferences).toEqual({
      preload: "/x/preload.cjs",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    });
  });
});
