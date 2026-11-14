// A runtime "error" carries what failed. A download that stopped is not a start that failed:
// the banner, the gear, the first window and Settings › Runtime each say the download didn't
// finish, with Retry; only a failed start says Ollama didn't start.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { State } from "../src/store.ts";

vi.mock("../src/store.ts", async (original) => {
  const actual = await original<typeof import("../src/store.ts")>();
  return { ...actual, useStore: <T>(selector: (s: State) => T) => selector(actual.getState()) };
});
const { getState, setState } = await import("../src/store.ts");
const initial = getState();

const base = { state: "error", owner: "none", baseUrl: "http://127.0.0.1:5288" } as const;
const stopped = { ...base, failure: "download", detail: "The Ollama download stopped at 40.0 MiB of 80.0 MiB (no data for 30 s). Check the network and retry; nothing was installed." } as const;
const exited = { ...base, failure: "start", detail: "Ollama exited during startup." } as const;

beforeEach(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});
afterEach(() => { setState(initial); vi.unstubAllGlobals(); });

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

async function places(runtime: State["runtime"]): Promise<Record<string, string>> {
  const { Banner, rtInfo } = await import("../src/Banner.tsx");
  const { FirstRun } = await import("../src/FirstRun.tsx");
  const { SettingsView } = await import("../src/Settings.tsx");
  const at = (view: State["view"], extra: Partial<State> = {}) => setState({ ...initial, conn: { kind: "open" }, runtime, models: [], view, ...extra });
  at("new");
  const banner = renderToStaticMarkup(createElement(Banner));
  const gear = rtInfo({ conn: { kind: "open" }, runtime });
  at("firstrun");
  const first = renderToStaticMarkup(createElement(FirstRun));
  at("settings", { section: "runtime" });
  const settings = renderToStaticMarkup(createElement(SettingsView));
  return { banner: text(banner), gear: text(renderToStaticMarkup(createElement("div", null, gear.text))), first: text(first), settings: text(settings) };
}

it("a download that stopped says so everywhere, with Retry, and never that Ollama didn't start", async () => {
  const p = await places(stopped);
  for (const [where, words] of Object.entries(p)) {
    expect(words, where).toMatch(/download didn't finish/i);
    expect(words, where).not.toMatch(/didn't start/i);
  }
  for (const where of ["banner", "first", "settings"]) expect(p[where], where).toContain("Retry");
  // the download is named once: the detail under the title starts at "Stopped at"
  for (const where of ["banner", "first", "settings"]) {
    expect(p[where], where).toContain("Stopped at 40.0 MiB of 80.0 MiB");
    expect(p[where]?.match(/Ollama download/g)?.length ?? 0, where).toBeLessThanOrEqual(1);
  }
});

it("a start that failed still says Ollama didn't start", async () => {
  const p = await places(exited);
  for (const [where, words] of Object.entries(p)) {
    expect(words, where).toMatch(/didn't start/i);
    expect(words, where).not.toMatch(/download/i);
  }
});
