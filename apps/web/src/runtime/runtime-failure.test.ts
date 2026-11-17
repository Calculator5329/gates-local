// A runtime "error" carries what failed. A download that stopped is not a start that failed:
// the banner, the gear, the first window and Settings › Runtime each say the download didn't
// finish, with Retry; only a failed start says Ollama didn't start.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { State } from "../lib/store/store.ts";

vi.mock("../lib/store/store.ts", async (original) => {
  const actual = await original<typeof import("../lib/store/store.ts")>();
  return { ...actual, useStore: <T>(selector: (s: State) => T) => selector(actual.getState()) };
});
const { getState, setState } = await import("../lib/store/store.ts");
const initial = getState();

const base = { state: "error", owner: "none", baseUrl: "http://127.0.0.1:5288" } as const;
const stopped = { ...base, failure: "download", detail: "The Ollama download stopped at 0.6 of 1.5 GB (no data for 30 s). Check the network and retry; nothing was installed." } as const;
const exited = { ...base, failure: "start", detail: "Ollama exited during startup." } as const;

beforeEach(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});
afterEach(() => { setState(initial); vi.unstubAllGlobals(); });

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

async function places(runtime: State["runtime"], words: (html: string) => string = text): Promise<Record<string, string>> {
  const { Banner } = await import("./Banner.tsx");
  const { rtInfo } = await import("./words.tsx");
  const { FirstRun } = await import("../first-run/FirstRun.tsx");
  const { SettingsView } = await import("../settings/Settings.tsx");
  const at = (view: State["view"], extra: Partial<State> = {}) => setState({ ...initial, conn: { kind: "open" }, runtime, models: [], view, ...extra });
  at("new");
  const banner = renderToStaticMarkup(createElement(Banner));
  const gear = rtInfo({ conn: { kind: "open" }, runtime });
  at("firstrun");
  const first = renderToStaticMarkup(createElement(FirstRun));
  at("settings", { section: "runtime" });
  const settings = renderToStaticMarkup(createElement(SettingsView));
  return { banner: words(banner), gear: words(renderToStaticMarkup(createElement("div", null, gear.text))), first: words(first), settings: words(settings) };
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
    // the figures the running download counted in (text() folds the no-break space)
    expect(p[where], where).toContain("Stopped at 0.6 of 1.5 GB");
    expect(p[where]?.match(/Ollama download/g)?.length ?? 0, where).toBeLessThanOrEqual(1);
  }
});

// Council climb-025 Q16: a failed download put "HTTP 503" and the whole address in the main line.
it.each([
  ["answered with an error", "Downloading Ollama failed: HTTP 503 from https://github.com/ollama/ollama/releases/download/v0.12.0/ollama-linux-amd64.tgz. Check the network and retry; nothing was installed."],
  ["never answered", "Could not reach https://github.com/ollama/ollama/releases/download/v0.12.0/ollama-linux-amd64.tgz (fetch failed). Check the network and retry; nothing was installed."],
])("a download site that %s gets one plain line; the status and the address are in the details", async (_, detail) => {
  const unreached = { ...base, failure: "download", detail } as const;
  const p = await places(unreached);
  for (const where of ["banner", "first", "settings"]) {
    expect(p[where], where).toContain("The download site didn't respond. Try again in a moment.");
    expect(p[where], where).not.toMatch(/HTTP|https?:|github/);
    expect(p[where], where).toContain("Retry");
  }
  const html = await places(unreached, (h) => h);
  for (const where of ["banner", "first", "settings"]) expect(html[where], where).toContain(`data-why="${detail}"`);
});

