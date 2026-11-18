import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RuntimeStatus } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import type { State } from "../lib/store/store.ts";

vi.mock("../lib/store/store.ts", async (original) => {
  const actual = await original<typeof import("../lib/store/store.ts")>();
  return { ...actual, useStore: <T>(selector: (s: State) => T) => selector(actual.getState()) };
});
const { getState, setState } = await import("../lib/store/store.ts");
const initial = getState();

const missing: RuntimeStatus = { state: "missing", owner: "none", baseUrl: "http://127.0.0.1:11434", detail: "No Ollama is installed, and Gates Local has no copy for this computer." };

beforeEach(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});
afterEach(() => { setState(initial); vi.unstubAllGlobals(); });

async function runtimePage(runtime: RuntimeStatus, more: Partial<State> = {}): Promise<string> {
  const { SettingsView } = await import("./Settings.tsx");
  setState({ ...initial, conn: { kind: "open" }, runtime, settings: { ...methodSamples["settings.get"].result, runtimeMode: "system" }, view: "settings", section: "runtime", ...more });
  return renderToStaticMarkup(createElement(SettingsView));
}

// council climb-025 Q16: the switch's confirm said "It runs on port 11435", a number no step needs
it("the confirm for switching to the app's own Ollama says what changes, with no port", async () => {
  const html = await runtimePage({ state: "stopped", owner: "none", baseUrl: "http://127.0.0.1:11434" }, { ownerConfirm: true });
  expect(html).toContain("Use Gates Local&#x27;s own Ollama?");
  expect(html).toContain("The system Ollama keeps running for other apps.");
  // the status line above names the system port (11434); the confirm names none
  expect(html).not.toMatch(/runs on port|port 11435/);
});

it("where the app has no Ollama of its own to install, Settings offers none: no switch to it and no promise to install it", async () => {
  const offered = await runtimePage(missing);
  expect(offered, "the offer the test looks for, where there is a copy").toContain('data-testid="settings.runtime.switch"');
  expect(offered).toContain("Gates Local can install its own.");
  const html = await runtimePage({ ...missing, noAppCopy: true });
  expect(html).not.toContain('data-testid="settings.runtime.switch"');
  expect(html).not.toContain("can install its own");
  expect(html).toContain("Not available on this computer.");
});
