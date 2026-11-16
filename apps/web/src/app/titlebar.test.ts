import { afterEach, describe, expect, it, vi } from "vitest";

async function desktop() {
  vi.resetModules();
  const overlay = Object.assign(new EventTarget(), { visible: true });
  const document = { title: "Gates Local", documentElement: { classList: { toggle: vi.fn() } } };
  vi.stubGlobal("navigator", { windowControlsOverlay: overlay });
  vi.stubGlobal("window", { gatesLocal: {} });
  vi.stubGlobal("document", document);
  vi.stubGlobal("matchMedia", () => new EventTarget());
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
  const { syncWindowTitle } = await import("./titlebar.ts");
  return { overlay, document, syncWindowTitle };
}

afterEach(() => vi.unstubAllGlobals());

describe("desktop window title", () => {
  it("keeps the selected thread's title through fullscreen and restoring the overlay (TB-04)", async () => {
    const { overlay, document, syncWindowTitle } = await desktop();
    syncWindowTitle("Thread A");
    expect(document.title).toBe("Thread A · Gates Local");
    overlay.visible = false;
    overlay.dispatchEvent(new Event("geometrychange"));
    syncWindowTitle("Thread B");
    expect(document.title).toBe("Thread B · Gates Local");
    overlay.visible = true;
    overlay.dispatchEvent(new Event("geometrychange"));
    expect(document.documentElement.classList.toggle).toHaveBeenLastCalledWith("wco", true);
    expect(document.title).toBe("Thread B · Gates Local");
  });

  it("resets the OS title for a new thread while the overlay is hidden", async () => {
    const { overlay, document, syncWindowTitle } = await desktop();
    syncWindowTitle("Thread A");
    overlay.visible = false;
    syncWindowTitle(null);
    expect(document.title).toBe("Gates Local");
  });

  it("hands the desktop bridge the page's own background and text colours for the window buttons", async () => {
    const { overlay, document } = await desktop();
    const syncTitleBar = vi.fn(async () => undefined);
    vi.stubGlobal("window", { gatesLocal: { syncTitleBar } });
    const tokens: Record<string, string> = { "--background": " #101112 ", "--foreground": " #e8e8e8" };
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: (name: string) => tokens[name] ?? "" }));
    overlay.dispatchEvent(new Event("geometrychange"));
    expect(syncTitleBar).toHaveBeenLastCalledWith({ color: "#101112", symbolColor: "#e8e8e8" });
    expect(document.documentElement.classList.toggle).toHaveBeenLastCalledWith("wco", true);
  });

  it("leaves an ordinary browser's title unchanged even when it exposes the overlay API", async () => {
    const { overlay, document, syncWindowTitle } = await desktop();
    vi.stubGlobal("window", {});
    overlay.visible = false;
    syncWindowTitle("Thread B");
    expect(document.title).toBe("Gates Local");
  });
});
