// Settings › Shortcuts against the app's own key handler: a Ctrl binding the app answers is listed,
// and a listed one is answered.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type Browser, installBrowser, tick, until } from "../../test/harness.ts";

let browser: Browser;
let stop: (() => void) | undefined;
let store: typeof import("../lib/store/store.ts");

beforeEach(async () => {
  browser = installBrowser();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.resetModules();
  const session = await import("../lib/session/index.ts");
  store = await import("../lib/store/store.ts");
  stop = session.connect();
  await until(() => store.getState().imageStatus !== undefined);
});
afterEach(async () => {
  stop?.();
  browser.server.accepting = false;
  for (const socket of browser.server.sockets) socket.close();
  await tick();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("every Ctrl binding the app answers is on the Shortcuts page, and every one listed there is answered", async () => {
  const { SettingsView } = await import("./Settings.tsx");
  const { onKey } = await import("../app/App.tsx");
  store.setState({ section: "shortcuts" });
  const html = renderToStaticMarkup(createElement(SettingsView));
  const listed = [...html.matchAll(/<td class="k">((?:<kbd>[^<]*<\/kbd>)+)<\/td>/g)]
    .map((m) => [...(m[1] ?? "").matchAll(/<kbd>([^<]*)<\/kbd>/g)].map((k) => k[1]).join("+"))
    // Ctrl Shift Space is the dictation key, answered by voice/Voice.tsx's own listener
    .filter((keys) => keys.startsWith("Ctrl+") && keys !== "Ctrl+Shift+Space");
  const answers = (key: string, shiftKey: boolean) => {
    store.setState({ view: "thread", threadId: "t1", messages: { t1: [] }, pop: null, panel: null, drawer: false });
    let taken = false;
    onKey({ key: shiftKey ? key.toUpperCase() : key, shiftKey, ctrlKey: true, metaKey: false, preventDefault: () => { taken = true; } });
    return taken;
  };
  const answered: string[] = [];
  for (const key of "abcdefghijklmnopqrstuvwxyz0123456789,./;") {
    const plain = answers(key, false);
    if (plain) answered.push(`Ctrl+${key.toUpperCase()}`);
    // a Shift binding of its own, not the plain one with Shift held
    else if (answers(key, true)) answered.push(`Ctrl+Shift+${key.toUpperCase()}`);
  }
  expect(listed.toSorted()).toEqual(answered.toSorted());
});
