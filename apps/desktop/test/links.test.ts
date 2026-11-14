import { describe, expect, it } from "vitest";
import { type FrameNavigation, type GuardedContents, guardNavigation, type LinkDeps, openOutside, PAGE_WINDOW, type WindowOpen } from "../src/links.ts";

const CLIENT = "gates-local://app";

/** One window's contents as the guard sees them: what it registered, under the event names Electron fires. */
function fakeContents() {
  const handlers = new Map<string, (...args: never[]) => void>();
  const state: { windowOpen?: (d: { url: string }) => WindowOpen; webrtc?: string } = {};
  const contents: GuardedContents = {
    setWindowOpenHandler: (h) => {
      state.windowOpen = h;
    },
    on: (event: string, listener: (...args: never[]) => void) => {
      // A listener under any other name would never run on a real navigation.
      expect(["will-navigate", "will-frame-navigate", "did-create-window"]).toContain(event);
      handlers.set(event, listener);
    },
    setWebRTCIPHandlingPolicy: (policy) => {
      state.webrtc = policy;
    },
  };
  const navigate = (url: string) => {
    let prevented = false;
    (handlers.get("will-navigate") as (e: { preventDefault(): void }, url: string) => void)({ preventDefault: () => (prevented = true) }, url);
    return prevented;
  };
  const frameNavigate = (details: Omit<FrameNavigation, "preventDefault">) => {
    let prevented = false;
    (handlers.get("will-frame-navigate") as (d: FrameNavigation) => void)({ ...details, preventDefault: () => (prevented = true) });
    return prevented;
  };
  const created = (child: GuardedContents) => (handlers.get("did-create-window") as (w: { webContents: GuardedContents }) => void)({ webContents: child });
  return { contents, state, navigate, frameNavigate, created, open: (url: string) => state.windowOpen!({ url }) };
}

function rig(opts: { openFails?: boolean } = {}) {
  const opened: string[] = [];
  const logged: string[] = [];
  const deps: LinkDeps = {
    isClientUrl: (url) => url.startsWith(`${CLIENT}/`),
    openExternal: (url) => {
      opened.push(url);
      return opts.openFails ? Promise.reject(new Error(`xdg-open failed for ${url}`)) : Promise.resolve();
    },
    log: (line) => logged.push(line),
  };
  const w = fakeContents();
  guardNavigation(w.contents, deps);
  return { opened, logged, deps, ...w };
}

const PAGE = "data:text/html;charset=utf-8,%3C!doctype%20html%3E";
const TOP = { parent: null };
const IN_FRAME = { parent: TOP };

describe("pages a reply wrote", () => {
  it("the window may put a page in a frame", () => {
    const r = rig();
    expect(r.frameNavigate({ url: PAGE, isMainFrame: false, initiator: TOP })).toBe(false);
  });

  it("a page cannot move its own frame, to the web or to another page", () => {
    const r = rig();
    expect(r.frameNavigate({ url: "https://example.com/collect?x=1", isMainFrame: false, initiator: IN_FRAME })).toBe(true);
    expect(r.frameNavigate({ url: PAGE, isMainFrame: false, initiator: IN_FRAME })).toBe(true);
    expect(r.opened).toEqual([]);
    expect(r.logged.join("\n")).not.toContain("collect");
  });

  it("a frame loads nothing but a page, whoever asks", () => {
    const r = rig();
    for (const url of ["https://example.com/", `${CLIENT}/index.html`, "blob:gates-local://app/1", "data:image/svg+xml,<svg/>"]) {
      expect(r.frameNavigate({ url, isMainFrame: false, initiator: TOP })).toBe(true);
    }
  });

  it("a frame holding a document the window gave it (Measure's page checks) loads", () => {
    const r = rig();
    for (const url of ["about:srcdoc", "about:blank"]) {
      expect(r.frameNavigate({ url, isMainFrame: false, initiator: TOP })).toBe(false);
    }
  });

  it("the window's own navigation is left to will-navigate", () => {
    const r = rig();
    expect(r.frameNavigate({ url: `${CLIENT}/index.html`, isMainFrame: true, initiator: null })).toBe(false);
  });

  it("WebRTC gets no route but a proxy", () => {
    expect(rig().state.webrtc).toBe("disable_non_proxied_udp");
  });

  it("a blank window opens locked down, and is guarded the same way", () => {
    const r = rig();
    expect(r.open("about:blank")).toEqual({ action: "allow", overrideBrowserWindowOptions: PAGE_WINDOW });
    expect(PAGE_WINDOW.webPreferences).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true });
    const child = fakeContents();
    r.created(child.contents);
    expect(child.state.webrtc).toBe("disable_non_proxied_udp");
    expect(child.open("about:blank")).toEqual({ action: "allow", overrideBrowserWindowOptions: PAGE_WINDOW });
    expect(child.open("https://example.com/")).toEqual({ action: "deny" });
    expect(child.frameNavigate({ url: "https://example.com/", isMainFrame: false, initiator: IN_FRAME })).toBe(true);
    expect(child.frameNavigate({ url: PAGE, isMainFrame: false, initiator: TOP })).toBe(false);
    expect(child.navigate("https://example.com/")).toBe(true);
    expect(r.opened).toEqual(["https://example.com/", "https://example.com/"]);
  });
});

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("guardNavigation", () => {
  it("a target=_blank web link opens in the system browser and no window opens", () => {
    const r = rig();
    expect(r.open("https://ollama.com/library")).toEqual({ action: "deny" });
    expect(r.opened).toEqual(["https://ollama.com/library"]);
  });

  it("a plain web link leaves the window where it is and opens in the system browser", () => {
    const r = rig();
    expect(r.navigate("https://example.com/a")).toBe(true);
    expect(r.opened).toEqual(["https://example.com/a"]);
  });

  it("navigation inside the client is left alone", () => {
    const r = rig();
    expect(r.navigate(`${CLIENT}/index.html#thread=1`)).toBe(false);
    expect(r.opened).toEqual([]);
  });

  it("other schemes are stopped and never reach the shell", () => {
    const r = rig();
    expect(r.open("file:///etc/passwd")).toEqual({ action: "deny" });
    expect(r.navigate("javascript:alert(1)")).toBe(true);
    expect(r.opened).toEqual([]);
  });
});

describe("openOutside logs", () => {
  it("never log a refused link's credentials, path or query", () => {
    const r = rig();
    openOutside("https://user:hunter2@example.com/private?token=abc123", r.deps);
    openOutside("file:///home/someone/secret-notes.txt", r.deps);
    expect(r.opened).toEqual([]);
    expect(r.logged).toHaveLength(2);
    for (const line of r.logged) {
      expect(line).not.toMatch(/hunter2|user|private|abc123|secret-notes|someone/);
    }
  });

  it("name only the origin when the browser cannot be opened", async () => {
    const r = rig({ openFails: true });
    openOutside("https://example.com/reset?token=abc123", r.deps);
    await settle();
    expect(r.logged).toHaveLength(1);
    expect(r.logged[0]).toContain("https://example.com");
    expect(r.logged[0]).not.toMatch(/abc123|reset/);
  });
});
