// A page that opened against another version of the contract asks for a reload; one on the same
// version, or on a server too old to say, does not.
import { afterEach, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@gates-local/contracts";
import { type Browser, installBrowser, tick, until } from "../../test/harness.ts";

let browser: Browser | undefined;
let disconnect: (() => void) | undefined;

afterEach(async () => {
  disconnect?.();
  if (browser !== undefined) {
    browser.server.accepting = false;
    for (const socket of browser.server.sockets) socket.close();
  }
  await tick();
  vi.unstubAllGlobals();
});

it.each([
  [PROTOCOL_VERSION + 1, true],
  [PROTOCOL_VERSION - 1, true],
  [PROTOCOL_VERSION, false],
  [undefined, false],
])("a server on contract version %s: the page asks for a reload is %s", async (protocol, asks) => {
  browser = installBrowser();
  vi.resetModules();
  browser.server.answer("sync.negotiate", () => ({ epoch: "e", ordered: [], ...(protocol === undefined ? {} : { protocol }) }));
  const session = await import("../lib/session/index.ts");
  const store = await import("../lib/store/store.ts");
  disconnect = session.connect();
  await until(() => store.getState().imageStatus !== undefined);
  expect(store.getState().outdated === true).toBe(asks);
});
