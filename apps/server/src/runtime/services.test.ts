// createModelServices wiring: the GPU and memory readers main.ts injects (the
// E2E stack's fake nvidia-smi, the fixture meminfo) reach every survey,
// including models.catalog's fit, so no test ever reads this machine's GPU.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CatalogEntry } from "@gates-local/contracts";
import { afterEach, expect, it } from "vitest";
import { json, startFakeServer } from "../fit/fake-http.ts";
import type { NvidiaSmiRunner } from "../fit/types.ts";
import { createModelServices } from "./services.ts";
import { freePort } from "./test-fakes.ts";

const fixture = (name: string) => readFileSync(new URL(`../fit/fixtures/${name}`, import.meta.url), "utf8");
const MIB = 1024 * 1024;
const SHOW = JSON.parse(fixture("show-qwen3-5-9b.json")) as unknown;
const MEMINFO = fixture("meminfo.machine.txt");

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).toReversed()) await c();
});

it("models.catalog surveys with the injected nvidia-smi and meminfo, not the machine's", async () => {
  const ollama = await startFakeServer({
    "GET /": (_b, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("Ollama is running");
    },
    "GET /api/version": (_b, res) => json(res, 200, { version: "0.0.9-fake" }),
    "GET /api/tags": (_b, res) => json(res, 200, { models: [{ name: "qwen3.5:9b", size: 6594474711, digest: "a", modified_at: "2026-11-01T00:00:00Z" }] }),
    "GET /api/ps": (_b, res) => json(res, 200, { models: [] }),
    "POST /api/show": (_b, res) => json(res, 200, SHOW),
  });
  cleanups.push(() => ollama.close());
  const dir = mkdtempSync(path.join(os.tmpdir(), "gates-services-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  // A GPU no real card reports: 16000 MiB total, 4321 MiB free.
  const calls: string[][] = [];
  const runNvidiaSmi: NvidiaSmiRunner = async (args) => {
    calls.push([...args]);
    if (args[0] === "--query-compute-apps=pid,process_name,used_memory") return "";
    if (args[0]?.startsWith("--query-gpu=name")) return "Fake GPU, 16000, 11679, 4321\n";
    return "16000, 11679, 4321\n";
  };
  const services = await createModelServices({
    dataDir: dir,
    push: () => undefined,
    runtime: { externalBaseUrl: ollama.baseUrl, appPort: await freePort(), appDataDir: dir, allowInstall: false, env: { PATH: "" }, systemModelsDirs: [], probeTimeoutMs: 500 },
    fit: { runNvidiaSmi, readMeminfo: async () => MEMINFO },
  });
  cleanups.push(() => services.close({ stopRuntime: false }));
  expect((await services.runtime.discover()).state).toBe("ready");

  const catalog = services.handlers["models.catalog"];
  if (catalog === undefined) throw new Error("models.catalog is not wired");
  const entries = (await catalog({}, undefined as never)) as readonly CatalogEntry[];
  const qwen = entries.find((e) => e.name === "qwen3.5:9b");
  expect(qwen?.fit?.freeVramBytes).toBe(4321 * MIB);
  expect(calls.some((a) => a[0]?.startsWith("--query-gpu"))).toBe(true);
});

it("a refresh while no installed model can chat (an Ollama too old to say) takes no fit reading", async () => {
  const ollama = await startFakeServer({
    "GET /": (_b, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("Ollama is running");
    },
    "GET /api/version": (_b, res) => json(res, 200, { version: "0.1.0" }),
    "GET /api/tags": (_b, res) => json(res, 200, { models: [{ name: "qwen3.5:9b", size: 6594474711, digest: "a", modified_at: "2026-11-01T00:00:00Z" }] }),
    "GET /api/ps": (_b, res) => json(res, 200, { models: [] }),
    "POST /api/show": (_b, res) => json(res, 200, {}), // no capabilities field
  });
  cleanups.push(() => ollama.close());
  const dir = mkdtempSync(path.join(os.tmpdir(), "gates-services-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  let readings = 0;
  const runNvidiaSmi: NvidiaSmiRunner = async () => {
    readings++;
    return "16000, 11679, 4321\n";
  };
  const readMeminfo = async () => {
    readings++;
    return MEMINFO;
  };
  const services = await createModelServices({
    dataDir: dir,
    push: () => undefined,
    runtime: { externalBaseUrl: ollama.baseUrl, appPort: await freePort(), appDataDir: dir, allowInstall: false, env: { PATH: "" }, systemModelsDirs: [], probeTimeoutMs: 500 },
    fit: { runNvidiaSmi, readMeminfo },
  });
  cleanups.push(() => services.close({ stopRuntime: false }));
  expect((await services.runtime.discover()).state).toBe("ready");
  await services.catalog.refresh({ force: true });
  await services.catalog.refresh({ force: true }); // the retry: still nothing can chat
  expect(services.catalog.current()?.[0]?.capabilities).toContain("unreported");
  expect(readings).toBe(0);
});
