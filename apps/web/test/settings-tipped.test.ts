// Every Settings section rendered over the in-memory server: no label carries
// a tooltip, every tip is a few words, and the Image generation row says once,
// where it can be seen, what a short GPU costs.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";
import { type Browser, installBrowser, tick, until } from "./harness.ts";

let b: Browser;
let stop: () => void;
let session: typeof import("../src/session.ts");
let store: typeof import("../src/store.ts");
let SettingsView: typeof import("../src/Settings.tsx")["SettingsView"];
const SECTIONS = ["general", "models", "instructions", "library", "tools", "images", "runtime", "advanced", "shortcuts"] as const;

beforeEach(async () => {
  b = installBrowser();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.resetModules();
  session = await import("../src/session.ts");
  store = await import("../src/store.ts");
  ({ SettingsView } = await import("../src/Settings.tsx"));
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
  store.setState({ imagePresets: undefined });
  expect(render("images")).not.toContain(sentence);
  store.setState({ imagePresets: { ...methodSamples["image.presets"].result, unloadsChat: true } });
  const html = render("images");
  expect(html.split(sentence).length - 1).toBe(1);
  expect(html).not.toMatch(/data-tip="[^"]*chat model unloads/);
  expect(html).toMatch(/<span class="d">[^<]*The chat model unloads while an image renders\./);
});
