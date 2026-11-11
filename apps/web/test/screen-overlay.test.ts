// Part of the footer's screens: each icon is a toggle, closing puts the chat
// back as it was without loading the thread again, and each screen has one
// history entry that Back closes and a plain close takes away.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Browser, installBrowser, tick, until } from "./harness.ts";

let browser: Browser;
let session: typeof import("../src/session.ts");
let store: typeof import("../src/store.ts");
let drafts: typeof import("../src/drafts.ts");
let disconnect: (() => void) | undefined;

beforeEach(async () => {
  browser = installBrowser();
  vi.resetModules();
  session = await import("../src/session.ts");
  store = await import("../src/store.ts");
  drafts = await import("../src/drafts.ts");
  const loaders = await import("../src/screen-loaders.ts");
  vi.spyOn(loaders.usageScreen, "load").mockResolvedValue(undefined);
  vi.spyOn(loaders.settingsScreen, "get").mockReturnValue({ kind: "ready", value: {} as never });
  disconnect = session.connect();
  await until(() => store.getState().imageStatus !== undefined);
  browser.history.onPop(() => session.onScreenPop());
  store.setState({ view: "thread", threadId: "t1", messages: { t1: [] } });
  history.replaceState(null, "", "#thread=t1");
});

afterEach(async () => {
  disconnect?.();
  browser.server.accepting = false;
  for (const socket of browser.server.sockets) socket.close();
  await tick();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const view = () => {
  const s = store.getState();
  return { view: s.view, section: s.view === "settings" ? s.section : undefined, panel: s.panel };
};

describe("the footer icons are toggles", () => {
  it("Settings opens and closes", () => {
    session.toggleSettings();
    expect(view()).toMatchObject({ view: "settings", panel: null });
    session.toggleSettings();
    expect(view()).toMatchObject({ view: "thread", panel: null });
  });

  it("Models opens its section, switches from another section, and closes", () => {
    session.toggleModels();
    expect(view()).toMatchObject({ view: "settings", section: "models" });
    session.toggleModels();
    expect(view()).toMatchObject({ view: "thread" });
    session.toggleSettings();
    store.setState({ section: "general" });
    session.toggleModels();
    expect(view()).toMatchObject({ view: "settings", section: "models" });
  });

  it("Usage asked for while Settings still waits for its chunk: Settings never lands on top", async () => {
    const loaders = await import("../src/screen-loaders.ts");
    let arrive!: () => void;
    vi.spyOn(loaders.settingsScreen, "get").mockReturnValue({ kind: "pending" } as never);
    vi.spyOn(loaders.settingsScreen, "load").mockReturnValue(new Promise<never>((r) => { arrive = r as () => void; }));
    session.toggleSettings();
    session.toggleUsage();
    await tick();
    expect(view()).toMatchObject({ view: "thread", panel: "usage" });
    arrive();
    await tick();
    expect(view()).toMatchObject({ view: "thread", panel: "usage" });
  });

  for (const [picked, go, after] of [
    ["Settings", () => session.openSettings(), { view: "settings", panel: null }],
    ["another thread", () => session.openThread("t2"), { view: "thread", threadId: "t2", panel: null }],
    ["a new chat", () => session.newThread(), { view: "new", panel: null }],
  ] as const) {
    it(`${picked} picked while Usage still waits for its chunk: Usage never pops in over it`, async () => {
      const loaders = await import("../src/screen-loaders.ts");
      let arrive!: () => void;
      vi.spyOn(loaders.usageScreen, "load").mockReturnValue(new Promise<never>((r) => { arrive = r as () => void; }));
      session.toggleUsage();
      await tick();
      go();
      arrive();
      await tick();
      expect(store.getState()).toMatchObject(after);
    });
  }

  it("Usage and Settings switch straight to each other", async () => {
    session.toggleSettings();
    session.toggleUsage();
    await tick();
    expect(view()).toMatchObject({ view: "thread", panel: "usage" });
    session.toggleSettings();
    expect(view()).toMatchObject({ view: "settings", panel: null });
    session.toggleUsage();
    await tick();
    session.toggleUsage();
    expect(view()).toMatchObject({ view: "thread", panel: null });
  });
});

describe("closing returns to the chat as it was", () => {
  it("keeps the thread and its draft and asks for the thread no second time", async () => {
    drafts.editDraft("half a thought");
    const loads = browser.server.calls("threads.get").length;
    session.toggleSettings();
    session.toggleSettings();
    await tick();
    expect(store.getState()).toMatchObject({ view: "thread", threadId: "t1" });
    expect(drafts.getDraft().text).toBe("half a thought");
    expect(browser.server.calls("threads.get")).toHaveLength(loads);
  });

  it("still loads a thread that has nothing on screen", async () => {
    store.setState({ messages: {} });
    const loads = browser.server.calls("threads.get").length;
    session.toggleSettings();
    session.toggleSettings();
    await tick();
    expect(browser.server.calls("threads.get")).toHaveLength(loads + 1);
  });
});

/** A focused button, as activeElement sees it. */
const button = (inDialog = false) => ({ tagName: "BUTTON", closest: (sel: string) => (inDialog && sel === '[role="dialog"]' ? {} : null) });

// On main the composer remounted after Settings and its mount effect took the caret; the
// chat now stays mounted under Settings, so each close gives it back under the same terms.
describe("closing Settings gives the composer the caret", () => {
  let composer: { focus: ReturnType<typeof vi.fn> };
  let page: { activeElement: unknown; body: unknown };
  let touch: boolean;
  beforeEach(() => {
    composer = { focus: vi.fn() };
    page = { activeElement: null, body: { tagName: "BODY" } };
    page.activeElement = page.body;
    touch = false;
    vi.stubGlobal("document", {
      documentElement: { setAttribute: () => undefined, removeAttribute: () => undefined },
      body: page.body,
      get activeElement() { return page.activeElement; },
      querySelector: (sel: string) => (sel === "#ta" ? composer : null),
    });
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(hover: none)" && touch }));
    store.setState({ runtime: { state: "ready", owner: "external", baseUrl: "http://127.0.0.1:5288", version: "test" } });
  });

  for (const [way, close] of [
    ["the icon, Esc or Done", () => session.leaveSettings()],
    ["Back", () => session.closeSettings()],
    ["picking a thread", () => session.openThread("t2")],
    ["a new chat", () => session.newThread()],
  ] as const) {
    it(`by ${way}, with nothing else focused or the button that closed it`, () => {
      session.toggleSettings();
      page.activeElement = button();
      close();
      expect(composer.focus).not.toHaveBeenCalled();
      browser.frame();
      expect(composer.focus).toHaveBeenCalledWith({ preventScroll: true });
    });
  }

  it("not when a field has the focus, on a touch screen, while chat is blocked, or when Usage takes over", async () => {
    const tries: [string, () => void][] = [
      ["a field", () => { page.activeElement = { tagName: "INPUT", closest: () => null }; }],
      ["a dialog's button", () => { page.activeElement = button(true); }],
      ["touch", () => { touch = true; }],
      ["blocked", () => store.setState({ runtime: { state: "installing", owner: "app", baseUrl: "http://127.0.0.1:5288" } })],
    ];
    for (const [what, arrange] of tries) {
      session.toggleSettings();
      arrange();
      session.leaveSettings();
      await tick();
      browser.frame();
      expect(composer.focus, what).not.toHaveBeenCalled();
      page.activeElement = page.body; touch = false;
      store.setState({ runtime: { state: "ready", owner: "external", baseUrl: "http://127.0.0.1:5288", version: "test" } });
    }
    session.toggleSettings();
    session.toggleUsage();
    await tick();
    browser.frame();
    expect(store.getState().panel).toBe("usage");
    expect(composer.focus).not.toHaveBeenCalled();
  });
});

describe("history", () => {
  it("an icon close leaves no entry for Back to walk into", async () => {
    const start = browser.history.index();
    session.toggleSettings();
    expect(browser.history.index()).toBe(start + 1);
    session.toggleSettings();
    await tick();
    expect(browser.history.index()).toBe(start);
    session.toggleUsage();
    await tick();
    session.toggleUsage();
    await tick();
    expect(browser.history.index()).toBe(start);
  });

  it("switching between screens keeps one entry", async () => {
    const start = browser.history.index();
    session.toggleSettings();
    session.toggleUsage();
    await tick();
    session.toggleModels();
    expect(browser.history.index()).toBe(start + 1);
  });

  it("Back closes the screen and keeps the thread's hash", async () => {
    session.toggleSettings();
    expect(browser.location.hash).toBe("#thread=t1");
    history.back();
    await tick();
    expect(view()).toMatchObject({ view: "thread", panel: null });
    session.toggleUsage();
    await tick();
    history.back();
    await tick();
    expect(view()).toMatchObject({ view: "thread", panel: null });
  });

  it("opening another thread from a screen goes there, and Back returns to the first", async () => {
    session.toggleSettings();
    session.openThread("t2");
    await tick();
    expect(store.getState()).toMatchObject({ view: "thread", threadId: "t2" });
    expect(browser.location.hash).toBe("#thread=t2");
    expect(history.state).toBeNull();
    history.back();
    await tick();
    expect(browser.location.hash).toBe("#thread=t1");
  });

  for (const screen of ["Settings", "Usage"] as const) {
    it(`Search from ${screen} on a narrow window: the drawer takes the screen's entry, so Back lands on the chat`, async () => {
      vi.stubGlobal("innerWidth", 400);
      const { onDrawerPop, openSearch } = await import("../src/Sidebar.tsx");
      browser.history.onPop(onDrawerPop);
      const start = browser.history.index();
      if (screen === "Settings") session.toggleSettings();
      else session.toggleUsage();
      await tick();
      openSearch();
      await tick();
      expect(store.getState()).toMatchObject({ view: "thread", panel: null, drawer: true, searchOpen: true });
      expect(browser.history.index()).toBe(start + 1);
      history.back();
      await tick();
      expect(store.getState().drawer).toBe(false);
      expect(browser.history.index()).toBe(start);
    });
  }

  it("Search from Settings on a wide window takes the screen's entry away", async () => {
    const { openSearch } = await import("../src/Sidebar.tsx");
    const start = browser.history.index();
    session.toggleSettings();
    openSearch();
    await tick();
    expect(store.getState()).toMatchObject({ view: "thread", searchOpen: true });
    expect(browser.history.index()).toBe(start);
  });

  it("opening the same thread from a screen takes its entry away", async () => {
    const start = browser.history.index();
    session.toggleSettings();
    session.openThread("t1");
    await tick();
    expect(browser.history.index()).toBe(start);
  });
});
