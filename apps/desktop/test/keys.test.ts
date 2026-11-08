import { describe, expect, it } from "vitest";
import { ZOOM_MAX, ZOOM_MIN, hidesMenu, installWindowKeys, windowAction, zoomAfter, type KeyInput, type KeyedContents, type KeyedWindow } from "../src/keys.ts";

const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({ type: "keyDown", key: k, control: false, shift: false, meta: false, alt: false, ...mods });
const ctrl = (k: string, mods: Partial<KeyInput> = {}) => key(k, { control: true, ...mods });
const dev = { devTools: true };

describe("windowAction on Linux and Windows", () => {
  it("gives the default menu's accelerators back", () => {
    for (const platform of ["linux", "win32"] as const) {
      expect(windowAction(ctrl("r"), platform, dev)).toBe("reload");
      expect(windowAction(ctrl("R", { shift: true }), platform, dev)).toBe("force-reload");
      expect(windowAction(ctrl("w"), platform, dev)).toBe("close");
      expect(windowAction(key("F11"), platform, dev)).toBe("fullscreen");
      expect(windowAction(ctrl("I", { shift: true }), platform, dev)).toBe("devtools");
      expect(windowAction(ctrl("="), platform, dev)).toBe("zoom-in");
      expect(windowAction(ctrl("+", { shift: true }), platform, dev)).toBe("zoom-in");
      expect(windowAction(ctrl("-"), platform, dev)).toBe("zoom-out");
      expect(windowAction(ctrl("_", { shift: true }), platform, dev)).toBe("zoom-out");
      expect(windowAction(ctrl("0"), platform, dev)).toBe("zoom-reset");
    }
  });

  it("Ctrl+Q quits on Linux only, as the quit role does (Windows closes with Alt+F4)", () => {
    expect(windowAction(ctrl("q"), "linux", dev)).toBe("quit");
    expect(windowAction(ctrl("q"), "win32", dev)).toBeNull();
  });

  it("a Caps Lock letter still counts", () => {
    expect(windowAction(ctrl("R"), "linux", dev)).toBe("reload");
    expect(windowAction(ctrl("W"), "linux", dev)).toBe("close");
  });

  it("dev tools only when allowed (an unpackaged run)", () => {
    expect(windowAction(ctrl("I", { shift: true }), "linux", { devTools: false })).toBeNull();
  });

  it("leaves editing keys, the client's own Ctrl keys and unrelated keys to the page", () => {
    for (const k of ["a", "c", "v", "x", "z", "y", "n", "k", "m", ","]) expect(windowAction(ctrl(k), "linux", dev), k).toBeNull();
    expect(windowAction(ctrl("Z", { shift: true }), "linux", dev)).toBeNull();
    expect(windowAction(ctrl("i"), "linux", dev)).toBeNull();
    expect(windowAction(key("r"), "linux", dev)).toBeNull();
    expect(windowAction(key("Alt"), "linux", dev)).toBeNull();
  });

  it("ignores key-up, Alt and Super combinations, and keys mid-composition", () => {
    expect(windowAction({ ...ctrl("r"), type: "keyUp" }, "linux", dev)).toBeNull();
    expect(windowAction({ ...ctrl("r"), type: "char" }, "linux", dev)).toBeNull();
    expect(windowAction(ctrl("r", { alt: true }), "linux", dev)).toBeNull();
    expect(windowAction(ctrl("=", { alt: true }), "linux", dev)).toBeNull();
    expect(windowAction(ctrl("r", { meta: true }), "linux", dev)).toBeNull();
    expect(windowAction(key("F11", { alt: true }), "linux", dev)).toBeNull();
    expect(windowAction(ctrl("=", { isComposing: true }), "linux", dev)).toBeNull();
  });

  it("a held key repeats zoom only", () => {
    expect(windowAction(ctrl("=", { isAutoRepeat: true }), "linux", dev)).toBe("zoom-in");
    for (const input of [ctrl("r"), ctrl("w"), ctrl("q"), key("F11"), ctrl("I", { shift: true })]) {
      expect(windowAction({ ...input, isAutoRepeat: true }, "linux", dev), input.key).toBeNull();
    }
  });

  it("does nothing on macOS, whose menu keeps these keys", () => {
    expect(windowAction(ctrl("r"), "darwin", dev)).toBeNull();
    expect(windowAction(key("=", { meta: true }), "darwin", dev)).toBeNull();
  });
});

