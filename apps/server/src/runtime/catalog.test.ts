import { readFileSync } from "node:fs";
import type { CatalogEntry, FitReport } from "@gates-local/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { json, startFakeServer, type FakeServer } from "../fit/fake-http.ts";
import type { NvidiaSmiRunner } from "../fit/types.ts";
import { defaultSettings } from "../settings/store.ts";
import { buildCatalog, estimateTyped, markRecommended } from "./catalog.ts";
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
    // A 16 GB card's tier (tiers.ts); Gemma 4 12B is not one of its picks.
    expect(picks(entries)).toEqual(["qwen3.5:9b", "qwen3:14b", "gpt-oss:20b"]);
    expect(e.get("gemma4:12b")?.recommended).toBe(false);
  });

  it("with no NVIDIA GPU, plans in system memory and recommends the system tier's picks", async () => {
    const s = await fakeOllama();
    const entries = await buildCatalog({
      baseUrl: () => s.baseUrl,
      installed: () => listModels(s.baseUrl),
      settings,
      fit: { runNvidiaSmi: noNvidia, readMeminfo: async () => MEMINFO, now: () => 1 },
    });
    expect(entries.some((x) => x.fit?.verdict === "fits")).toBe(false);
    // The fixture computer has 32 GB.
    expect(picks(entries)).toEqual(["gpt-oss:20b", "qwen3.5:9b", "gemma4:12b"]);
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

const MIB_PER_GB = 1024;
/** nvidia-smi totals for a card sold as `gb`: a little under the label, as real cards read, with 500 MiB in use. */
const card = (totalMib: number): NvidiaSmiRunner => async (args) => (args[0]?.startsWith("--query-gpu") ? `${totalMib}, 500, ${totalMib - 500}\n` : "");
/** /proc/meminfo for a computer with `totalGib` of memory, `availableGib` of it free right now. */
const meminfo = (totalGib: number, availableGib = totalGib / 2) => `MemTotal: ${Math.round(totalGib * 1024 * 1024)} kB\nMemAvailable: ${Math.round(availableGib * 1024 * 1024)} kB\n`;

async function catalogOn(runNvidiaSmi: NvidiaSmiRunner, mem: string) {
  server = await startFakeServer({
    "GET /api/tags": (_b, res) => json(res, 200, { models: [] }),
    "GET /api/ps": (_b, res) => json(res, 200, { models: [] }),
  });
  const s = server;
  return buildCatalog({ baseUrl: () => s.baseUrl, installed: async () => [], settings, fit: { runNvidiaSmi, readMeminfo: async () => mem, now: () => 1 } });
}
const picks = (entries: readonly CatalogEntry[]) =>
  entries
    .filter((e) => e.recommended)
    .toSorted((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    .map((e) => e.name);

describe("recommended by the computer's tier (row 21)", () => {
  // Cards read a little under their label (a "16 GB" card is 16303 MiB here); system memory too.
  const gpuTiers: [string, number, string[]][] = [
    ["4 GB card", 4 * MIB_PER_GB - 150, ["qwen3.5:4b"]],
    ["6 GB card", 6 * MIB_PER_GB - 150, ["qwen3.5:4b", "qwen3-vl:8b"]],
    ["8 GB card", 8 * MIB_PER_GB - 150, ["qwen3.5:9b", "qwen3.5:4b", "qwen3-vl:8b"]],
    ["12 GB card", 12 * MIB_PER_GB - 150, ["qwen3.5:9b", "gemma4:12b", "qwen3:14b"]],
    ["16 GB card", 16303, ["qwen3.5:9b", "qwen3:14b", "gpt-oss:20b"]],
    ["24 GB card", 24 * MIB_PER_GB - 150, ["mistral-small3.2:24b", "gpt-oss:20b", "qwen3:14b"]],
  ];
  for (const [label, totalMib, expected] of gpuTiers) {
    it(`a ${label} recommends its tier's picks, first pick first`, async () => {
      expect(picks(await catalogOn(card(totalMib), meminfo(31.25)))).toEqual(expected);
    });
  }

  const systemTiers: [string, number, string[]][] = [
    ["8 GB", 7.6, ["qwen3.5:4b"]],
    ["16 GB", 15.6, ["qwen3.5:4b", "qwen3.5:9b", "qwen3-vl:8b"]],
    ["32 GB", 31.25, ["gpt-oss:20b", "qwen3.5:9b", "gemma4:12b"]],
  ];
  for (const [label, totalGib, expected] of systemTiers) {
    it(`with no GPU and ${label} of memory, recommends that tier's picks`, async () => {
      expect(picks(await catalogOn(noNvidia, meminfo(totalGib)))).toEqual(expected);
    });
  }

  it("leaves out a pick the computer cannot run: 4 GB of memory and no GPU recommends nothing", async () => {
    const entries = await catalogOn(noNvidia, meminfo(3.8));
    expect(picks(entries)).toEqual([]);
    expect(byName(entries).get("qwen3.5:4b")?.fit?.verdict).toBe("refuse");
  });

  it("judges against the memory the computer has, not what other apps leave free (owner ruling)", async () => {
    // 16 GB with 1 GB free right now: the 9B still runs here.
    const entries = await catalogOn(noNvidia, meminfo(15.6, 1));
    expect(byName(entries).get("qwen3.5:9b")?.fit?.verdict).toBe("spills");
    expect(picks(entries)).toContain("qwen3.5:9b");
  });

  it("judges an installed pick the same way, not by what is free right now", async () => {
    const s = await fakeOllama();
    const entries = await buildCatalog({
      baseUrl: () => s.baseUrl,
      installed: () => listModels(s.baseUrl),
      settings,
      fit: { runNvidiaSmi: noNvidia, readMeminfo: async () => meminfo(15.6, 1), now: () => 1 },
    });
    expect(byName(entries).get("qwen3.5:9b")?.installed).toBe(true);
    expect(picks(entries)).toEqual(["qwen3.5:4b", "qwen3.5:9b", "qwen3-vl:8b"]);
  });
});

/** A registry that answers this download size for any name. */
const sizeOf = (bytes: number) => async () => ({ kind: "size" as const, bytes });

describe("a typed name before its download (row 22)", () => {
  const onCard = { runNvidiaSmi: card(16303), readMeminfo: async () => meminfo(31.25), now: () => 1 };
  const signal = new AbortController().signal;

  it("gives a registry name its size and the verdict the list's rows get", async () => {
    const out = await estimateTyped({ lookup: sizeOf(17_400_000_000), fit: onCard }, "gemma4:26b", 16384, signal);
    expect(out).toMatchObject({ name: "gemma4:26b", found: "yes", downloadBytes: 17_400_000_000 });
    expect(out.fit?.verdict).toBe("spills");
  });

  it("says too big for a name that needs more than the computer has", async () => {
    const out = await estimateTyped({ lookup: sizeOf(70_000_000_000), fit: onCard }, "llama4:70b", 16384, signal);
    expect(out.fit?.verdict).toBe("refuse");
  });

  it("a curated name needs no registry", async () => {
    const out = await estimateTyped({ fit: onCard }, "qwen3.5:4b", 16384, signal);
    expect(out).toMatchObject({ found: "yes", downloadBytes: 3_324_173_934 });
    expect(out.fit?.verdict).toBe("fits");
  });

  it("an unknown name says so, and an unreadable registry is not a no", async () => {
    expect(await estimateTyped({ lookup: async () => ({ kind: "missing" }), fit: onCard }, "nosuchmodel", 16384, signal)).toEqual({ name: "nosuchmodel:latest", found: "no" });
    expect(await estimateTyped({ lookup: async () => ({ kind: "unreadable" }), fit: onCard }, "gemma4:26b", 16384, signal)).toEqual({ name: "gemma4:26b", found: "unknown" });
    // With the registry off (tests, a pinned Ollama), nothing leaves the app.
    expect(await estimateTyped({ fit: onCard }, "gemma4:26b", 16384, signal)).toEqual({ name: "gemma4:26b", found: "unknown" });
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
  const tier = { by: "gpu" as const, gb: 8, picks: ["a:latest", "c:latest", "d:latest"] as [string, ...string[]] };

  it("recommends the tier's picks that run, ranked in the tier's order, and nothing else", () => {
    const out = markRecommended([entry("a", fit("spills", 5)), entry("b", fit("fits", 1)), entry("c", fit("fits", 9)), entry("d")], 16384, tier);
    expect(out.map((e) => [e.recommended, e.rank])).toEqual([
      [true, 0],
      [false, undefined],
      [true, 1],
      [false, undefined],
    ]);
  });

  it("never recommends a refusal", () => {
    const out = markRecommended([entry("a", fit("refuse", 9)), entry("c", fit("spills", 4))], 16384, tier);
    expect(out.map((e) => e.recommended)).toEqual([false, true]);
  });

  it("never recommends a model that cannot hold the default context, whatever its verdict", () => {
    const out = markRecommended([entry("a", { ...fit("fits", 1), numCtx: 2048 }), entry("c", fit("spills", 4))], 16384, tier);
    expect(out.map((e) => e.recommended)).toEqual([false, true]);
  });
});
