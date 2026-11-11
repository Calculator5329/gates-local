// Owner ruling 2026-11-08: the Ollama version is shown nowhere a person looks.
// The footer is held by a browser spec; this holds every Settings section and
// every first-run screen, rendered with a runtime that reports its version.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Section, State } from "../src/store.ts";

vi.mock("../src/store.ts", async (original) => {
  const actual = await original<typeof import("../src/store.ts")>();
  return { ...actual, useStore: <T>(selector: (s: State) => T) => selector(actual.getState()) };
});
const { getState, setState } = await import("../src/store.ts");
const initial = getState();

const VERSION = "0.40.4";
const model = { name: "qwen3.5:9b", digest: "q", sizeBytes: 1, modifiedAt: "", capabilities: ["completion"] };
const runtimes = [
  { state: "ready", owner: "app", baseUrl: "http://127.0.0.1:5288", version: VERSION },
  { state: "ready", owner: "external", baseUrl: "http://127.0.0.1:11434", version: VERSION },
  { state: "stopped", owner: "app", baseUrl: "http://127.0.0.1:5288", version: VERSION },
  { state: "error", owner: "app", baseUrl: "http://127.0.0.1:5288", version: VERSION, detail: "It exited." },
] as const;
const sections: readonly Section[] = ["general", "models", "instructions", "library", "tools", "images", "runtime", "advanced", "shortcuts"];

beforeEach(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});
afterEach(() => { setState(initial); vi.unstubAllGlobals(); });

it("no Settings section shows the Ollama version", async () => {
  const { SettingsView } = await import("../src/Settings.tsx");
  let rendered = 0;
  for (const runtime of runtimes) {
    for (const section of sections) {
      setState({ ...initial, conn: { kind: "open" }, runtime, models: [model], model: model.name, view: "settings", section });
      const html = renderToStaticMarkup(createElement(SettingsView));
      expect(html, `${section} with ${runtime.owner} ${runtime.state}`).not.toContain(VERSION);
      if (section === "runtime") expect(html).toContain("Ollama");
      rendered++;
    }
  }
  expect(rendered).toBe(runtimes.length * sections.length);
});

it("no first-run screen shows the Ollama version", async () => {
  const { FirstRun } = await import("../src/FirstRun.tsx");
  for (const runtime of runtimes) {
    for (const models of [[], [model]]) {
      setState({ ...initial, conn: { kind: "open" }, runtime, models, view: "firstrun" });
      const html = renderToStaticMarkup(createElement(FirstRun));
      expect(html, `${runtime.owner} ${runtime.state} with ${models.length} models`).not.toContain(VERSION);
      expect(html).not.toBe("");
    }
  }
});