// Council climb-025 Q16: a release file that is gone (404) read as a site that "didn't respond".
it.each([404, 410])("a download the site no longer has (HTTP %i) says so and what to do next; the status is in the details", async (status) => {
  const detail = `Downloading Ollama failed: HTTP ${status} from https://github.com/ollama/ollama/releases/download/v0.12.0/ollama-linux-amd64.tgz. Check the network and retry; nothing was installed.`;
  const gone = { ...base, failure: "download", detail } as const;
  const p = await places(gone);
  for (const where of ["banner", "first", "settings"]) {
    expect(p[where], where).toContain("This download is no longer available. Retry after the app updates, or install Ollama from ollama.com.");
    expect(p[where], where).not.toMatch(/didn't respond|HTTP|github/);
  }
  const html = await places(gone, (h) => h);
  for (const where of ["banner", "first", "settings"]) expect(html[where], where).toContain(`data-why="${detail}"`);
});

// Council climb-025 Q16 (S-12): the wrong-runtime banner led with "port 5288" and "localhost:5288".
it("a program other than Ollama in its place gets plain words on the banner; the address is in the details", async () => {
  const wrong = { state: "wrong-service", owner: "external", baseUrl: "http://127.0.0.1:5288" } as const;
  const p = await places(wrong);
  expect(p["banner"]).toContain("Another program is where Ollama should be");
  expect(p["banner"]).not.toMatch(/port|localhost|5288/i);
  expect(p["banner"]).toContain("Retry");
  const html = await places(wrong, (h) => h);
  expect(html["banner"]).toContain('data-why="Another program answers on localhost:5288."');
});

it("a download that didn't match its checksum says it couldn't be verified and to download it again; the checksum is in the details", async () => {
  const detail = `The Ollama download did not match its pinned checksum (expected sha256 ${"a".repeat(64)}, got ${"b".repeat(64)}). Nothing was installed. Retry once; if it fails again the release file changed and the pinned manifest needs updating.`;
  const mismatch = { ...base, failure: "checksum", detail } as const;
  const p = await places(mismatch);
  expect(p["gear"]).toContain("The download couldn't be verified");
  expect(p["settings"]).toContain("Couldn't verify download");
  for (const where of ["banner", "first"]) expect(p[where], where).toContain("The download couldn't be verified");
  for (const where of ["banner", "first", "settings"]) expect(p[where], where).toContain("Download it again.");
  for (const [where, words] of Object.entries(p)) {
    expect(words, where).not.toMatch(/network|didn't start|didn't finish|didn't install|checksum|sha256/i);
  }
  for (const where of ["banner", "first", "settings"]) expect(p[where], where).toContain("Retry");
  const html = await places(mismatch, (h) => h);
  for (const where of ["banner", "first", "settings"]) expect(html[where], where).toContain(`data-why="${detail}"`);
});

it("a disk too small for Ollama says the disk everywhere, with the needed figure once, and never an unpack or the network", async () => {
  for (const detail of ["Needs 2.4 GB free; 0.5 GB is free on this drive.", "The disk is full. Needs 2.4 GB free; 0.5 GB is free on this drive."]) {
    const p = await places({ ...base, failure: "disk", detail });
    for (const where of ["banner", "first", "gear"]) expect(p[where], where).toContain("Not enough disk space for Ollama");
    expect(p["settings"]).toContain("Not enough disk space");
    for (const [where, words] of Object.entries(p)) {
      expect(words, where).not.toMatch(/network|unpack|didn't start|didn't install|didn't finish/i);
      expect(words.match(/disk/gi)?.length ?? 0, where).toBe(1);
    }
    for (const where of ["banner", "first", "settings"]) {
      expect(p[where]?.match(/Needs 2\.4 GB free/g)?.length ?? 0, where).toBe(1);
      expect(p[where], where).toContain("Retry");
    }
  }
});

it("the server's first status, before any look, reads as a search everywhere and never as a stopped Ollama", async () => {
  const p = await places({ state: "starting", owner: "none", baseUrl: "http://127.0.0.1:11434", detail: "Looking for Ollama." });
  for (const [where, words] of Object.entries(p)) {
    expect(words, where).toMatch(/Looking/);
    expect(words, where).not.toMatch(/stopped|isn't running|Starting Ollama/i);
  }
});

const installing = (receivedBytes: number) => ({ state: "installing", owner: "app", baseUrl: base.baseUrl, detail: "Installing Ollama.", install: { receivedBytes, totalBytes: 1_543_547_172 } }) as const;

describe("a stalled engine download is one reading: the first window, the banner, the footer gear and Settings", () => {

  // The stall is the server's word (its own bound, after which a Retry starts the download again):
  // a window keeping its own clock could say "stalled" and offer a Retry the server would ignore.
  it("figures that hold, with no word from the server, never say stalled anywhere", async () => {
    vi.useFakeTimers();
    try {
      const held = installing(300_000_000);
      const first = await places(held);
      vi.advanceTimersByTime(60_000);
      const later = await places(held);
      for (const p of [first, later]) {
        for (const [where, words] of Object.entries(p)) {
          expect(words, where).toContain("Downloading Ollama");
          expect(words, where).not.toContain("Download stalled");
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("a status the server marked stalled says so everywhere, with Retry", async () => {
    const now = installing(500_000_000);
    const p = await places({ ...now, install: { ...now.install, stalled: true } });
    for (const [where, words] of Object.entries(p)) {
      expect(words, where).toContain("Download stalled");
      expect(words, where).not.toContain("Downloading Ollama");
    }
    // the gear sends the person to Settings › Runtime, so Retry is there as on the banner and the first window
    for (const where of ["banner", "first", "settings"]) expect(p[where], where).toContain("Retry");
  });

  // Council climb-025 Q15: "Download stalled" gave no reason.
  it("a stalled download says the one reason the server knows: no data for its bound", async () => {
    const now = installing(500_000_000);
    const p = await places({ ...now, install: { ...now.install, stalled: true, quietMs: 5000 } });
    for (const where of ["banner", "first", "settings"]) expect(p[where], where).toMatch(/Download stalled[\s\S]*no data for over 5 s/);
  });

  it("Settings › Runtime shows a running download's figures in the same words as the banner and the first window", async () => {
    const p = await places({ ...installing(500_000_000), install: { receivedBytes: 500_000_000, totalBytes: 1_543_547_172, bytesPerSecond: 10e6 } });
    const figures = /0\.5\sof\s1\.4\sGB[^.]*left/.exec(p["banner"] ?? "")?.[0];
    expect(figures).toBeDefined();
    expect(p["first"]).toContain(figures);
    expect(p["settings"]).toContain(figures);
  });

  it("a stalled download drops the time left, and the gear's tip names where to act and never the figures", async () => {
    const { rtInfo } = await import("./words.tsx");
    const now = { ...installing(500_000_000), install: { receivedBytes: 500_000_000, totalBytes: 1_543_547_172, bytesPerSecond: 10e6 } };
    const moving = await places(now);
    for (const where of ["banner", "first"]) expect(moving[where], where).toMatch(/left/);
    expect(rtInfo({ conn: { kind: "open" }, runtime: now }).tip).toBe("");
    const stuck = { ...now, install: { ...now.install, stalled: true as const } };
    const p = await places(stuck);
    for (const [where, words] of Object.entries(p)) expect(words, where).not.toMatch(/left/);
    for (const where of ["banner", "first"]) expect(p[where], where).toMatch(/0\.5\sof\s1\.4\sGB/);
    expect(rtInfo({ conn: { kind: "open" }, runtime: stuck }).tip).toBe("Open Settings › Runtime to retry.");
    const failed = rtInfo({ conn: { kind: "open" }, runtime: stopped });
    expect(failed.tip).toBe("Open Settings › Runtime for details and Retry.");
    expect(failed.tip).not.toMatch(/download|didn't/i);
  });

  it("the stall arrives as the server's status and wakes whatever reads the runtime; held figures wake nothing", async () => {
    vi.useFakeTimers();
    try {
      const { rtInfo } = await import("./words.tsx");
      const now = installing(400_000_000);
      setState({ ...initial, conn: { kind: "open" }, runtime: now, models: [], view: "new" });
      const gear = () => text(renderToStaticMarkup(createElement("div", null, rtInfo(getState()).text)));
      let woke = 0;
      const { subscribe } = await import("../lib/store/store.ts");
      const stop = subscribe(() => woke++);
      expect(gear()).toContain("Downloading Ollama");
      vi.advanceTimersByTime(60_000);
      expect(woke).toBe(0);
      expect(gear()).toContain("Downloading Ollama");
      setState({ runtime: { ...now, install: { ...now.install, stalled: true } } });
      expect(woke).toBe(1);
      expect(gear()).toContain("Download stalled");
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

it("a start that failed still says Ollama didn't start", async () => {
  const p = await places(exited);
  for (const [where, words] of Object.entries(p)) {
    expect(words, where).toMatch(/didn't start/i);
    expect(words, where).not.toMatch(/download/i);
  }
});
