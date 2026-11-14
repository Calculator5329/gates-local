// gemma4's small files (E2B, E4B): a per-layer input table that the runtime keeps in system memory,
// and layers that share an earlier layer's KV cache. Pinned to the E2B file as the app's own Ollama
// (0.40.15) reads it: 4,587,156,505 bytes; a verbose /api/show gives per_layer_token_embd.weight as
// Q6_K [8960, 262144], so 1,926,758,400 bytes. On a 16 GB card another E2B build (same geometry, 3.63 GB
// file) held 2252 MiB at 16k while the old estimate said 4.97 GB.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { GIB, RUNTIME_OVERHEAD_BYTES } from "./constants.ts";
import { estimateKvCache, parseArchInfo } from "./estimate.ts";
import { json, startFakeServer, type FakeServer } from "./fake-http.ts";
import { checkFit } from "./fit.ts";
import type { NvidiaSmiRunner } from "./types.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const E2B = JSON.parse(fixture("show-gemma4-e2b.json")) as { model_info: Record<string, unknown>; capabilities: string[]; tensors: unknown[] };
const PLAIN = { model_info: E2B.model_info, capabilities: E2B.capabilities };
const FILE_BYTES = 4_587_156_505;
const TABLE_BYTES = 1_926_758_400; // 8960 * 262144 values in Q6_K blocks of 256 values, 210 bytes each
const MEMINFO = `MemTotal: ${32 * 1024 * 1024} kB\nMemAvailable: ${24 * 1024 * 1024} kB\n`;
const card: NvidiaSmiRunner = async (args) => (args[0]?.startsWith("--query-gpu") ? fixture("nvidia-smi-gpu.machine.txt") : fixture("nvidia-smi-apps.machine.txt"));
const noCard: NvidiaSmiRunner = async () => {
  throw Object.assign(new Error("spawn nvidia-smi ENOENT"), { code: "ENOENT" });
};

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** The runtime as it answered: the plain /api/show has no tensors, the verbose one has them. */
async function e2bRuntime(verbose: "answers" | "fails" = "answers"): Promise<FakeServer> {
  const digest = `e2b-${Math.random()}`; // a file of its own per test: the answer is kept per file
  server = await startFakeServer({
    "GET /api/tags": (_b, res) => json(res, 200, { models: [{ name: "gemma4:e2b", size: FILE_BYTES, digest }] }),
    "GET /api/ps": (_b, res) => json(res, 200, { models: [] }),
    "POST /api/show": (body, res) => {
      if ((body as { verbose?: boolean }).verbose !== true) return json(res, 200, PLAIN);
      if (verbose === "fails") return json(res, 500, { error: "busy" });
      return json(res, 200, E2B);
    },
  });
  return server;
}
const verboseAsks = (s: FakeServer) => s.requests.filter((r) => r.path === "/api/show" && (r.body as { verbose?: boolean } | undefined)?.verbose === true).length;
const needAt16k = async (s: FakeServer, runNvidiaSmi: NvidiaSmiRunner) =>
  (await checkFit({ baseUrl: s.baseUrl, model: "gemma4:e2b", numCtx: 16384, runNvidiaSmi, readMeminfo: async () => MEMINFO })).report;

describe("gemma4's small files: what the card really holds", () => {
  it("the layers that share an earlier layer's cache keep none: 15 of the E2B's 35 layers carry KV", () => {
    const arch = parseArchInfo("gemma4:e2b", E2B.model_info);
    const kv = estimateKvCache(arch, 16384);
    expect(kv.layers).toBe(15);
    // 3 full layers (512 + 512 values, one KV head, 16384 tokens, 2 bytes) and 12 sliding ones (256 + 256, 512 + 512 tokens)
    expect(kv.bytes).toBe(3 * 1024 * 16384 * 2 + 12 * 512 * 1024 * 2);
  });

  it("on a card, the E2B's per-layer table is not counted: 3.58 GB at 16k, where it said 5.52 GB", async () => {
    const s = await e2bRuntime();
    const report = await needAt16k(s, card);
    const kv = 3 * 1024 * 16384 * 2 + 12 * 512 * 1024 * 2;
    expect(report.needVramBytes).toBe(FILE_BYTES - TABLE_BYTES + kv + RUNTIME_OVERHEAD_BYTES);
    expect(report.needVramBytes / GIB).toBeCloseTo(3.58, 2);
    expect(report.message).toMatch(/per-layer table \(1\.93 GB\) stays in system memory/);
  });

  it("the verbose answer is asked once per file, and a file without the table never asks it", async () => {
    const s = await e2bRuntime();
    await needAt16k(s, card);
    await needAt16k(s, card);
    expect(verboseAsks(s)).toBe(1);
    await s.close();
    server = await startFakeServer({
      "GET /api/tags": (_b, res) => json(res, 200, { models: [{ name: "gemma4-abliterated:26b", size: 17990843601, digest: "b" }] }),
      "GET /api/ps": (_b, res) => json(res, 200, { models: [] }),
      "POST /api/show": (_b, res) => json(res, 200, JSON.parse(fixture("show-gemma4-abliterated-26b.json"))),
    });
    await checkFit({ baseUrl: server.baseUrl, model: "gemma4-abliterated:26b", numCtx: 16384, runNvidiaSmi: card, readMeminfo: async () => MEMINFO });
    expect(verboseAsks(server)).toBe(0);
  });

  it("with no card, or no verbose answer, the whole file still counts", async () => {
    const kv = 3 * 1024 * 16384 * 2 + 12 * 512 * 1024 * 2;
    const cpu = await e2bRuntime();
    expect((await needAt16k(cpu, noCard)).needVramBytes).toBe(FILE_BYTES + kv + RUNTIME_OVERHEAD_BYTES);
    expect(verboseAsks(cpu)).toBe(0);
    await cpu.close();
    const failing = await e2bRuntime("fails");
    expect((await needAt16k(failing, card)).needVramBytes).toBe(FILE_BYTES + kv + RUNTIME_OVERHEAD_BYTES);
  });
});
