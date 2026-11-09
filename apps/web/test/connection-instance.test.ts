// Diagnostic probe for instance ownership; production-session replays cover behavior.
import { expect, it, vi } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";
import { createConnection } from "../src/session/connection.ts";
import { installBrowser, tick, until } from "./harness.ts";
import { setState } from "../src/store.ts";

it("stopping one connection leaves another instance's pending and subsequent RPCs alone", async () => {
  const browser = installBrowser();
  const hydrated: string[] = [];
  const cleanup: string[] = [];
  const instance = (name: string) => createConnection({
    applyServerEvent: setState,
    serverUrl: async () => `ws://${name}.invalid/ws`,
    webServerUrl: () => `ws://${name}.invalid/ws`,
    desktopBridge: () => undefined,
    hydrate: async () => { hydrated.push(name); },
    beforeDisconnect: () => { cleanup.push(`${name}:before`); },
    afterDisconnect: () => { cleanup.push(`${name}:after`); },
  });
  const first = instance("first");
  const second = instance("second");
  const stopFirst = first.connect();
  const stopSecond = second.connect();
  try {
    await until(() => hydrated.length === 2);
    expect(browser.server.sockets.map(socket => socket.url)).toEqual(["ws://first.invalid/ws", "ws://second.invalid/ws"]);
    const outstanding = browser.server.hold("models.list");
    const request = second.call("models.list", {});
    const held = await outstanding;

    stopFirst();
    await tick();
    expect(first.stopped).toBe(true);
    expect(second.stopped).toBe(false);
    expect(cleanup).toEqual(["first:before", "first:after"]);
    await expect(first.call("models.list", {})).rejects.toMatchObject({ code: "closed" });
    await expect(first.libraryRequest("sources.imports", {})).rejects.toThrow("Gates Local isn't connected. Try again once it reconnects.");

    held.respond(methodSamples["models.list"].result);
    await expect(request).resolves.toEqual(methodSamples["models.list"].result);
    await expect(second.call("models.list", {})).resolves.toEqual(methodSamples["models.list"].result);
  } finally {
    stopFirst();
    stopSecond();
    browser.server.accepting = false;
    for (const socket of browser.server.sockets) socket.close();
    await tick();
    vi.unstubAllGlobals();
  }
});
