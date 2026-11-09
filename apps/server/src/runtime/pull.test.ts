import type { ServerResponse } from "node:http";
import type { PullProgress } from "@gates-local/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { json, startFakeServer, type FakeServer } from "../fit/fake-http.ts";
import { PULL_STOPPED_MESSAGE, createPullManager, plainPullError } from "./pull.ts";

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const line = (res: ServerResponse, v: unknown) => res.write(`${JSON.stringify(v)}\n`);
const tick = () => new Promise((r) => setTimeout(r, 5));

/** Waits until `pred` holds, polling the event loop (the fake server runs in this process). */
async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await tick();
  }
}

describe("models.pull", () => {
  it("AU-01 downloads pass admission before queuing or making a request", () => {
    const options = { baseUrl: () => undefined, push: () => undefined, admit: () => { throw Object.assign(new Error("Gates Local is closing to update."), { code: "update-installing" }); } };
    const manager = createPullManager(options);
    try {
      expect(() => manager.pull("test-model")).toThrow("closing to update");
      expect(manager.pending()).toHaveLength(0);
    } finally { manager.stop(); }
  });
  it("streams progress at most 4 times a second with a smoothed rate, then refreshes once done", async () => {
    let t = 0;
    server = await startFakeServer({
      "POST /api/pull": async (_b, res) => {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        line(res, { status: "pulling manifest" });
        // 20 lines, 50 ms of fake time apart: 1000 ms of downloading.
        for (let i = 1; i <= 20; i++) {
          t += 50;
          line(res, { status: "pulling aa", digest: "sha256:aa", total: 2000, completed: i * 100 });
          await tick();
        }
        line(res, { status: "verifying sha256 digest" });
        line(res, { status: "writing manifest" });
        line(res, { status: "success" });
        res.end();
      },
    });
    const pushes: PullProgress[] = [];
    const done: string[] = [];
    const m = createPullManager({ baseUrl: () => server?.baseUrl, push: (p) => pushes.push(p), onDone: (n) => void done.push(n), now: () => t });
    // Nothing else is downloading, so it starts at once.
    expect(m.pull("qwen3.5:9b").state).toBe("downloading");
    await until(() => done.length === 1);

    const downloading = pushes.filter((p) => p.state === "downloading");
    // One "started" push plus one per 250 ms of fake time over 1000 ms.
    expect(downloading.length).toBeLessThanOrEqual(1 + 4);
    expect(downloading.length).toBeGreaterThanOrEqual(3);
    for (const p of downloading.slice(2)) expect(p.bytesPerSecond).toBeCloseTo(2000, -2);
    expect(pushes.map((p) => p.state).filter((s, i, a) => s !== a[i - 1])).toEqual(["downloading", "verifying", "done"]);
    expect(pushes.at(-1)).toEqual({ name: "qwen3.5:9b", state: "done", completedBytes: 2000, totalBytes: 2000 });
    expect(done).toEqual(["qwen3.5:9b"]);
    expect(server.requests[0]?.body).toEqual({ model: "qwen3.5:9b", stream: true });
  });

  it("runs one download at a time; the rest wait as queued and a queued one can be withdrawn", async () => {
    const release = new Map<string, () => void>();
    server = await startFakeServer({
      "POST /api/pull": async (body, res) => {
        const name = (body as { model: string }).model;
        res.writeHead(200);
        await new Promise<void>((r) => release.set(name, r));
        line(res, { status: "success" });
        res.end();
      },
    });
    const pushes: PullProgress[] = [];
    const m = createPullManager({ baseUrl: () => server?.baseUrl, push: (p) => pushes.push(p) });
    m.pull("a");
    expect(m.pull("b").state).toBe("queued");
    m.pull("c");
    expect(m.pull("b").state).toBe("queued"); // the same job, not a second one
    await until(() => release.has("a"));
    expect(m.pending().map((p) => `${p.name}:${p.state}`)).toEqual(["a:downloading", "b:queued", "c:queued"]);
    expect(m.cancel("b")).toBe(true);
    expect(pushes.at(-1)).toMatchObject({ name: "b", state: "cancelled", message: "Download cancelled." });
    release.get("a")?.();
    await until(() => release.has("c"));
    expect(release.has("b")).toBe(false);
    release.get("c")?.();
    await until(() => m.pending().length === 0);
    expect(pushes.filter((p) => p.state === "done").map((p) => p.name)).toEqual(["a", "c"]);
    expect(m.cancel("a")).toBe(false);
  });

  it("cancel aborts the running request; pulling again starts a new request Ollama can resume", async () => {
    let aborted = 0;
    server = await startFakeServer({
      "POST /api/pull": async (_b, res, req) => {
        res.writeHead(200);
        line(res, { status: "pulling aa", digest: "sha256:aa", total: 1000, completed: 400 });
        req.socket.once("close", () => aborted++);
        await new Promise((r) => setTimeout(r, 10_000));
      },
    });
    const pushes: PullProgress[] = [];
    const m = createPullManager({ baseUrl: () => server?.baseUrl, push: (p) => pushes.push(p) });
    m.pull("big");
    await until(() => pushes.some((p) => p.completedBytes === 400));
    expect(m.cancel("big")).toBe(true);
    await until(() => pushes.at(-1)?.state === "cancelled");
    expect(pushes.at(-1)).toEqual({ name: "big", state: "cancelled", completedBytes: 400, totalBytes: 1000, message: "Download cancelled." });
    await until(() => aborted === 1);
    m.pull("big");
    await until(() => server?.requests.length === 2);
    m.stop();
  });

  it("R-10: stop() ends the running and the queued downloads with a terminal push each", async () => {
    server = await startFakeServer({
      "POST /api/pull": async (_b, res) => {
        res.writeHead(200);
        line(res, { status: "pulling aa", digest: "sha256:aa", total: 1000, completed: 100 });
        await new Promise((r) => setTimeout(r, 10_000));
      },
    });
    const pushes: PullProgress[] = [];
    const m = createPullManager({ baseUrl: () => server?.baseUrl, push: (p) => pushes.push(p) });
    m.pull("a");
    m.pull("b");
    await until(() => pushes.some((p) => p.name === "a" && p.completedBytes === 100));
    m.stop();
    await until(() => pushes.filter((p) => p.state === "cancelled").length === 2);
    const last = (name: string) => pushes.filter((p) => p.name === name).at(-1);
    expect(last("a")).toMatchObject({ state: "cancelled", message: PULL_STOPPED_MESSAGE });
    expect(last("b")).toMatchObject({ state: "cancelled", message: "Download stopped because the runtime changed." });
    expect(m.pending()).toEqual([]);
  });

  it("ends in error with Ollama's message in plain words", async () => {
    server = await startFakeServer({
      "POST /api/pull": (body, res) => {
        const name = (body as { model: string }).model;
        if (name === "nope:1b") return json(res, 500, { error: "pull model manifest: file does not exist" });
        res.writeHead(200);
        line(res, { status: "pulling aa", digest: "sha256:aa", total: 1000, completed: 10 });
        line(res, { error: "write /models/blobs/sha256-aa-partial: no space left on device" });
        res.end();
      },
    });
    const pushes: PullProgress[] = [];
    const m = createPullManager({ baseUrl: () => server?.baseUrl, push: (p) => pushes.push(p) });
    m.pull("nope:1b");
    m.pull("big:70b");
    await until(() => pushes.filter((p) => p.state === "error").length === 2);
    const errors = pushes.filter((p) => p.state === "error");
    expect(errors[0]).toMatchObject({ name: "nope:1b", message: 'Ollama has no model named "nope:1b". Check the name in the Ollama library.' });
    expect(errors[1]?.message).toMatch(/^Not enough disk space to download big:70b/);
    expect(errors[1]?.completedBytes).toBe(10);
  });

  it("with no runtime, errors at once without a request", async () => {
    const pushes: PullProgress[] = [];
    const m = createPullManager({ baseUrl: () => undefined, push: (p) => pushes.push(p) });
    m.pull("qwen3.5:9b");
    await until(() => pushes.length > 0);
    expect(pushes).toEqual([{ name: "qwen3.5:9b", state: "error", completedBytes: 0, message: "Ollama is not running, so nothing can be downloaded." }]);
  });
});

describe("plainPullError", () => {
  it("keeps an unrecognised message, prefixed with what failed", () => {
    expect(plainPullError("m", " unexpected EOF ")).toBe("Downloading m failed: unexpected EOF");
  });
});
