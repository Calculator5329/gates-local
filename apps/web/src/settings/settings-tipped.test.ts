// Every Settings section rendered over the in-memory server: no label carries
// a tooltip, every tip is a few words, and the Image generation row says once,
// where it can be seen, what a short GPU costs.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";
import { type Browser, installBrowser, tick, until } from "../../test/harness.ts";

let b: Browser;
let stop: () => void;
let session: typeof import("../lib/session/index.ts");
let store: typeof import("../lib/store/store.ts");
let SettingsView: typeof import("./Settings.tsx")["SettingsView"];
const SECTIONS = ["general", "models", "instructions", "library", "tools", "images", "runtime", "advanced", "shortcuts"] as const;

beforeEach(async () => {
  b = installBrowser();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.resetModules();
  session = await import("../lib/session/index.ts");
  store = await import("../lib/store/store.ts");
  ({ SettingsView } = await import("./Settings.tsx"));
  stop = session.connect();
  await until(() => store.getState().imageStatus !== undefined, 2000, "boot");
  await tick();
  store.setState({ settings: methodSamples["settings.get"].result });
});
afterEach(async () => {
  stop?.(); b.server.accepting = false;
  for (const socket of b.server.sockets) socket.close();
  await tick(); vi.unstubAllGlobals();
});
const render = (section: (typeof SECTIONS)[number]) => {
  store.setState({ section });
  return renderToStaticMarkup(createElement(SettingsView));
};

const decode = (s: string) => s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#x27;", "'").replaceAll("&amp;", "&");

// Decision 19: a label, a row or a value has no tooltip; a tip names an icon-only button in 1 to 3 words,
// or says in a few words why a button is disabled.
it("no label, row or value in any section carries a tooltip, and every tip is a few words", () => {
  for (const section of SECTIONS) {
    const html = render(section);
    expect(html, section).not.toContain('class="tipped"');
    expect(html, section).not.toMatch(/<(?:span|div|td|b|label)\b[^>]*\sdata-tip="/);
    for (const [, tip] of html.matchAll(/\sdata-tip="([^"]*)"/g)) {
      expect(decode(tip ?? "").split(/\s+/).length, `${section}: ${tip}`).toBeLessThanOrEqual(6);
    }
  }
});

it("F4: Image generation says what an image costs the chat model in its visible line, once, and not in the tooltip", () => {
  const sentence = "The chat model unloads while an image renders.";
  // only where it is true: nothing is said until this computer's card is known to render
  // (on a card it can be true for, its room is held by an unseen copy, aria-hidden: that copy says nothing)
  store.setState({ imagePresets: undefined });
  expect(render("images").replace(/<span class="held" aria-hidden="true">[^<]*<\/span>/g, "")).not.toContain(sentence);
  store.setState({ imagePresets: { ...methodSamples["image.presets"].result, unloadsChat: true } });
  const html = render("images");
  expect(html.split(sentence).length - 1).toBe(1);
  expect(html).not.toMatch(/data-tip="[^"]*chat model unloads/);
  expect(html).toMatch(/<span class="d">[^<]*The chat model unloads while an image renders\./);
});

// Nothing moves: the image list asks ComfyUI first and can answer after Settings › Image generation
// has painted. On a card the sentence can be said for, its line is there from the first frame.
it("the unloads line keeps its room while the image list is on its way, only on a card it can be said for", () => {
  const GIB = 1024 ** 3;
  const card = { vendor: "nvidia" as const, totalBytes: 16 * GIB, freeBytes: 14 * GIB, occupants: [], systemMemoryAvailableBytes: 24 * GIB, measuredAt: 1 };
  const line = /<b>Generate images<\/b><span class="d">/;
  store.setState({ imagePresets: undefined, gpu: card });
  // held unseen, the sentence itself, so the room is as many lines as it wraps to at any width
  expect(render("images")).toMatch(/<b>Generate images<\/b><span class="d"><span class="held" aria-hidden="true">The chat model unloads while an image renders\.<\/span>/);
  // the answer lands: the sentence fills the line it kept
  store.setState({ imagePresets: { ...methodSamples["image.presets"].result, unloadsChat: true } });
  expect(render("images")).toMatch(/<b>Generate images<\/b><span class="d">The chat model unloads while an image renders\./);
  // no GPU: the sentence is never said, so no line is kept for it
  store.setState({ imagePresets: undefined, gpu: { ...card, vendor: "none", totalBytes: undefined, freeBytes: undefined } });
  expect(render("images")).not.toMatch(line);
});
