import { afterEach, describe, expect, it, vi } from "vitest";

async function desktop() {
  vi.resetModules();
  const overlay = Object.assign(new EventTarget(), { visible: true });
  const document = { title: "Gates Local" };
  vi.stubGlobal("navigator", { windowControlsOverlay: overlay });
  vi.stubGlobal("window", { gatesLocal: {} });
  vi.stubGlobal("document", document);
  vi.stubGlobal("matchMedia", () => new EventTarget());
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
    syncWindowTitle("Thread B");
    expect(document.title).toBe("Thread B · Gates Local");
    overlay.visible = true;
    expect(document.title).toBe("Thread B · Gates Local");
  });

  it("resets the OS title for a new thread while the overlay is hidden", async () => {
    const { overlay, document, syncWindowTitle } = await desktop();
    syncWindowTitle("Thread A");
    overlay.visible = false;
    syncWindowTitle(null);
    expect(document.title).toBe("Gates Local");
  });

  it("leaves an ordinary browser's title unchanged even when it exposes the overlay API", async () => {
    const { overlay, document, syncWindowTitle } = await desktop();
    vi.stubGlobal("window", {});
    overlay.visible = false;
    syncWindowTitle("Thread B");
    expect(document.title).toBe("Gates Local");
  });
});
