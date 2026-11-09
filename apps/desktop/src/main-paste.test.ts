import { afterEach, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";

const fake = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const events = new Map<string, Array<(...args: unknown[]) => void>>();
  const frame = { url: "gates-local://app/index.html" };
  class Textarea {
    id = "ta"; disabled = false; readOnly = false; isConnected = true;
    dataset = { draftVersion: "1" }; selectionStart = 0; selectionEnd = 0;
    dispatchEvent = vi.fn(() => true);
  }
  const original = new Textarea();
  const document = { activeElement: original as Textarea | null };
  const world = { document, HTMLTextAreaElement: Textarea, location: { href: frame.url }, CustomEvent: class {
    type: string; init: unknown;
    constructor(type: string, init: unknown) { this.type = type; this.init = init; }
  } };
  const contents = {
    mainFrame: frame, on: (name: string, fn: (...args: unknown[]) => void) => events.set(name, [...(events.get(name) ?? []), fn]),
    getURL: () => frame.url, send: vi.fn(), paste: vi.fn(),
    executeJavaScriptInIsolatedWorld: vi.fn(async (_id: number, scripts: Array<{ code: string }>) => (await import("node:vm")).runInNewContext(scripts[0]!.code, world)),
    setWindowOpenHandler: vi.fn(),
  };
  return { handlers, events, frame, contents, document, world, original, Textarea, read: vi.fn(async () => [{ types: ["text/uri-list"], getType: async () => new Blob(["file:///srv/docs/private.pdf"]) }]) };
});
vi.mock("electron", () => ({
  app: { setName: vi.fn(), setPath: vi.fn(), getPath: () => ".", requestSingleInstanceLock: () => true, on: vi.fn(), whenReady: () => Promise.resolve(), isPackaged: false },
  BrowserWindow: class {
    webContents = fake.contents;
    on = vi.fn(); isDestroyed = () => false; isFocused = () => true;
  },
  clipboard: { read: fake.read },
  ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => fake.handlers.set(name, fn) },
  Menu: { setApplicationMenu: vi.fn() }, net: {}, protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  session: { defaultSession: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() } }, shell: {},
}));
vi.mock("./running.ts", () => ({ writeRunning: vi.fn(), clearRunning: vi.fn() }));
vi.mock("./supervisor.ts", () => ({ Supervisor: class { state = { status: "idle" }; subscribe = vi.fn(); start = vi.fn(); killNow = vi.fn(); } }));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("a capturing page keydown caller cannot steal the paths of a main-observed paste", async () => {
  vi.stubGlobal("__dirname", tmpdir());
  vi.spyOn(process, "on").mockReturnValue(process);
  await import("./main.ts");
  await Promise.resolve();
  expect(fake.handlers.get("gates-local:clipboard-file-paths")).toBeUndefined();
  expect(fake.read).not.toHaveBeenCalled(); // A timer with no main gesture has no operation to call.
  const input = { type: "keyDown", key: "v", control: true, meta: false, alt: false };
  for (const fn of fake.events.get("before-input-event") ?? []) fn({ preventDefault: vi.fn() }, input);
  // The page's capturing listener runs before its textarea's paste handler.
  const request = fake.handlers.get("gates-local:clipboard-file-paths");
  const stolen = request ? await request({ sender: fake.contents, senderFrame: fake.frame }) : { paths: [] };
  expect(stolen).toMatchObject({ paths: [] });
  await vi.waitFor(() => expect(fake.original.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "gates-local:native-paste", init: expect.objectContaining({ detail: expect.objectContaining({ paths: ["/srv/docs/private.pdf"], skipped: false, version: 1 }) }) })));
  expect(fake.read).toHaveBeenCalledTimes(1);
  fake.document.activeElement = null;
  for (const fn of fake.events.get("before-input-event") ?? []) fn({ preventDefault: vi.fn() }, input);
  await vi.waitFor(() => expect(fake.contents.paste).toHaveBeenCalledTimes(1));
  expect(fake.read).toHaveBeenCalledTimes(1); // Paste in a different field does not read paths.
  // PC-05: both textareas have identical attributes. Only object identity differs.
  fake.document.activeElement = fake.original;
  const paused: { finish?: (items: Awaited<ReturnType<typeof fake.read>>) => void } = {};
  fake.read.mockImplementationOnce(() => new Promise(resolve => { paused.finish = resolve; }));
  for (const fn of fake.events.get("before-input-event") ?? []) fn({ preventDefault: vi.fn() }, input);
  await vi.waitFor(() => expect(fake.read).toHaveBeenCalledTimes(2));
  fake.original.isConnected = false;
  fake.document.activeElement = new fake.Textarea();
  paused.finish?.([{ types: ["text/uri-list"], getType: async () => new Blob(["file:///srv/docs/private.pdf"]) }]);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(fake.contents.send.mock.calls.filter(([channel]) => channel === "gates-local:clipboard-paste")).toHaveLength(0);
  expect(fake.document.activeElement.dispatchEvent).not.toHaveBeenCalled();
  // Same DOM element, another chat/draft: its version or route changed.
  for (const changed of ["version", "route"]) {
    fake.original.isConnected = true;
    fake.document.activeElement = fake.original;
    fake.read.mockImplementationOnce(() => new Promise(resolve => { paused.finish = resolve; }));
    const reads = fake.read.mock.calls.length;
    for (const fn of fake.events.get("before-input-event") ?? []) fn({ preventDefault: vi.fn() }, input);
    await vi.waitFor(() => expect(fake.read).toHaveBeenCalledTimes(reads + 1));
    if (changed === "version") fake.original.dataset.draftVersion = "2";
    else fake.world.location.href += "#thread=B";
    paused.finish?.([{ types: ["text/uri-list"], getType: async () => new Blob(["file:///srv/docs/private.pdf"]) }]);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(fake.original.dispatchEvent).toHaveBeenCalledTimes(1);
  }
});
