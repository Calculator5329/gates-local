// Diagnostic probe for instance ownership; production-session replays cover behavior.
import { expect, it, vi } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";
import { createConnection } from "../src/session/connection.ts";
import { installBrowser, tick, until } from "./harness.ts";
import { setState } from "../src/store.ts";

type Attempt = "negotiation-error" | "hydration-error" | "ready";

async function retryDelays(attempts: readonly Attempt[]): Promise<number[]> {
  vi.useFakeTimers();
  const browser = installBrowser();
  const timers = vi.spyOn(globalThis, "setTimeout");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let attempted = 0;
  browser.server.answer("sync.negotiate", () => {
    if (attempts[attempted++] === "negotiation-error") throw { code: "internal", message: "Negotiation refused" };
    return methodSamples["sync.negotiate"].result;
  });
  const connection = createConnection({
    applyServerEvent: setState,
    serverUrl: async () => "ws://retry.invalid/ws",
    webServerUrl: () => "ws://retry.invalid/ws",
    desktopBridge: () => undefined,
    hydrate: async client => {
      await client.negotiate();
      client.close();
      if (attempts[attempted - 1] === "hydration-error") throw new Error("Snapshot unavailable");
    },
    afterDisconnect: () => {},
  });
  const stop = connection.connect();
  const delays: number[] = [];
  try {
    for (let i = 0; i < attempts.length; i++) {
      await vi.advanceTimersByTimeAsync(0);
      expect(attempted).toBe(i + 1);
      const retry = timers.mock.calls.map(([, ms]) => ms).filter(ms => ms !== undefined && [250, 500, 1000, 2000, 4000].includes(ms)).at(-1);
      if (retry === undefined) throw new Error("No reconnect timer was scheduled");
      delays.push(retry);
      if (i + 1 < attempts.length) await vi.advanceTimersByTimeAsync(retry);
    }
    return delays;
  } finally {
    stop(); browser.server.accepting = false;
    await vi.advanceTimersByTimeAsync(0);
    vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals();
  }
}

it.each(["negotiation-error", "hydration-error"] as const)("SS6-01: repeated %s increases reconnect backoff to its cap", async failure => {
  expect(await retryDelays(Array<Attempt>(6).fill(failure))).toEqual([250, 500, 1000, 2000, 4000, 4000]);
});

it("SS6-01: successful hydration resets backoff after failed negotiations", async () => {
  expect(await retryDelays(["negotiation-error", "negotiation-error", "ready", "negotiation-error", "negotiation-error"]))
    .toEqual([250, 500, 250, 500, 1000]);
});

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
    expect(cleanup).toEqual(["first:after"]);
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
