// Set up images installs the app's own engine first, then fetches the model (about 9 GB). After
// the engine step the server reports the engine as the app's own and stopped, so "no engine
// anywhere" no longer holds. The setup's view must follow the setup instead: it stays while a
// step runs and after it stops, and goes only when it ends well (or an address of one's own is set).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ImageSetupProgress, ImageStatus } from "@gates-local/contracts";
import type { State } from "../src/store.ts";

vi.mock("../src/store.ts", async (original) => {
  const actual = await original<typeof import("../src/store.ts")>();
  return { ...actual, useStore: <T>(selector: (s: State) => T) => selector(actual.getState()) };
});
vi.mock("../src/session.ts", async (original) => ({ ...(await original<typeof import("../src/session.ts")>()), loadImageSetup: async () => null }));
const { getState, setState } = await import("../src/store.ts");
const { imagesUnset, noImageEngine } = await import("../src/image-choice.ts");
const initial = getState();

const nowhere: ImageStatus = { state: "off", owner: "none", nowhere: true };
const ownStopped: ImageStatus = { state: "stopped", owner: "none", own: true, baseUrl: "http://127.0.0.1:8190" };
const elsewhere: ImageStatus = { state: "ready", owner: "external", addressSet: true, baseUrl: "http://10.0.0.2:8188" };
const GB = 1024 ** 3;
const at = (step: ImageSetupProgress["step"], message?: string): ImageSetupProgress => ({ step, completedBytes: 3 * GB, totalBytes: 12 * GB, ...(message === undefined ? {} : { message }) });
const setup = (progress?: ImageSetupProgress) => ({
  engine: { version: "1", bytes: 3 * GB, installed: true },
  model: { preset: "flux", name: "FLUX.1 schnell", bytes: 9 * GB },
  freeBytes: 100 * GB, needBytes: 9 * GB,
  ...(progress === undefined ? {} : { progress }),
});

beforeEach(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});
afterEach(() => { setState(initial); vi.unstubAllGlobals(); });

async function images(imageStatus: ImageStatus, progress?: ImageSetupProgress): Promise<string> {
  const { SettingsView } = await import("../src/Settings.tsx");
  setState({ ...initial, conn: { kind: "open" }, runtime: { state: "ready", owner: "app", baseUrl: "http://127.0.0.1:5288" }, settings: { ...initial.settings === undefined || initial.settings === "na" ? {} : initial.settings, imageGen: true } as State["settings"], imageStatus, imageSetup: setup(progress), view: "settings", section: "images" });
  return renderToStaticMarkup(createElement(SettingsView));
}

it("the setup row stays through the model step, on the engine the setup just installed", async () => {
  const html = await images(ownStopped, at("model"));
  expect(html).toContain('data-testid="settings.images.set-up"');
  expect(html).toContain("Setting up…");
  expect(html).not.toContain('data-testid="settings.images.enable"');
  expect(noImageEngine(getState())).toBe(true);
  // the composer keeps its set-up sheet too: no Image mode on a model still downloading
  expect(imagesUnset(getState())).toBe(true);
});

it("a setup that stopped partway keeps its row, with its words and Try again", async () => {
  const html = await images(ownStopped, at("error", "The model download stopped."));
  expect(html).toContain("Setup stopped");
  expect(html).toContain("The model download stopped.");
  expect(html).toContain("Try again");
});

it("a setup that ended well, or none at all, leaves the engine's own view", async () => {
  for (const progress of [at("done"), undefined]) {
    const html = await images(ownStopped, progress);
    expect(html, progress?.step ?? "none").toContain('data-testid="settings.images.enable"');
    expect(html).not.toContain('data-testid="settings.images.set-up"');
    expect(imagesUnset(getState())).toBe(false);
  }
});

it("an address of one's own set since a stopped setup is the view, not the old error", async () => {
  const html = await images(elsewhere, at("error", "The model download stopped."));
  expect(html).not.toContain("Setup stopped");
  expect(html).toContain('data-testid="settings.images.enable"');
});

it("with no engine anywhere the setup row shows as before", async () => {
  expect(await images(nowhere)).toContain('data-testid="settings.images.set-up"');
});
