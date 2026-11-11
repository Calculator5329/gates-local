import { readFileSync } from "node:fs";
import type { CatalogEntry, FitReport } from "@gates-local/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { json, startFakeServer, type FakeServer } from "../fit/fake-http.ts";
import type { NvidiaSmiRunner } from "../fit/types.ts";
import { defaultSettings } from "../settings/store.ts";
import { buildCatalog, markRecommended } from "./catalog.ts";
import { listModels } from "./models.ts";
import { CURATED_MODELS } from "./recommended.ts";

const fitFixture = (name: string) => readFileSync(new URL(`../fit/fixtures/${name}`, import.meta.url), "utf8");
const GPU = fitFixture("nvidia-smi-gpu.machine.txt"); // 16303 total, 9468 MiB free
const APPS = fitFixture("nvidia-smi-apps.machine.txt");
const MEMINFO = fitFixture("meminfo.machine.txt");
const SHOW: Record<string, unknown> = {
  "qwen3.5:9b": JSON.parse(fitFixture("show-qwen3-5-9b.json")),
  "qwen3.8-abliterated:27b": JSON.parse(fitFixture("show-qwen3-8-abliterated-27b.json")),
  "hf.co/someone/Tiny-Chat-GGUF:Q4_K_M": { capabilities: ["completion"] },
  "nomic-embed-text:latest": { capabilities: ["embedding"] },
};
const TAGS = {
  models: [
    { name: "qwen3.5:9b", size: 6594474711, digest: "a", modified_at: "2026-11-01T00:00:00Z" },
    { name: "qwen3.8-abliterated:27b", size: 13210122027, digest: "c", modified_at: "2026-11-01T00:00:00Z" },
    { name: "hf.co/someone/Tiny-Chat-GGUF:Q4_K_M", size: 900000000, digest: "e", modified_at: "2026-11-01T00:00:00Z" },
    { name: "nomic-embed-text:latest", size: 274302450, digest: "d", modified_at: "2026-11-01T00:00:00Z", details: { family: "nomic-bert" } },
    // /api/show fails for this one (404 below): its capabilities are unknown (MP-01).
    { name: "search:latest", size: 600000000, digest: "f", modified_at: "2026-11-01T00:00:00Z", details: { family: "qwen3" } },
  ],
};

const smi: NvidiaSmiRunner = async (args) => (args[0]?.startsWith("--query-gpu") ? GPU : APPS);
const noNvidia: NvidiaSmiRunner = async () => {
  throw Object.assign(new Error("spawn nvidia-smi ENOENT"), { code: "ENOENT" });
};

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function fakeOllama(): Promise<FakeServer> {
  server = await startFakeServer({
    "GET /api/tags": (_b, res) => json(res, 200, TAGS),
    "GET /api/ps": (_b, res) => json(res, 200, { models: [] }),
    "POST /api/show": (body, res) => {
      const show = SHOW[(body as { model: string }).model];
      if (show) json(res, 200, show);
      else json(res, 404, { error: "not found" });
    },
  });
  return server;
}

const settings = { get: () => defaultSettings("system") };
const byName = (entries: readonly CatalogEntry[]) => new Map(entries.map((e) => [e.name, e]));

