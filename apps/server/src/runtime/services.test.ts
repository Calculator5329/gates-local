// createModelServices wired end to end with fakes: a fake `ollama` binary in
// the data dir, fake Ollama HTTP servers, fake nvidia-smi and meminfo. The
// GPU watcher is stopped at once so nothing reads systemd or the real GPU.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { json, startFakeServer, type FakeServer } from "../fit/fake-http.ts";
import { httpGet } from "./http.ts";
import { appModelsDir, installedBinary } from "./paths.ts";
import { createModelServices, type ModelServices } from "./services.ts";
import { freePort, freePortRun, removeDir, tmpDir, writeFakeBinary } from "./test-fakes.ts";

const VERSION = "9.9.9-services";
const manifest = { version: VERSION, url: "http://127.0.0.1:1/never", sha256: "0".repeat(64), sizeBytes: 1, format: "tar.zst", verified: true, source: "test" } as const;
const SHOW = JSON.parse(readFileSync(new URL("../fit/fixtures/show-qwen3-5-9b.json", import.meta.url), "utf8")) as unknown;
const fit = {
  runNvidiaSmi: async (args: readonly string[]) => (args[0]?.startsWith("--query-gpu") ? "16303, 1303, 15000\n" : ""),
  readMeminfo: async () => "MemAvailable: 30000000 kB\n",
};

let work: string;
const open: ModelServices[] = [];
const servers: FakeServer[] = [];
beforeEach(() => {
  work = tmpDir("services");
});
afterEach(async () => {
  for (const s of open.splice(0)) await s.close({ stopRuntime: true });
  for (const s of servers.splice(0)) await s.close();
  removeDir(work);
});

const nothingAt = async () => `http://127.0.0.1:${await freePort()}`;
/** The fake binary's OLLAMA_MODELS. */
async function models(url: string): Promise<string | undefined> {
  const r = await httpGet(`${url}/fake/env`, 1000);
  return r.kind === "response" ? (JSON.parse(r.body) as { OLLAMA_MODELS: string }).OLLAMA_MODELS : undefined;
}

async function services(dataDir: string, runtime: Record<string, unknown>): Promise<ModelServices> {
  const home = path.join(work, "home");
  const s = await createModelServices({
    dataDir,
    push: () => undefined,
    runtime: { home, env: { PATH: "", HOME: home }, systemModelsDirs: [], allowInstall: false, probeTimeoutMs: 500, manifest, ...runtime },
    fit,
    log: () => undefined,
  });
  s.gpu.stop();
  open.push(s);
  return s;
}

it("S-08: two services with different data dirs run their own Ollama against their own models folder", async () => {
  const base = await freePortRun(2);
  const a = path.join(work, "instance-a");
  const b = path.join(work, "instance-b");
  for (const dir of [a, b]) writeFakeBinary(installedBinary(dir, VERSION));
  const external = await nothingAt();
  const sa = await services(a, { appPort: base, externalBaseUrl: external });
  const sb = await services(b, { appPort: base, externalBaseUrl: external });
  expect(sa.settings.get().runtimeMode).toBe("app");
  const ra = await sa.runtime.ensure();
  const rb = await sb.runtime.ensure();
  expect([ra.state, rb.state]).toEqual(["ready", "ready"]);
  expect(await models(ra.baseUrl)).toBe(appModelsDir(a));
  expect(await models(rb.baseUrl)).toBe(appModelsDir(b));
});

it("S-02: a preload's fit reads the URL the load captured, not whatever the runtime says later", async () => {
  // A system Ollama whose root stops answering like Ollama mid-load: the
  // runtime's next discover drops its base URL, but the load already chose it.
  let healthy = true;
  let releasePs!: () => void;
  const psHeld = new Promise<void>((r) => (releasePs = r));
  let firstPs = true;
  const ollama = await startFakeServer({
    "GET /": (_b, res) => {
      if (!healthy) return json(res, 500, { error: "down" });
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("Ollama is running");
    },
    "GET /api/version": (_b, res) => json(res, 200, { version: "0.0.9-fake" }),
    // Installed, so the fit goes on to /api/show (the request this test watches for).
    "GET /api/tags": (_b, res) => json(res, 200, { models: [{ name: "qwen3.5:9b", size: 6_600_000_000, digest: "d", modified_at: "2026-11-01T00:00:00Z" }] }),
    "GET /api/ps": async (_b, res) => {
      if (firstPs) {
        firstPs = false;
        await psHeld;
      }
      json(res, 200, { models: [] });
    },
    "POST /api/show": (_b, res) => json(res, 200, SHOW),
    "POST /api/generate": (b, res) => json(res, 200, { model: (b as { model: string }).model, response: "", done: true }),
  });
  servers.push(ollama);
  const s = await services(path.join(work, "data"), { appPort: await freePort(), externalBaseUrl: ollama.baseUrl });
  expect(s.settings.get().runtimeMode).toBe("system");
  expect((await s.runtime.ensure()).state).toBe("ready");
  const loading = s.loader.load("qwen3.5:9b", 16384);
  await new Promise((r) => setTimeout(r, 50));
  healthy = false;
  await s.runtime.discover();
  expect(s.runtime.baseUrl()).toBeUndefined();
  releasePs();
  const r = await loading;
  expect(ollama.requests.some((q) => q.path === "/api/show")).toBe(true);
  expect(r).toMatchObject({ state: "ready" });
});
