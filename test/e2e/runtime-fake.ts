/// <reference lib="dom" />
// The runtime status a first-run spec shows the page: a fake state of the spec's choosing laid over
// the server's own answers and pushes, or the server's own again once `real` is called. The server
// itself runs on as it is (its Ollama ready); only what the page reads about the runtime changes.
import type { Page, WebSocketRoute } from "@playwright/test";
import { numberedRoute } from "./numbered-route.ts";

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

/** The same download once the server has called it stalled: no new bytes for its bound, so no speed, and the flag. */
export const stalled = (r: Status): Status => {
  const s = installing(r);
  const { bytesPerSecond: _, ...install } = s["install"] as Status;
  return { ...s, install: { ...install, stalled: true } };
};

/**
 * Route the page's socket; the page starts on `first` (looking for Ollama by default). With `retry`,
 * the page's runtime.retry switches the fake to it before the answer comes back, as the server
 * starts a stalled download again and answers the new attempt's status.
 */
export async function fakeRuntime(page: Page, first: ((r: Status) => Status) | undefined = looking, { retry }: { retry?: (r: Status) => Status } = {}) {
  let socket: WebSocketRoute | undefined;
  let real: Status | undefined;
  let fake: ((r: Status) => Status) | undefined = first;
  // A status comes alone (runtime.status, runtime.changed) or beside the models in a list's
  // answer; the window takes either as the runtime, so both are faked.
  const faked = (v: unknown): unknown => {
    if (isRuntime(v)) { real = v; return fake === undefined ? v : fake(v); }
    const beside = typeof v === "object" && v !== null ? (v as { runtime?: unknown }).runtime : undefined;
    if (!isRuntime(beside)) return v;
    real = beside;
    return fake === undefined ? v : { ...v as Status, runtime: fake(beside) };
  };
  await page.routeWebSocket(/\/\?token=/, (routed) => {
    // a status this route makes up goes out numbered, as the newest, as the server would number it
    const { page: ws } = numberedRoute(routed);
    socket = ws;
    const server = ws.connectToServer();
    ws.onMessage((raw) => {
      if (retry !== undefined && typeof raw === "string" && (JSON.parse(raw) as { method?: unknown }).method === "runtime.retry") fake = retry;
      server.send(raw);
    });
    server.onMessage((raw) => {
      if (typeof raw !== "string") return ws.send(raw);
      const m = JSON.parse(raw) as { result?: unknown; payload?: unknown };
      if ("result" in m) return ws.send(JSON.stringify({ ...m, result: faked(m.result) }));
      if ("payload" in m) return ws.send(JSON.stringify({ ...m, payload: faked(m.payload) }));
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
