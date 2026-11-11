import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Browser, installBrowser, tick, until } from "./harness.ts";

let browser: Browser;
let session: typeof import("../src/session.ts");
let store: typeof import("../src/store.ts");
let screen: typeof import("../src/screens.tsx");
let disconnect: (() => void) | undefined;

beforeEach(async () => {
  browser = installBrowser();
  vi.resetModules();
  session = await import("../src/session.ts");
  store = await import("../src/store.ts");
  screen = await import("../src/screens.tsx");
  disconnect = session.connect();
  await until(() => store.getState().imageStatus !== undefined);
  store.setState({ view: "thread", threadId: "t1", messages: { t1: [] } });
});

afterEach(async () => {
  disconnect?.();
  browser.server.accepting = false;
  for (const socket of browser.server.sockets) socket.close();
  await tick();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function holdSettings() {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  vi.spyOn(screen.settingsScreen, "load").mockReturnValue(pending);
  return release;
}

describe("pending navigation exits", () => {
  for (const section of ["general", "models"] as const) {
    for (const exit of ["Escape", "current thread", "another thread", "new thread", "Search", "thread drawer", "drawer Back", "Memory details", "another section"] as const) {
      it(`${exit} supersedes a pending ${section} navigation`, async () => {
        const release = holdSettings();
        try {
          if (exit === "drawer Back") store.setState({ drawer: true });
          session.openSettings(section);
          if (exit === "Escape") {
            const { onKey } = await import("../src/App.tsx");
            // Node's Event supplies the real cancellation API; the handler only
            // reads key for this plain Escape, without modifiers or a target.
            const event = Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" });
            onKey(event as KeyboardEvent);
          } else if (exit === "current thread") session.openThread("t1");
          else if (exit === "another thread") session.openThread("t2");
          else if (exit === "new thread") session.newThread();
          else if (exit === "Search") (await import("../src/Sidebar.tsx")).openSearch();
          else if (exit === "thread drawer") {
            Object.assign(history, { pushState: vi.fn() });
            (await import("../src/Sidebar.tsx")).openDrawer();
          }
          else if (exit === "drawer Back") (await import("../src/Sidebar.tsx")).onDrawerPop();
          else if (exit === "Memory details") (await import("../src/fit-actions.ts")).openFit();
          else session.openSettings("runtime");
          release();
          await tick();
          if (exit === "Memory details") expect(store.getState()).toMatchObject({ view: "settings", section: "advanced" });
          else if (exit === "another section") expect(store.getState()).toMatchObject({ view: "settings", section: "runtime" });
          else if (exit === "new thread") expect(store.getState()).toMatchObject({ view: "new", threadId: null });
          else {
            expect(store.getState()).toMatchObject({ view: "thread", threadId: exit === "another thread" ? "t2" : "t1" });
            // Search leaves Settings (above) and focuses the always-there field, which the browser specs drive
            if (exit === "thread drawer") expect(store.getState().drawer).toBe(true);
            if (exit === "drawer Back") expect(store.getState().drawer).toBe(false);
          }
        } finally {
          release();
          await tick();
        }
      });
    }
  }

  it("accepts a fresh Settings request after cancelling the first one", async () => {
    const release = holdSettings();
    session.openSettings("general");
    const { onKey } = await import("../src/App.tsx");
    onKey(Object.assign(new Event("keydown"), { key: "Escape" }) as KeyboardEvent);
    session.openSettings("models", true);
    release();
    await tick();
    expect(store.getState()).toMatchObject({ view: "settings", section: "models", addPage: true, threadId: "t1" });
  });

  it("an older import settling cannot make the newer pending request immune to Escape", async () => {
    let first!: () => void;
    let second!: () => void;
    vi.spyOn(screen.settingsScreen, "load")
      .mockReturnValueOnce(new Promise<void>((resolve) => { first = resolve; }))
      .mockReturnValueOnce(new Promise<void>((resolve) => { second = resolve; }));
    session.openSettings("general");
    session.openSettings("models");
    first();
    await tick();
    const { onKey } = await import("../src/App.tsx");
    onKey(Object.assign(new Event("keydown"), { key: "Escape" }) as KeyboardEvent);
    second();
    await tick();
    expect(store.getState()).toMatchObject({ view: "thread", threadId: "t1" });
  });

  it("Escape still leaves Settings after the screen has settled", async () => {
    vi.spyOn(screen.settingsScreen, "get").mockReturnValue({ kind: "error" });
    session.openSettings("models");
    const { onKey } = await import("../src/App.tsx");
    onKey(Object.assign(new Event("keydown"), { key: "Escape" }) as KeyboardEvent);
    expect(store.getState()).toMatchObject({ view: "thread", threadId: "t1" });
  });
});

describe("BG-01: pending navigation agrees with the displayed thread", () => {
  for (const section of ["general", "models"] as const) {
    it(`keeps view and sends in the existing thread while ${section} is loading`, async () => {
      const release = holdSettings();
      try {
        session.openSettings(section);
        const whileLoading = store.getState();
        await session.send("Keep this conversation's context");
        expect(browser.server.calls("threads.create")).toHaveLength(0);
        expect(browser.server.calls("chat.send").at(-1)?.params).toMatchObject({ threadId: "t1" });
        expect(whileLoading).toMatchObject({ view: "thread", threadId: "t1" });
        release();
        await tick();
        expect(store.getState()).toMatchObject({ view: "settings", section, threadId: "t1" });
      } finally {
        release();
        await tick();
      }
    });
  }

  it("does not open a stale Settings request after choosing another thread", async () => {
    const release = holdSettings();
    session.openSettings("models");
    session.newThread();
    release();
    await tick();
    expect(store.getState()).toMatchObject({ view: "new", threadId: null });
  });
});

it("BG-02: No Server is known before the first React render", async () => {
  disconnect?.();
  browser.location.search = "";
  vi.stubGlobal("document", {
    querySelector: () => null,
    documentElement: { setAttribute() {}, removeAttribute() {} },
  });
  vi.resetModules();
  const freshSession = await import("../src/session.ts");
  const freshStore = await import("../src/store.ts");
  const stop = freshSession.connect();
  try {
    expect(freshStore.getState().conn.kind).toBe("no-server");
  } finally {
    stop();
  }
});