describe("zoomAfter", () => {
  it("steps by half a level and stops at the bounds", () => {
    expect(zoomAfter("zoom-in", 0)).toBe(0.5);
    expect(zoomAfter("zoom-out", 0)).toBe(-0.5);
    expect(zoomAfter("zoom-reset", 2)).toBe(0);
    expect(zoomAfter("zoom-in", ZOOM_MAX)).toBe(ZOOM_MAX);
    expect(zoomAfter("zoom-out", ZOOM_MIN)).toBe(ZOOM_MIN);
  });
});

function fakes() {
  const calls: string[] = [];
  let listener: ((event: { preventDefault(): void }, input: KeyInput) => void) | null = null;
  let zoom = 0;
  let full = false;
  const contents: KeyedContents = {
    on(event, l) {
      calls.push(`on ${event}`);
      listener = l;
    },
    getZoomLevel: () => zoom,
    setZoomLevel: (level) => {
      zoom = level;
      calls.push(`zoom ${level}`);
    },
    reload: () => calls.push("reload"),
    reloadIgnoringCache: () => calls.push("reloadIgnoringCache"),
    toggleDevTools: () => calls.push("toggleDevTools"),
  };
  const window: KeyedWindow = {
    close: () => calls.push("close"),
    isFullScreen: () => full,
    setFullScreen: (flag) => {
      full = flag;
      calls.push(`fullscreen ${String(flag)}`);
    },
  };
  /** Sends a key; returns whether the handler kept it from the page. */
  const press = (input: KeyInput): boolean => {
    if (listener === null) throw new Error("no before-input-event listener");
    let prevented = false;
    listener({ preventDefault: () => (prevented = true) }, input);
    return prevented;
  };
  return { calls, contents, window, press };
}

describe("installWindowKeys", () => {
  it("registers on before-input-event and runs each action on the window", () => {
    const f = fakes();
    let quits = 0;
    installWindowKeys(f.window, f.contents, { platform: "linux", devTools: true, quit: () => quits++ });
    expect(f.calls).toEqual(["on before-input-event"]);
    for (const input of [ctrl("="), ctrl("="), ctrl("-"), ctrl("0"), ctrl("r"), ctrl("R", { shift: true }), key("F11"), key("F11"), ctrl("I", { shift: true }), ctrl("w")]) {
      expect(f.press(input), input.key).toBe(true);
    }
    expect(f.press(ctrl("q"))).toBe(true);
    expect(quits).toBe(1);
    expect(f.calls.slice(1)).toEqual(["zoom 0.5", "zoom 1", "zoom 0.5", "zoom 0", "reload", "reloadIgnoringCache", "fullscreen true", "fullscreen false", "toggleDevTools", "close"]);
  });

  it("lets editing keys through to the page untouched", () => {
    const f = fakes();
    installWindowKeys(f.window, f.contents, { platform: "linux", devTools: true, quit: () => {} });
    for (const k of ["a", "c", "v", "z"]) expect(f.press(ctrl(k)), k).toBe(false);
    expect(f.calls).toEqual(["on before-input-event"]);
  });

  it("registers nothing on macOS", () => {
    const f = fakes();
    installWindowKeys(f.window, f.contents, { platform: "darwin", devTools: true, quit: () => {} });
    expect(f.calls).toEqual([]);
  });
});

describe("menu bar", () => {
  it("is hidden on Linux and Windows and kept on macOS", () => {
    expect(hidesMenu("linux")).toBe(true);
    expect(hidesMenu("win32")).toBe(true);
    expect(hidesMenu("darwin")).toBe(false);
  });
});
