// What main wires up at start, with Electron mocked: links leave for the
// system browser (links.test.ts covers the guard with an injected opener;
// this covers main's hookup to shell.openExternal), and no File/Edit/View
// menu where hidesMenu says so (owner ruling 2026-11-08).
import { afterEach, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";

const fake = vi.hoisted(() => {
  const events = new Map<string, Array<(...args: unknown[]) => void>>();
  const opened = { handler: undefined as undefined | ((details: { url: string }) => unknown) };
  const contents = {
    mainFrame: { url: "gates-local://app/index.html" },
    on: (name: string, fn: (...args: unknown[]) => void) => events.set(name, [...(events.get(name) ?? []), fn]),
    getURL: () => "gates-local://app/index.html", send: vi.fn(), paste: vi.fn(),
    setWindowOpenHandler: (handler: (details: { url: string }) => unknown) => { opened.handler = handler; },
  };
  return { events, opened, contents, openExternal: vi.fn(async (_url: string) => undefined), setApplicationMenu: vi.fn() };
});
vi.mock("electron", () => ({
  app: { setName: vi.fn(), setPath: vi.fn(), getPath: () => ".", requestSingleInstanceLock: () => true, on: vi.fn(), whenReady: () => Promise.resolve(), isPackaged: false, quit: vi.fn() },
  BrowserWindow: class {
    webContents = fake.contents;
    on = vi.fn(); isDestroyed = () => false; isFocused = () => true; loadURL = vi.fn(async () => undefined);
  },
  clipboard: { read: vi.fn() },
  ipcMain: { handle: vi.fn() },
  Menu: { setApplicationMenu: fake.setApplicationMenu }, net: {}, protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  session: { defaultSession: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() } },
  shell: { openExternal: fake.openExternal, openPath: vi.fn() },
}));
vi.mock("./running.ts", () => ({ writeRunning: vi.fn(), clearRunning: vi.fn() }));
vi.mock("./supervisor.ts", () => ({ Supervisor: class { state = { status: "idle" }; subscribe = vi.fn(); start = vi.fn(); killNow = vi.fn(); } }));

const platform = process.platform;
afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform });
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules();
  fake.events.clear(); fake.opened.handler = undefined; fake.openExternal.mockClear(); fake.setApplicationMenu.mockClear();
});

async function start(as: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: as });
  vi.stubGlobal("__dirname", tmpdir());
  vi.spyOn(process, "on").mockReturnValue(process);
  await import("./main.ts");
  await vi.waitFor(() => expect(fake.opened.handler).toBeDefined());
}

it("a link the page opens or navigates to goes to the system browser", async () => {
  await start("linux");
  expect(fake.opened.handler!({ url: "https://ollama.com/library" })).toEqual({ action: "deny" });
  await vi.waitFor(() => expect(fake.openExternal).toHaveBeenCalledWith("https://ollama.com/library"));
  const preventDefault = vi.fn();
  for (const fn of fake.events.get("will-navigate") ?? []) fn({ preventDefault }, "https://example.com/reply-link");
  expect(preventDefault).toHaveBeenCalled();
  await vi.waitFor(() => expect(fake.openExternal).toHaveBeenCalledWith("https://example.com/reply-link"));
  expect(fake.openExternal).toHaveBeenCalledTimes(2);
});

it.each([["linux", true], ["win32", true], ["darwin", false]] as const)("on %s the File/Edit/View menu is removed: %s", async (as, removed) => {
  await start(as);
  expect(fake.setApplicationMenu.mock.calls).toEqual(removed ? [[null]] : []);
});
