import { describe, expect, it } from "vitest";
import { ZOOM_MAX, ZOOM_MIN, hidesMenu, zoomAfter, type KeyInput } from "../src/keys.ts";

const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({ type: "keyDown", key: k, control: false, meta: false, alt: false, ...mods });

describe("zoom keys without a menu", () => {
  it("Ctrl with =, +, - and 0 zooms in, out and resets on Linux and Windows", () => {
    for (const platform of ["linux", "win32"] as const) {
      expect(zoomAfter(key("=", { control: true }), 0, platform)).toBe(0.5);
      expect(zoomAfter(key("+", { control: true }), 0.5, platform)).toBe(1);
      expect(zoomAfter(key("-", { control: true }), 0, platform)).toBe(-0.5);
      expect(zoomAfter(key("_", { control: true }), 0, platform)).toBe(-0.5);
      expect(zoomAfter(key("0", { control: true }), 2, platform)).toBe(0);
    }
  });

  it("Cmd zooms on macOS and Ctrl does not", () => {
    expect(zoomAfter(key("=", { meta: true }), 0, "darwin")).toBe(0.5);
    expect(zoomAfter(key("=", { control: true }), 0, "darwin")).toBeNull();
  });

  it("stops at the bounds", () => {
    expect(zoomAfter(key("=", { control: true }), ZOOM_MAX, "linux")).toBe(ZOOM_MAX);
    expect(zoomAfter(key("-", { control: true }), ZOOM_MIN, "linux")).toBe(ZOOM_MIN);
  });

  it("leaves other keys, key-up, a bare key and Alt combinations to the page", () => {
    expect(zoomAfter(key("c", { control: true }), 0, "linux")).toBeNull();
    expect(zoomAfter({ ...key("=", { control: true }), type: "keyUp" }, 0, "linux")).toBeNull();
    expect(zoomAfter(key("="), 0, "linux")).toBeNull();
    expect(zoomAfter(key("=", { control: true, alt: true }), 0, "linux")).toBeNull();
  });
});

describe("menu bar", () => {
  it("is hidden on Linux and Windows and kept on macOS", () => {
    expect(hidesMenu("linux")).toBe(true);
    expect(hidesMenu("win32")).toBe(true);
    expect(hidesMenu("darwin")).toBe(false);
  });
});
