// Diagnostic probe for instance ownership; production-session replays cover behavior.
import { expect, it, vi } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";
import { createConnection } from "./connection.ts";
import { installBrowser, tick, until } from "../../../test/harness.ts";
import { getState, setState } from "../store/store.ts";

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
    expect(browser.server.sockets.map(socket => socket.url.replace(/\?window=[\w-]+$/, ""))).toEqual(["ws://first.invalid/ws", "ws://second.invalid/ws"]);
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

function plainConnection(hydrate: Parameters<typeof createConnection>[0]["hydrate"] = async () => {}, afterDisconnect = () => {}) {
  return createConnection({
    applyServerEvent: setState,
    serverUrl: async () => "ws://plain.invalid/ws",
    webServerUrl: () => "ws://plain.invalid/ws",
    desktopBridge: () => undefined,
    hydrate,
    afterDisconnect,
  });
}

async function closeBrowser(browser: ReturnType<typeof installBrowser>): Promise<void> {
  browser.server.accepting = false;
  for (const socket of browser.server.sockets) socket.close();
  await tick();
  vi.unstubAllGlobals();
}

it("the session's cleanup after a stop runs once the connection is gone, so a call it makes is told Gates Local isn't connected", async () => {
  const browser = installBrowser();
  let hydrated = false;
  let heard: Promise<string> | undefined;
  const connection = plainConnection(async () => { hydrated = true; }, () => {
    heard = connection.libraryRequest("sources.imports", {}).then(() => "answered", (e: unknown) => (e instanceof Error ? e.message : String(e)));
  });
  const stop = connection.connect();
  try {
    await until(() => hydrated);
    stop();
    await until(() => heard !== undefined);
    expect(await heard).toBe("Gates Local isn't connected. Try again once it reconnects.");
  } finally {
    stop();
    await closeBrowser(browser);
  }
});

it("a one-reply call with no connection, before it starts or after it stops, answers not reached and never rejects", async () => {
  const browser = installBrowser();
  const connection = plainConnection();
  const { params } = methodSamples["reply.stop"];
  await expect(connection.reply("reply.stop", params)).resolves.toEqual({ answer: "not-reached", why: "closed" });
  const stop = connection.connect();
  try {
    await until(() => browser.server.sockets.length === 1 && getState().conn.kind === "open");
    stop();
    await tick();
    await expect(connection.reply("reply.stop", params)).resolves.toEqual({ answer: "not-reached", why: "closed" });
    expect(browser.server.calls("reply.stop")).toHaveLength(0);
  } finally {
    stop();
    await closeBrowser(browser);
  }
});

it("an action the server answers not-implemented is marked unavailable for the rest of the session, through a reconnect", async () => {
  const browser = installBrowser();
  setState({ unavailable: {} });
  let hydrations = 0;
  const connection = plainConnection(async () => { hydrations++; });
  browser.server.answer("models.remove", () => { throw { code: "not-implemented", message: "models.remove is not implemented" }; });
  const stop = connection.connect();
  try {
    await until(() => hydrations === 1);
    await expect(connection.act("models.remove", { name: "gemma3:4b" }, "remove gemma3:4b")).resolves.toEqual({ ok: false, message: "Couldn't remove gemma3:4b because this build can't do that yet." });
    expect(getState().unavailable["models.remove"]).toBe(true);
    await expect(connection.act("models.list", {}, "read the models")).resolves.toMatchObject({ ok: true });
    browser.server.socket.close();
    await until(() => hydrations === 2);
    expect(getState().unavailable).toEqual({ "models.remove": true });
  } finally {
    stop();
    await closeBrowser(browser);
  }
});

it("a first read that fails still ends the first read for this connection", async () => {
  const browser = installBrowser();
  setState({ hydrationSettled: false });
  let failed = false;
  const connection = plainConnection(async client => {
    await client.negotiate();
    failed = true;
    throw new Error("Snapshot unavailable");
  });
  const stop = connection.connect();
  try {
    await until(() => failed);
    await until(() => getState().hydrationSettled);
    expect(browser.server.sockets).toHaveLength(1);
  } finally {
    stop();
    await closeBrowser(browser);
  }
});