describe("models.catalog", () => {
  it("merges curated and installed models, with a fit for each and recommended from the fit", async () => {
    const s = await fakeOllama();
    const entries = await buildCatalog({
      baseUrl: () => s.baseUrl,
      installed: () => listModels(s.baseUrl),
      settings,
      fit: { runNvidiaSmi: smi, readMeminfo: async () => MEMINFO, now: () => 1 },
    });
    const e = byName(entries);

    // Installed curated: real size, measured-geometry estimate.
    expect(e.get("qwen3.5:9b")).toMatchObject({ label: "Qwen 3.5 9B", purpose: "Fast everyday answers", installed: true, downloadBytes: 6594474711 });
    expect(e.get("qwen3.5:9b")?.fit?.message).not.toMatch(/before download/);
    // Curated, pullable, not installed: the pre-download estimate.
    expect(e.get("gpt-oss:20b")).toMatchObject({ installed: false, downloadBytes: 13_793_441_566 });
    expect(e.get("gpt-oss:20b")?.fit).toMatchObject({ source: "estimate" });
    expect(e.get("gpt-oss:20b")?.fit?.message).toMatch(/rough estimate before download/);
    // A local build outside the curated list shows only because it is installed, as the user's own.
    expect(e.get("qwen3.8-abliterated:27b")).toMatchObject({ label: "qwen3.8-abliterated:27b", purpose: "Installed by you", installed: true });
    // The user's own model keeps its tag-derived name; embeddings stay out.
    expect(e.get("hf.co/someone/Tiny-Chat-GGUF:Q4_K_M")).toMatchObject({ label: "Tiny-Chat-GGUF:Q4_K_M", purpose: "Installed by you", installed: true });
    // Its /api/show gives no geometry and no maximum: a rough verdict at the safe fallback, and no recommendation.
    expect(e.get("hf.co/someone/Tiny-Chat-GGUF:Q4_K_M")?.fit).toMatchObject({ numCtx: 4096, source: "estimate" });
    expect(e.get("hf.co/someone/Tiny-Chat-GGUF:Q4_K_M")?.recommended).toBe(false);
    expect(e.has("nomic-embed-text:latest")).toBe(false);
    // A model whose capabilities are unknown is neither listed nor recommended until discovery succeeds.
    expect(e.has("search:latest")).toBe(false);

    for (const entry of entries) expect(entry.purpose.split(" ").length).toBeLessThanOrEqual(4);
    expect(entries.filter((x) => x.recommended).map((x) => x.name)).toEqual(entries.filter((x) => x.fit?.verdict === "fits" && x.fit.numCtx === 16384).map((x) => x.name));
    expect(e.get("qwen3.5:9b")?.recommended).toBe(true);
  });

  it("with no NVIDIA GPU, plans in system memory and recommends the lightest that runs", async () => {
    const s = await fakeOllama();
    const entries = await buildCatalog({
      baseUrl: () => s.baseUrl,
      installed: () => listModels(s.baseUrl),
      settings,
      fit: { runNvidiaSmi: noNvidia, readMeminfo: async () => MEMINFO, now: () => 1 },
    });
    expect(entries.some((x) => x.fit?.verdict === "fits")).toBe(false);
    const recommended = entries.filter((x) => x.recommended);
    expect(recommended.map((x) => x.name)).toEqual(["qwen3.5:4b"]);
  });

  it("MP-01: an installed curated model whose capabilities are unknown is neither a chat choice nor a download", async () => {
    const s = await fakeOllama();
    const unknownQwen = (await listModels(s.baseUrl)).map((m) => (m.name === "qwen3.5:9b" ? { ...m, capabilities: ["unknown"] } : m));
    const entries = await buildCatalog({
      baseUrl: () => s.baseUrl,
      installed: async () => unknownQwen,
      settings,
      fit: { runNvidiaSmi: smi, readMeminfo: async () => MEMINFO, now: () => 1 },
    });
    expect(entries.map((x) => x.name)).not.toContain("qwen3.5:9b");
    // Curated models that are not installed are still offered.
    expect(byName(entries).get("gpt-oss:20b")?.installed).toBe(false);
  });

  it("while the runtime is down, lists only what can be downloaded, without a fit", async () => {
    const entries = await buildCatalog({ baseUrl: () => undefined, installed: async () => [], settings });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((x) => !x.installed && x.fit === undefined && !x.recommended)).toBe(true);
    // Every curated model can be downloaded, so all of them list.
    expect(entries.map((x) => x.name)).toEqual(CURATED_MODELS.map((m) => m.name));
    expect(CURATED_MODELS.every((m) => m.pullable)).toBe(true);
  });
});

const fit = (verdict: FitReport["verdict"], need: number): FitReport => ({
  model: "m",
  numCtx: 16384,
  freeVramBytes: 0,
  needVramBytes: need,
  spillRamBytes: 0,
  verdict,
  source: "estimate",
  measuredAt: 0,
});
const entry = (name: string, f?: FitReport): CatalogEntry => ({ name, label: name, purpose: "p", downloadBytes: 1, installed: false, recommended: false, ...(f ? { fit: f } : {}) });

describe("markRecommended", () => {
  it("recommends every model that fits, and nothing else", () => {
    const out = markRecommended([entry("a", fit("fits", 5)), entry("b", fit("spills", 1)), entry("c", fit("fits", 9)), entry("d")], 16384);
    expect(out.map((e) => e.recommended)).toEqual([true, false, true, false]);
  });

  it("when nothing fits, recommends only the lightest that spills; a refusal never", () => {
    const out = markRecommended([entry("a", fit("spills", 9)), entry("b", fit("refuse", 1)), entry("c", fit("spills", 4))], 16384);
    expect(out.map((e) => e.recommended)).toEqual([false, false, true]);
  });

  it("never recommends a model that cannot hold the default context, whatever its verdict", () => {
    const small = { ...fit("spills", 1), numCtx: 2048 };
    const out = markRecommended([entry("tiny", small), entry("a", fit("spills", 4))], 16384);
    expect(out.map((e) => e.recommended)).toEqual([false, true]);
    expect(markRecommended([entry("tiny", { ...fit("fits", 1), numCtx: 2048 }), entry("a", fit("spills", 4))], 16384).map((e) => e.recommended)).toEqual([false, true]);
  });
});
