// The routed socket's numbering, without a browser: a spec's own value goes out as the newest of
// its thing, the server's values keep their order among the spec's, and an old one stays old.
import { expect, it } from "vitest";
import type { WebSocketRoute } from "@playwright/test";
import { numberedRoute } from "./numbered-route.ts";

type Handler = (raw: string | Buffer) => unknown;
function fakeRoute() {
  const toPage: string[] = [];
  const toServer: string[] = [];
  let fromPage: Handler | undefined;
  let fromServer: Handler | undefined;
  const upstream = { send: (raw: string) => { toServer.push(raw); }, onMessage: (h: Handler) => { fromServer = h; } };
  const socket = { send: (raw: string) => { toPage.push(raw); }, onMessage: (h: Handler) => { fromPage = h; }, connectToServer: () => upstream };
  return {
    socket: socket as unknown as WebSocketRoute, toPage, toServer,
    page: (frame: object) => fromPage?.(JSON.stringify(frame)),
    server: (frame: object) => fromServer?.(JSON.stringify(frame)),
  };
}
const revs = (raw: string[]) => raw.map(r => (JSON.parse(r) as { sync?: { changes: Array<{ rev: number }> } }).sync?.changes.map(c => c.rev));

it("numbers a spec's own answers and pushes as the newest, and keeps the server's in order around them", () => {
  const f = fakeRoute();
  const { page } = numberedRoute(f.socket);
  f.page({ type: "request", id: "1", method: "sync.negotiate", params: { ordered: ["settings", "updates"] } });
  f.server({ type: "response", id: "1", ok: true, result: { epoch: "e1", ordered: ["updates"] } });
  f.page({ type: "request", id: "2", method: "update.status", params: {} });
  expect(f.toServer.map(r => (JSON.parse(r) as { id: string }).id), "the page's requests go on to the server").toEqual(["1", "2"]);

  f.server({ type: "response", id: "2", ok: true, result: {}, sync: { epoch: "e1", changes: [{ scope: "update", kind: "snapshot", rev: 0 }] } });
  page.send(JSON.stringify({ type: "push", channel: "update.changed", payload: {} }));
  f.server({ type: "push", channel: "update.changed", payload: {}, sync: { epoch: "e1", changes: [{ scope: "update", kind: "snapshot", rev: 1 }] } });
  // A late answer the server numbered 0 again, and a read it answered with an old number.
  f.server({ type: "response", id: "2", ok: true, result: {}, sync: { epoch: "e1", changes: [{ scope: "update", kind: "snapshot", rev: 0 }] } });
  f.page({ type: "request", id: "3", method: "update.dismissResult", params: {} });
  page.send(JSON.stringify({ type: "response", id: "3", ok: true, result: {} }));
  // Not ordered on this connection, and a refusal: both pass untouched.
  page.send(JSON.stringify({ type: "push", channel: "settings.changed", payload: {} }));
  page.send(JSON.stringify({ type: "response", id: "3", ok: false, error: { code: "failed", message: "no" } }));

  expect(revs(f.toPage.slice(1))).toEqual([[1], [2], [3], [1], [4], undefined, undefined]);
  expect((JSON.parse(f.toPage[2] ?? "{}") as { sync?: { epoch: string } }).sync?.epoch).toBe("e1");
});

it("numbers a spec's own list answer for the models and the runtime beside them", () => {
  const f = fakeRoute();
  const { page } = numberedRoute(f.socket);
  f.page({ type: "request", id: "1", method: "sync.negotiate", params: { ordered: ["models"] } });
  f.server({ type: "response", id: "1", ok: true, result: { epoch: "e1", ordered: ["models"] } });
  f.page({ type: "request", id: "2", method: "models.list", params: {} });
  page.send(JSON.stringify({ type: "response", id: "2", ok: true, result: { runtime: {}, models: [] } }));
  const sync = (JSON.parse(f.toPage[1] ?? "{}") as { sync?: { changes: Array<{ scope: string; rev: number }> } }).sync;
  expect(sync?.changes.map(c => [c.scope, c.rev])).toEqual([["models", 1], ["runtime", 1]]);
});

it("leaves every frame alone before the connection negotiated", () => {
  const f = fakeRoute();
  const { page } = numberedRoute(f.socket);
  page.send(JSON.stringify({ type: "push", channel: "update.changed", payload: {} }));
  expect(revs(f.toPage)).toEqual([undefined]);
});
