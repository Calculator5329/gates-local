// Settings opens on what the window already holds: the server's settings and runtime status, kept
// current by their numbered pushes, and the data folder read once per window. Opening it, moving
// between sections and opening it again asks the desktop bridge for no folder, and the folders
// shown are those values.
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { FakeDocument, FakeElement, FakeIFrame } from "../../test/fake-dom.ts";

const doc = new FakeDocument();
const bridge = {
  dataFolder: vi.fn(async () => "/data/gates"),
  modelsFolder: vi.fn(async () => "/bridge/models"),
  openDataFolder: vi.fn(async () => null),
  openModelsFolder: vi.fn(async () => null),
};
let root: Root;
let store: typeof import("../lib/store/store.ts");
const matchMedia = (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });

beforeAll(async () => {
  const win = { document: doc, HTMLIFrameElement: FakeIFrame, gatesLocal: bridge, matchMedia, addEventListener() {}, removeEventListener() {} };
  doc.defaultView = win;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("matchMedia", matchMedia);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("HTMLElement", FakeElement);
  // react-dom decides at import whether it has a DOM, so it loads after the stubs
  const { createRoot } = await import("react-dom/client");
  store = await import("../lib/store/store.ts");
  root = createRoot(doc.body.appendChild(doc.createElement("div")) as unknown as Element);
});
afterAll(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });

const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); };

it("opening Settings, moving between sections and opening it again reads no folder from the desktop bridge", async () => {
  const { SettingsView } = await import("./Settings.tsx");
  store.setState({
    conn: { kind: "open" },
    runtime: { state: "ready", owner: "app", baseUrl: "http://127.0.0.1:5288", modelsDir: "/data/gates/ollama/models" },
    models: [],
    view: "settings",
    // the session's one read of the data folder, before Settings first opened
    dataFolder: "/data/gates",
  });
  for (const open of [1, 2]) {
    for (const section of ["runtime", "advanced"] as const) {
      store.setState({ section });
      act(() => root.render(createElement(SettingsView)));
      await settle();
      const text = doc.body.textContent;
      if (section === "runtime") expect(text, `the models folder the server reports, open ${open}`).toContain("/data/gates/ollama/models");
      else expect(text, `the data folder, open ${open}`).toContain("/data/gates");
    }
    act(() => root.render(null));
  }
  expect(bridge.modelsFolder, "the models folder comes with the server's runtime status").not.toHaveBeenCalled();
  expect(bridge.dataFolder, "the data folder was read before Settings opened").not.toHaveBeenCalled();
});

it("a data folder read that lands after Settings opened shows without reopening it", async () => {
  const { SettingsView } = await import("./Settings.tsx");
  store.setState({ conn: { kind: "open" }, view: "settings", section: "advanced", dataFolder: undefined });
  act(() => root.render(createElement(SettingsView)));
  await settle();
  expect(doc.body.textContent).not.toContain("/data/late");
  act(() => store.setState({ dataFolder: "/data/late" }));
  expect(doc.body.textContent).toContain("/data/late");
  act(() => root.render(null));
});
