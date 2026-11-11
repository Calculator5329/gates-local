// Measured model speed in the client's store (in-memory server, harness.ts):
// read once after the first frame, replaced by the models.speed push when a
// reply finishes, and never re-read while words stream in.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelSpeed } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { type Browser, installBrowser, tick, until } from "./harness.ts";

type Session = typeof import("../src/session.ts");
type Store = typeof import("../src/store.ts");

let b: Browser;
let session: Session;
let store: Store;
let disconnect: (() => void) | undefined;

const fast: ModelSpeed = { model: "qwen3.5:9b", tokensPerSecond: 101.6, replies: 8 };
const slow: ModelSpeed = { model: "gemma3:4b", tokensPerSecond: 8.4, replies: 1 };

beforeEach(async () => {
  b = installBrowser();
  vi.resetModules();
  session = await import("../src/session.ts");
  store = await import("../src/store.ts");
  disconnect = undefined;
});

afterEach(async () => {
  disconnect?.();
  b.server.accepting = false;
  for (const s of b.server.sockets) s.close();
  await tick();
  vi.unstubAllGlobals();
});

const hydrated = () => store.getState().imageStatus !== undefined && store.getState().conn.kind === "open";

async function boot(): Promise<void> {
  disconnect = session.connect();
  await until(hydrated, 2000, "hydration");
  await tick();
}

const speeds = () => store.getState().speeds;

describe("measured speed in the store", () => {
  it("reads once after the model list's frame, by model name", async () => {
    b.server.answer("models.speed", () => [fast, slow]);
    await boot();
    expect(b.server.calls("models.speed")).toHaveLength(1);
    expect(speeds()).toEqual({ "qwen3.5:9b": fast, "gemma3:4b": slow });
  });

  it("a finished reply's push changes the number; streaming words cause no read", async () => {
    b.server.answer("models.speed", () => [fast]);
    await boot();
    const { turnId } = methodSamples["chat.send"].result;
    for (const text of ["one ", "two ", "three "]) b.server.broadcast("chat.event", { turnId, threadId: "t1", event: { type: "delta", text } });
    await tick();
    expect(b.server.calls("models.speed")).toHaveLength(1);
    expect(speeds()).toEqual({ "qwen3.5:9b": fast });

    const after = { ...fast, tokensPerSecond: 97.2, replies: 9 };
    b.server.broadcast("models.speed", [after, slow]);
    await tick();
    expect(speeds()).toEqual({ "qwen3.5:9b": after, "gemma3:4b": slow });
    expect(b.server.calls("models.speed")).toHaveLength(1);
  });

  it("keeps an unchanged model's entry, so its row does not redraw", async () => {
    b.server.answer("models.speed", () => [fast, slow]);
    await boot();
    const before = speeds();
    b.server.broadcast("models.speed", [{ ...fast }, { ...slow, tokensPerSecond: 9.1, replies: 2 }]);
    await tick();
    const now = speeds();
    if (now === undefined || now === "na" || before === undefined || before === "na") throw new Error("no speeds");
    expect(now["qwen3.5:9b"]).toBe(before["qwen3.5:9b"]);
    expect(now["gemma3:4b"]).toEqual({ ...slow, tokensPerSecond: 9.1, replies: 2 });
  });

  it("a push that lands while the first read is out wins over that older read", async () => {
    const held = b.server.hold("models.speed");
    disconnect = session.connect();
    const read = await held;
    b.server.broadcast("models.speed", [fast]);
    await tick();
    read.respond([]);
    await until(hydrated, 2000, "hydration");
    await tick();
    expect(speeds()).toEqual({ "qwen3.5:9b": fast });
  });

  it("an older server without the read leaves no numbers and asks once", async () => {
    b.server.answer("models.speed", () => {
      throw { code: "not-implemented", message: "Older server" };
    });
    await boot();
    expect(speeds()).toBe("na");
    expect(b.server.calls("models.speed")).toHaveLength(1);
  });
});
