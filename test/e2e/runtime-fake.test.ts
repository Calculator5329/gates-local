// The first-run specs' runtime fake, without a browser: the status the page reads is the fake's
// wherever the server sends one, alone or beside the models in a list, and a Retry switches it.
import { expect, it } from "vitest";
import type { Page, WebSocketRoute } from "@playwright/test";
import { fakeRuntime, installing, stalled } from "./runtime-fake.ts";

type Handler = (raw: string | Buffer) => unknown;
async function routed(first = installing, retry?: typeof installing) {
  const toPage: string[] = [];
  let fromPage: Handler | undefined;
  let fromServer: Handler | undefined;
  const upstream = { send: () => undefined, onMessage: (h: Handler) => { fromServer = h; } };
  const socket = { send: (raw: string) => { toPage.push(raw); }, onMessage: (h: Handler) => { fromPage = h; }, connectToServer: () => upstream };
  const page = { routeWebSocket: (_url: RegExp, handler: (ws: WebSocketRoute) => void) => { handler(socket as unknown as WebSocketRoute); return Promise.resolve(); } };
  const fake = await fakeRuntime(page as unknown as Page, first, retry === undefined ? {} : { retry });
  return {
    fake, toPage,
    page: (frame: object) => fromPage?.(JSON.stringify(frame)),
    server: (frame: object) => fromServer?.(JSON.stringify(frame)),
    runtimeOf: (i: number) => {
      const m = JSON.parse(toPage[i] ?? "{}") as { result?: { state?: string; runtime?: { state?: string; install?: { stalled?: boolean } }; install?: { stalled?: boolean } }; payload?: { state?: string; install?: { stalled?: boolean } } };
      return m.result?.runtime ?? m.result ?? m.payload;
    },
  };
}
const READY = { baseUrl: "http://localhost:1", state: "ready", owner: "app" };

it("fakes the runtime beside the models in a list's answer, as it fakes a status alone", async () => {
  const r = await routed();
  r.page({ type: "request", id: "1", method: "models.list", params: {} });
  r.server({ type: "response", id: "1", ok: true, result: { runtime: READY, models: [] } });
  r.page({ type: "request", id: "2", method: "runtime.status", params: {} });
  r.server({ type: "response", id: "2", ok: true, result: READY });
  r.server({ type: "push", channel: "runtime.changed", payload: READY });
  expect([0, 1, 2].map(i => r.runtimeOf(i)?.state)).toEqual(["installing", "installing", "installing"]);
  expect((JSON.parse(r.toPage[0] ?? "{}") as { result: { models: unknown[] } }).result.models, "the list itself is the server's").toEqual([]);
});

it("says stalled once set, and the page's Retry switches it to the new attempt before the answer", async () => {
  const r = await routed(installing, installing);
  r.page({ type: "request", id: "1", method: "runtime.status", params: {} });
  r.server({ type: "response", id: "1", ok: true, result: READY });
  r.fake.set(stalled);
  expect(r.runtimeOf(1)?.install?.stalled).toBe(true);
  r.page({ type: "request", id: "2", method: "runtime.retry", params: {} });
  r.server({ type: "response", id: "2", ok: true, result: READY });
  expect(r.runtimeOf(2)?.state).toBe("installing");
  expect(r.runtimeOf(2)?.install?.stalled).toBeUndefined();
});
