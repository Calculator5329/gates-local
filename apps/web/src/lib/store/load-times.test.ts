import { afterEach, expect, it, vi } from "vitest";
import { installBrowser, tick, until } from "../../../test/harness.ts";
import { loadGuess, readLoadTimes } from "./load-times.ts";

const KEY = "gates-local.model-load-ms";
const holding = (value: string | null) => vi.stubGlobal("localStorage", { getItem: (k: string) => (k === KEY ? value : null), setItem: () => undefined });

afterEach(() => vi.unstubAllGlobals());

it("the saved load times read back in milliseconds by model, and read as none when storage is missing, refuses, or holds anything but a map of numbers", () => {
  holding(JSON.stringify({ "qwen3:8b": 4200 }));
  expect(readLoadTimes()).toEqual({ "qwen3:8b": 4200 });
  vi.stubGlobal("localStorage", undefined);
  expect(readLoadTimes()).toEqual({});
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("refused"); }, setItem: () => undefined });
  expect(readLoadTimes()).toEqual({});
  for (const held of ["not json", "null", "4200", "[4200, 3100]", JSON.stringify({ "qwen3:8b": "4200" })]) {
    holding(held);
    expect(readLoadTimes(), held).toEqual({});
  }
});

it("the load guess is the last load in whole seconds, and a load under half a second still says one second", () => {
  expect(loadGuess(4200)).toBe("~4 s");
  expect(loadGuess(4500)).toBe("~5 s");
  expect(loadGuess(400)).toBe("~1 s");
  expect(loadGuess(0)).toBe("~1 s");
});

it("a load time this browser cannot save is still used for the rest of the session", async () => {
  const b = installBrowser();
  vi.resetModules();
  const session = await import("../session/index.ts");
  const store = await import("./store.ts");
  const disconnect = session.connect();
  try {
    await until(() => store.getState().conn.kind === "open", 2000, "connected");
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw new Error("quota"); } });
    b.server.push("models.load", { model: "qwen3:8b", numCtx: 16384, state: "loading" });
    await until(() => store.getState().loadSince["qwen3:8b"] !== undefined, 2000, "the load seen starting");
    b.server.push("models.load", { model: "qwen3:8b", numCtx: 16384, state: "ready" });
    await until(() => store.getState().loads["qwen3:8b"]?.state === "ready", 2000, "the load seen ready");
    expect(store.getState().loadTimes["qwen3:8b"]).toBeTypeOf("number");
  } finally {
    disconnect();
    b.server.accepting = false;
    for (const socket of b.server.sockets) socket.close();
    await tick();
  }
});
