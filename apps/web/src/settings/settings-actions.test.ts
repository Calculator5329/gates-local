// Settings mounted for real (react-dom on the fake DOM): where a click goes, what a field keeps
// while the server has not saved it, where the focus lands, and what a section holds while it is open.
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import type { Source } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { FakeDocument, FakeElement, FakeIFrame, type FakeNode } from "../../test/fake-dom.ts";

const calls = vi.hoisted(() => ({
  update: { fn: null as unknown as (patch: object) => Promise<string | null> },
  openSettings: [] as unknown[],
  recheck: 0,
  folders: [] as (string | null)[],
  setups: 0,
}));
vi.mock("../lib/session/index.ts", async (original) => ({
  ...await original<typeof import("../lib/session/index.ts")>(),
  updateSettings: (patch: object) => calls.update.fn(patch),
  openSettings: (...a: unknown[]) => { calls.openSettings.push(a[0]); },
  recheckRuntime: () => { calls.recheck++; return Promise.resolve(null); },
  saveImageFolder: (folder: string | null) => { calls.folders.push(folder); return Promise.resolve(null); },
  startImageSetup: () => { calls.setups++; return Promise.resolve(null); },
}));

const doc = new FakeDocument();
const win = { document: doc, HTMLIFrameElement: FakeIFrame, addEventListener() {}, removeEventListener() {} };
let root: Root;
let store: typeof import("../lib/store/store.ts");
let SettingsView: typeof import("./Settings.tsx")["SettingsView"];
const GIB = 1024 ** 3;
const settings = { defaultNumCtx: 16384, thinking: true, theme: "dark", runtimeMode: "system", tools: true, imageGen: true } as const;

