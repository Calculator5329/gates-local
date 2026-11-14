// A Measure run in the client's store (in-memory server, harness.ts): the server's read says which
// run goes now, so a window that connects mid-run, or missed the run's last push, shows what is
// true; and a measure's pages run only in the window the server lets hold them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeasureRun, ModelMeasure } from "@gates-local/contracts";
import { type Browser, installBrowser, tick, until } from "./harness.ts";

type Session = typeof import("../src/session.ts");
type Store = typeof import("../src/store.ts");

let b: Browser;
let session: Session;
let store: Store;
let disconnect: (() => void) | undefined;
/** The pages this window ran (the frame itself is measure-pages.ts's). */
const ran = vi.fn(async () => []);

beforeEach(async () => {
  b = installBrowser();
  vi.resetModules();
  ran.mockClear();
  vi.doMock("../src/measure-pages.ts", () => ({ runPages: ran }));
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

const running: MeasureRun = { model: "qwen3.5:9b", state: "running", done: 5, total: 22 };
/** A measure whose one page waits for the window that started it. */
const pending = (at: number): ModelMeasure => ({
  model: "qwen3.5:9b", digest: "sha256:abc", at, version: 2, numCtx: 4096, tokensPerSecond: 40, score: 80,
  checks: [{ id: "page-counter", kind: "pages", ok: false, state: "pending", page: "<p id=count>0</p>", script: [{ do: "read", target: "#count" }] }],
});
const frames = () => ran.mock.calls.length;

describe("a Measure run in the store", () => {
  it("a window that connects mid-run shows the server's run", async () => {
    b.server.answer("models.measures", () => ({ measures: [], run: running }));
    await boot();
    expect(store.getState().measuring).toEqual({ "qwen3.5:9b": running });
  });

  it("a reconnect replaces a run whose last push was lost with the server's record", async () => {
    b.server.answer("models.measures", () => ({ measures: [] }));
    await boot();
    b.server.broadcast("models.measuring", running);
    await tick();
    expect(store.getState().measuring).toEqual({ "qwen3.5:9b": running });
    // the run's "done" never arrived; the server has no run now
    const asked = b.server.calls("models.measures").length;
    b.server.socket.close();
    await until(() => b.server.calls("models.measures").length > asked && store.getState().conn.kind === "open", 2000, "the reconnect reads again");
    await tick(20);
    expect(store.getState().measuring).toEqual({});
  });

  it("a measure's pages run only in the window the server lets hold them, once", async () => {
    let claimed = false;
    const asked: number[] = [];
    b.server.answer("models.measures", () => ({ measures: [] }));
    b.server.answer("models.measurePagesClaim", ({ at }) => { asked.push(at); return { claimed }; });
    b.server.answer("models.measurePages", () => pending(1));
    await boot();
    // another window holds them: this window asks, is refused, and runs nothing
    b.server.broadcast("models.measures", [pending(1)]);
    await until(() => asked.length === 1, 2000, "the claim");
    await tick();
    expect(frames()).toBe(0);
    // that window went away and the list came again: this window holds them and runs them, once
    claimed = true;
    b.server.broadcast("models.measures", [pending(1)]);
    b.server.broadcast("models.measures", [pending(1)]);
    await until(() => frames() === 1, 2000, "the pages");
    await tick();
    expect(frames()).toBe(1);
  });

  it("a window opened mid-run asks for the pending pages its first read shows", async () => {
    b.server.answer("models.measures", () => ({ measures: [pending(2)], run: running }));
    b.server.answer("models.measurePagesClaim", () => ({ claimed: true }));
    b.server.answer("models.measurePages", () => pending(2));
    await boot();
    await until(() => frames() === 1, 2000, "the pages");
  });
});
