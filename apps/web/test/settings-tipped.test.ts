// Every Settings section rendered over the in-memory server: each label that
// explains itself on hover also tells a screen reader, and the Image
// generation row says once, where it can be seen, what a short GPU costs.
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

it("F4: every tipped label carries its tip as aria-description, unescaped", () => {
  let seen = 0;
  for (const section of SECTIONS) {
    for (const span of render(section).match(/<span class="tipped"[^>]*>/g) ?? []) {
      seen++;
      const tip = /data-tip="([^"]*)"/.exec(span)?.[1];
      const said = /aria-description="([^"]*)"/.exec(span)?.[1];
      expect(said, `${section}: ${span}`).toBeTruthy();
      // data-tip holds the tip escaped once more for the tooltip's HTML
      expect(decode(said!), `${section}: ${span}`).toBe(decode(decode(tip!)));
    }
  }
  expect(seen, "the sections have tipped labels to check").toBeGreaterThan(3);
});

it("F4: Image generation says what a short GPU costs in its visible line, once, and not in the tooltip", () => {
  const html = render("images");
  const sentence = "If the GPU is short, the chat model is unloaded while an image renders.";
  expect(html.split(sentence).length - 1).toBe(1);
  expect(html).not.toMatch(/data-tip="[^"]*If the GPU is short/);
  expect(html).toMatch(/<span class="d">[^<]*If the GPU is short, the chat model is unloaded while an image renders\./);
});