beforeAll(async () => {
  doc.defaultView = win;
  Object.assign(doc, { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" });
  const { createRoot } = await import("react-dom/client");
  store = await import("../lib/store/store.ts");
  ({ SettingsView } = await import("./Settings.tsx"));
  root = createRoot(doc.body.appendChild(doc.createElement("div")) as unknown as Element);
});
afterAll(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
beforeEach(() => {
  calls.update.fn = () => Promise.resolve(null);
  calls.openSettings.length = 0;
  calls.recheck = 0;
  calls.folders.length = 0;
  calls.setups = 0;
  doc.activeElement = null;
});
afterEach(() => { act(() => root.render(null)); });

const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
function all(pred: (el: FakeElement) => boolean): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (n: FakeNode) => { for (const c of n.childNodes) if (c instanceof FakeElement) { if (pred(c)) out.push(c); walk(c); } };
  walk(doc.body);
  return out;
}
const byTestId = (id: string) => all((el) => el.getAttribute("data-testid") === id)[0] ?? null;
const props = (el: FakeElement | null): Record<string, unknown> => {
  if (el === null) throw new Error("no such element");
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  return (key === undefined ? {} : (el as unknown as Record<string, Record<string, unknown>>)[key]) ?? {};
};
const fire = async (el: FakeElement | null, handler: string, event: unknown = {}) => {
  await act(async () => { (props(el)[handler] as (e: unknown) => void)(event); });
  await settle();
};
const type = (el: FakeElement | null, value: string) => fire(el, "onChange", { target: { value } });
async function mount(section: import("../lib/store/store.ts").State["section"], over: Partial<import("../lib/store/store.ts").State> = {}) {
  store.setState({ conn: { kind: "open" }, view: "settings", section, settings, sources: [], unavailable: {}, ...over });
  act(() => root.render(createElement(SettingsView)));
  await settle();
}

it("Retry in Settings › Runtime asks for the runtime again, after a failed start and on a stalled download", async () => {
  await mount("runtime", { runtime: { state: "error", owner: "none", baseUrl: "http://127.0.0.1:11435", failure: "start", detail: "Ollama exited during startup." } });
  await fire(byTestId("settings.runtime.retry"), "onClick");
  expect(calls.recheck).toBe(1);
  await mount("runtime", { runtime: { state: "installing", owner: "app", baseUrl: "http://127.0.0.1:11435", install: { receivedBytes: 5e8, totalBytes: 1.5e9, stalled: true } } });
  await fire(byTestId("settings.runtime.retry"), "onClick");
  expect(calls.recheck).toBe(2);
});

it("a Tools row is a button to the Library, where what it needs is changed", async () => {
  await mount("tools", { shellStatus: { state: "ready" } });
  await fire(byTestId("settings.tools.open-read"), "onClick");
  await fire(byTestId("settings.tools.open-run"), "onClick");
  expect(calls.openSettings).toEqual(["library", "library"]);
});

it("the Make images reason's Image generation opens that section, where both fixes are", async () => {
  await mount("tools", { settings: { ...settings, imageGen: false } });
  await fire(byTestId("settings.tools.image-setup"), "onClick");
  expect(calls.openSettings).toEqual(["images"]);
});

it("Set up images turns Make images on first and then starts the setup; a save that fails starts nothing", async () => {
  await mount("images", { settings: { ...settings, imageGen: false }, imageSetup: methodSamples["image.setupInfo"].result, imageStatus: { state: "missing", owner: "external" } });
  const sent: object[] = [];
  calls.update.fn = (patch) => { sent.push(patch); return Promise.resolve("Couldn't save."); };
  await fire(byTestId("settings.images.set-up"), "onClick");
  expect(sent).toEqual([{ imageGen: true }]);
  expect(calls.setups).toBe(0);
  calls.update.fn = (patch) => { sent.push(patch); return Promise.resolve(null); };
  await fire(byTestId("settings.images.set-up"), "onClick");
  expect(sent).toEqual([{ imageGen: true }, { imageGen: true }]);
  expect(calls.setups).toBe(1);
});

const heldRooms = () => all((el) => el.classList.includes("held")).length;
it("the unloads line holds its room until the section closes, even when the list says the model stays", async () => {
  const card = { vendor: "nvidia" as const, totalBytes: 16 * GIB, freeBytes: 14 * GIB, occupants: [], systemMemoryAvailableBytes: 24 * GIB, measuredAt: 1 };
  await mount("images", { gpu: card, imagePresets: undefined, imageStatus: { state: "ready", owner: "external" } });
  expect(heldRooms()).toBe(1);
  await act(async () => { store.setState({ imagePresets: { ...methodSamples["image.presets"].result, unloadsChat: false } }); });
  await settle();
  expect(heldRooms()).toBe(1);
  // opened again with the list in: nothing to wait for, so no room
  act(() => root.render(null));
  await mount("images");
  expect(heldRooms()).toBe(0);
});

it("a typed ComfyUI address stays in the field until the server has saved it", async () => {
  await mount("images", { settings: { ...settings, comfyUrl: "http://10.0.0.2:8188" }, imageStatus: { state: "missing", owner: "external", addressSet: true } });
  const field = () => props(byTestId("settings.images.address"))["value"];
  const sent: object[] = [];
  calls.update.fn = (patch) => { sent.push(patch); return Promise.resolve("Couldn't save the address."); };
  await type(byTestId("settings.images.address"), " http://10.0.0.5:8188 ");
  await fire(byTestId("settings.images.address"), "onBlur");
  expect(sent).toEqual([{ comfyUrl: "http://10.0.0.5:8188" }]);
  expect(field()).toBe(" http://10.0.0.5:8188 ");
  calls.update.fn = (patch) => { sent.push(patch); return Promise.resolve(null); };
  await fire(byTestId("settings.images.address"), "onBlur");
  expect(field()).toBe("http://10.0.0.2:8188");
  await type(byTestId("settings.images.address"), "  ");
  await fire(byTestId("settings.images.address"), "onBlur");
  expect(sent.at(-1)).toEqual({ comfyUrl: null });
});

const folderField = () => byTestId("settings.images.folder");
it("a download folder typed here is saved on leaving the field, an empty one as ComfyUI's own folders, and an untouched field saves nothing", async () => {
  await mount("images", { imagePresets: methodSamples["image.presets"].result, imageStatus: { state: "ready", owner: "external" } });
  await fire(folderField(), "onBlur");
  expect(calls.folders).toEqual([]);
  await type(folderField(), " /big/models ");
  await fire(folderField(), "onBlur");
  await type(folderField(), "");
  await fire(folderField(), "onBlur");
  expect(calls.folders).toEqual(["/big/models", null]);
});

it("a source's menu puts the focus on its first item; a clone's has no Refresh, an unreadable folder's does", async () => {
  const clone: Source = { id: "c1", kind: "folder", label: "docs", path: "/data/clones/docs", addedAt: 1, state: "ready", managed: { kind: "repository", key: "https://github.com/example/docs.git" } };
  const gone: Source = { id: "f1", kind: "folder", label: "notes", path: "/home/me/notes", addedAt: 2, state: "error", detail: "The folder is gone." };
  await mount("library", { sources: [clone, gone] });
  await fire(byTestId("settings.source.more-c1"), "onClick");
  expect(byTestId("settings.source.refresh-c1")).toBeNull();
  expect(doc.activeElement?.getAttribute("data-testid")).toBe("settings.source.remove-c1");
  await fire(byTestId("settings.source.more-f1"), "onClick");
  expect(doc.activeElement?.getAttribute("data-testid")).toBe("settings.source.refresh-f1");
});

// React runs this commit's effects inside act; the attribute log is what each commit drew.
it("a finished download keeps counting in the commit that first has its fill full, and shows the check after it", async () => {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  const sample = { id: "chinook", label: "Chinook", description: "A music store", sizeBytes: 1000, url: "https://example.test/chinook.db", license: "MIT", licenseUrl: "https://example.test/LICENSE", tables: [{ name: "albums", rows: 347 }], questions: ["q1"] };
  const job = { id: "job-1", kind: "sample" as const, key: "chinook", label: "Chinook", state: "downloading" as const, bytes: 500, total: 1000 };
  await mount("library", { sourceImports: { samples: [sample], jobs: [job] } });
  const drawn: string[] = [];
  const set = FakeElement.prototype.setAttribute;
  const log = vi.spyOn(FakeElement.prototype, "setAttribute").mockImplementation(function (this: FakeElement, name: string, value: unknown) {
    if (name === "aria-label" && this.getAttribute("data-testid") === "settings.database.download-chinook") drawn.push(String(value));
    set.call(this, name, value);
  });
  now = 5000;
  const copy: Source = { id: "copy", kind: "sqlite", label: "Chinook", path: "/library/chinook.db", addedAt: 1, state: "ready", managed: { kind: "sample", key: "chinook" }, tables: [{ name: "albums", rows: 347 }] };
  await act(async () => { store.setState({ sources: [copy], sourceImports: { samples: [sample], jobs: [{ ...job, state: "ready", bytes: 1000, sourceId: "copy" }] } }); });
  log.mockRestore();
  clock.mockRestore();
  expect(drawn).toEqual(["Cancel download, 100% done", "Chinook downloaded"]);
});

it("a quick download's check stays its 900 ms after the fill's 800 ms sweep ends, not from when the file lands", async () => {
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  const sample = { id: "chinook", label: "Chinook", description: "A music store", sizeBytes: 1000, url: "https://example.test/chinook.db", license: "MIT", licenseUrl: "https://example.test/LICENSE", tables: [{ name: "albums", rows: 347 }], questions: ["q1"] };
  const job = { id: "job-1", kind: "sample" as const, key: "chinook", label: "Chinook", state: "downloading" as const, bytes: 500, total: 1000 };
  await mount("library", { sources: [], sourceImports: { samples: [sample], jobs: [job] } });
  const timers = vi.spyOn(globalThis, "setTimeout");
  now = 100;
  const copy: Source = { id: "copy", kind: "sqlite", label: "Chinook", path: "/library/chinook.db", addedAt: 1, state: "ready", managed: { kind: "sample", key: "chinook" }, tables: [{ name: "albums", rows: 347 }] };
  await act(async () => { store.setState({ sources: [copy], sourceImports: { samples: [sample], jobs: [{ ...job, state: "ready", bytes: 1000, sourceId: "copy" }] } }); });
  const delays = timers.mock.calls.map(([, ms]) => ms);
  timers.mockRestore();
  clock.mockRestore();
  expect(delays).toContain(900 + 700);
});
