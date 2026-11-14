/// <reference lib="dom" />
// The runtime status a first-run spec shows the page: a fake state of the spec's choosing laid over
// the server's own answers and pushes, or the server's own again once `real` is called. The server
// itself runs on as it is (its Ollama ready); only what the page reads about the runtime changes.
import type { Page, WebSocketRoute } from "@playwright/test";

export type Status = Record<string, unknown>;
const isRuntime = (v: unknown): v is Status => typeof v === "object" && v !== null && "baseUrl" in v && "state" in v;
const GIB = 1024 ** 3;

/** The app looking for an Ollama: what a fresh start reads first. */
export const looking = (r: Status): Status => ({ ...r, state: "starting", owner: "none", detail: "Looking for Ollama." });
/** The app's own Ollama starting, right after its download and unpack. */
export const startingOwn = (r: Status): Status => ({ ...r, state: "starting", owner: "app", detail: "Starting the app's Ollama." });
/** The app's own Ollama downloading, 0.2 of 1.4 GB in. */
export const installing = (r: Status): Status => ({
  ...r,
  state: "installing",
  owner: "app",
  detail: "Installing Ollama.",
  install: { receivedBytes: Math.round(0.2 * GIB), totalBytes: Math.round(1.4 * GIB), bytesPerSecond: 40_000_000, diskBytes: Math.round(2.4 * GIB) },
});

/** Route the page's socket; the page starts on `first` (looking for Ollama by default). */
export async function fakeRuntime(page: Page, first: ((r: Status) => Status) | undefined = looking) {
  let socket: WebSocketRoute | undefined;
  let real: Status | undefined;
  let fake: ((r: Status) => Status) | undefined = first;
  await page.routeWebSocket(/\/\?token=/, (ws) => {
    socket = ws;
    const server = ws.connectToServer();
    ws.onMessage((raw) => server.send(raw));
    server.onMessage((raw) => {
      if (typeof raw !== "string") return ws.send(raw);
      const m = JSON.parse(raw) as { result?: unknown; payload?: unknown };
      if (isRuntime(m.result)) real = m.result;
      if (isRuntime(m.payload)) real = m.payload;
      if (fake !== undefined && isRuntime(m.result)) return ws.send(JSON.stringify({ ...m, result: fake(m.result) }));
      if (fake !== undefined && isRuntime(m.payload)) return ws.send(JSON.stringify({ ...m, payload: fake(m.payload) }));
      ws.send(raw);
    });
  });
  const push = (payload: Status) => {
    if (socket === undefined) throw new Error("socket not ready");
    socket.send(JSON.stringify({ type: "push", channel: "runtime.changed", payload }));
  };
  return {
    set(next: (r: Status) => Status) {
      if (real === undefined) throw new Error("no runtime status read yet");
      fake = next;
      push(next(real));
    },
    real() {
      if (real === undefined) throw new Error("no runtime status read yet");
      fake = undefined;
      push(real);
    },
  };
}
