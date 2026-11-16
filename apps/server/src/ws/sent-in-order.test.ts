// The models kind is numbered by the socket server itself, in the order it gives each frame out:
// a push takes the next number as it is sent, a read takes one as it starts. So a read that was
// slow to answer carries a lower number than a push sent while it was out, and the window drops it.
import { afterEach, expect, it, vi } from "vitest";
import { createClient, type SocketLike, type SyncChange, type SyncMetadata } from "@gates-local/contracts";
import { methodSamples as samples } from "@gates-local/contracts/testing";
import { WebSocket } from "ws";
import { startWsServer, type Handlers, type WsServer } from "./server.ts";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).toReversed()) await close(); });

const revs = (sync: SyncMetadata | undefined) => sync?.changes.map((change: SyncChange) => [change.scope, change.kind === "snapshot" ? change.rev : -1]);

async function serve(handlers: Partial<Handlers>): Promise<{ server: WsServer; client: ReturnType<typeof createClient> }> {
  const server = await startWsServer({ port: 0, token: "fixture", allowedOrigins: [], handlers });
  cleanup.push(() => server.close());
  const client = createClient(new WebSocket(`ws://127.0.0.1:${server.port}/?token=fixture`) as unknown as SocketLike);
  cleanup.push(() => client.close());
  expect(await client.negotiate()).toMatchObject({ epoch: expect.any(String) });
  return { server, client };
}

it("a slow runtime read carries the number it started with, below a push sent while it was out", async () => {
  const ready = samples["runtime.status"].result;
  let release: (() => void) | undefined;
  const out = new Promise<void>((resolve) => { release = resolve; });
  const { server, client } = await serve({ "runtime.status": async () => { await out; return ready; } });
  const pushed: Array<SyncMetadata | undefined> = [];
  client.subscribe("runtime.changed", (_status, sync) => pushed.push(sync));
  let readSync: SyncMetadata | undefined;
  const reading = client.call("runtime.status", {}, { onMetadata: (sync) => { readSync = sync; } });
  await vi.waitFor(() => expect(readSync).toBeUndefined());
  // the read has started (its handler is waiting) before the push goes out
  await new Promise((resolve) => setTimeout(resolve, 20));
  server.push("runtime.changed", { ...ready, state: "stopped" });
  await vi.waitFor(() => expect(pushed).toHaveLength(1));
  release?.();
  await reading;
  expect(revs(readSync)).toEqual([["runtime", 1]]);
  expect(revs(pushed[0])).toEqual([["runtime", 2]]);
});

it("a list answer numbers its models and the runtime beside them", async () => {
  const { client } = await serve({ "models.list": () => samples["models.list"].result });
  let listSync: SyncMetadata | undefined;
  await client.call("models.list", {}, { onMetadata: (sync) => { listSync = sync; } });
  expect(revs(listSync)).toEqual([["models", 1], ["runtime", 1]]);
});

it("a download's progress and the read of every download share one number, in the order given out", async () => {
  const progress = { name: "fresh:7b", state: "downloading" as const, completedBytes: 20, totalBytes: 100 };
  const { server, client } = await serve({ "models.pulls": () => [progress] });
  const pushed: Array<SyncMetadata | undefined> = [];
  client.subscribe("models.pull", (_p, sync) => pushed.push(sync));
  server.push("models.pull", progress);
  let readSync: SyncMetadata | undefined;
  await client.call("models.pulls", {}, { onMetadata: (sync) => { readSync = sync; } });
  server.push("models.pull", { ...progress, completedBytes: 55 });
  await vi.waitFor(() => expect(pushed).toHaveLength(2));
  expect([revs(pushed[0]), revs(readSync), revs(pushed[1])]).toEqual([[["pulls", 1]], [["pulls", 2]], [["pulls", 3]]]);
});

it("every models push and read the window applies is numbered", async () => {
  const { server, client } = await serve({ "gpu.status": () => samples["gpu.status"].result, "fit.table": () => samples["fit.table"].result });
  const seen: Array<SyncMetadata | undefined> = [];
  for (const channel of ["gpu.changed", "fit.changed", "memory.changed", "models.speed", "models.measures", "models.measuring", "models.load", "models.suggested", "models.changed"] as const) {
    client.subscribe(channel, (_p: unknown, sync) => seen.push(sync));
  }
  server.push("gpu.changed", samples["gpu.status"].result);
  server.push("fit.changed", samples["fit.table"].result);
  server.push("memory.changed", samples["memory.status"].result);
  server.push("models.speed", []);
  server.push("models.measures", []);
  server.push("models.measuring", { model: "a", state: "running", done: 1, total: 4 });
  server.push("models.load", { model: "a", numCtx: 4096, state: "loading" });
  server.push("models.suggested", samples["models.suggested"].result);
  server.push("models.changed", []);
  await vi.waitFor(() => expect(seen).toHaveLength(9));
  expect(seen.map((sync) => revs(sync)?.[0]?.[0])).toEqual(["gpu", "fit-table", "memory", "speeds", "measures", "measures", "loads", "suggested", "models"]);
  let gpuSync: SyncMetadata | undefined;
  await client.call("gpu.status", {}, { onMetadata: (sync) => { gpuSync = sync; } });
  expect(revs(gpuSync)).toEqual([["gpu", 2]]);
});
