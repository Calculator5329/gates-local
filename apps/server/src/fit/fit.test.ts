import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { GIB, MIB, RAM_SAFETY_MARGIN_BYTES, RUNTIME_OVERHEAD_BYTES, VRAM_SAFETY_MARGIN_BYTES } from "./constants.ts";
import { checkNumCtx, estimateKvCache, parseArchInfo } from "./estimate.ts";
import { json, startFakeServer, type FakeServer } from "./fake-http.ts";
import { checkFit, checkModels, decideFit, measuredFit } from "./fit.ts";
import { GPU_APPS_ARGS, GPU_TOTALS_ARGS, parseComputeApps, parseGpuTotals, parseMemAvailable, readGpu } from "./gpu.ts";
import type { NvidiaSmiRunner } from "./types.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const showFixture = (name: string) => JSON.parse(fixture(name)) as { model_info: Record<string, unknown>; capabilities: string[] };

const MACHINE_GPU = fixture("nvidia-smi-gpu.machine.txt"); // 16303, 6458, 9468
const MACHINE_APPS = fixture("nvidia-smi-apps.machine.txt");
const MACHINE_MEMINFO = fixture("meminfo.machine.txt"); // MemAvailable 14822112 kB
const SHOW: Record<string, ReturnType<typeof showFixture>> = {
  "qwen3.5:9b": showFixture("show-qwen3-5-9b.json"),
  "gemma4-abliterated:26b": showFixture("show-gemma4-abliterated-26b.json"),
  "qwen3.8-abliterated:27b": showFixture("show-qwen3-8-abliterated-27b.json"),
  "nomic-embed-text:latest": { model_info: { "general.architecture": "nomic-bert" }, capabilities: ["embedding"] },
};
const TAGS = {
  models: [
    { name: "qwen3.5:9b", size: 6594474711, digest: "a" },
    { name: "gemma4-abliterated:26b", size: 17990843601, digest: "b" },
    { name: "qwen3.8-abliterated:27b", size: 13210122027, digest: "c" },
    { name: "nomic-embed-text:latest", size: 274302450, digest: "d" },
  ],
};

function smi(gpu: string, apps: string): NvidiaSmiRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = async (args: readonly string[]) => {
    calls.push([...args]);
    return args[0]?.startsWith("--query-gpu") ? gpu : apps;
  };
  return Object.assign(run, { calls });
}

const failing: NvidiaSmiRunner = async () => {
  throw new Error("spawn nvidia-smi ENOENT");
};

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function fakeOllama(ps: unknown = { models: [] }): Promise<FakeServer> {
  server = await startFakeServer({
    "GET /api/tags": (_b, res) => json(res, 200, TAGS),
    "GET /api/ps": (_b, res) => json(res, 200, ps),
    "POST /api/show": (body, res) => {
      const model = (body as { model: string }).model;
      const show = SHOW[model];
      if (show) json(res, 200, show);
      else json(res, 404, { error: `model '${model}' not found` });
    },
  });
  return server;
}

describe("nvidia-smi parsing", () => {
  it("reads this machine's totals in bytes", () => {
    const totals = parseGpuTotals(MACHINE_GPU);
    expect(totals.totalBytes).toBe(16303 * MIB);
    expect(totals.freeBytes).toBe(9468 * MIB);
    expect(totals.gpuCount).toBe(1);
  });

  it("names the tenants with whisper as the permanent one", () => {
    const tenants = parseComputeApps(MACHINE_APPS);
    expect(tenants).toHaveLength(13);
    const whisper = tenants.filter((t) => t.permanent);
    expect(whisper).toEqual([
      expect.objectContaining({ pid: 5100, label: "whisper-server", role: "whisper", usedBytes: 2202 * MIB }),
    ]);
    expect(tenants.find((t) => t.pid === 5400)).toMatchObject({
      label: "media-vault vision runtime",
      role: "occupant",
      permanent: false,
      usedBytes: 1822 * MIB,
    });
    expect(tenants.find((t) => t.pid === 4400)?.label).toBe("browser");
  });

  it("survives commas in names, [N/A] memory, blank and junk lines", () => {
    const tenants = parseComputeApps(
      [
        "No running processes found",
        "",
        "77, /opt/app --flag=a,b,c, 300",
        "78, /usr/local/bin/ollama, [N/A]",
        "pid, process_name, used_gpu_memory",
      ].join("\n"),
    );
    expect(tenants).toHaveLength(2);
    expect(tenants[0]).toMatchObject({ pid: 77, processName: "/opt/app --flag=a,b,c", usedBytes: 300 * MIB });
    expect(tenants[1]).toMatchObject({ pid: 78, role: "ollama" });
    expect(tenants[1]?.usedBytes).toBeUndefined();
  });

  it("refuses output with no memory line, and a runner failure, by code", async () => {
    expect(() => parseGpuTotals("NVIDIA-SMI has failed\n")).toThrow(/no GPU memory line/);
    await expect(readGpu(failing)).rejects.toMatchObject({ code: "gpu-unreadable" });
  });

  it("only ever runs the two query commands", async () => {
    const run = smi(MACHINE_GPU, MACHINE_APPS);
    await readGpu(run);
    expect(run.calls.map((c) => c.join(" ")).toSorted()).toEqual([GPU_APPS_ARGS.join(" "), GPU_TOTALS_ARGS.join(" ")].toSorted());
  });

  it("reads MemAvailable", () => {
    expect(parseMemAvailable(MACHINE_MEMINFO)).toBe(14822112 * 1024);
    expect(() => parseMemAvailable("MemTotal: 1 kB")).toThrow(/MemAvailable/);
  });
});

describe("need estimate", () => {
  it("counts only attention layers of a hybrid model (per-layer head_count_kv)", () => {
    const arch = parseArchInfo("qwen3.5:9b", SHOW["qwen3.5:9b"]?.model_info);
    const kv = estimateKvCache(arch, 16384);
    // 8 attention layers x 4 kv heads x (256 + 256) x 16384 tokens x 2 bytes
    expect(kv.layers).toBe(8);
    expect(kv.bytes).toBe(8 * 4 * 512 * 16384 * 2);
    expect(arch.contextLength).toBe(262144);
  });

  it("applies full_attention_interval to a scalar head_count_kv", () => {
    const arch = parseArchInfo("qwen3.8-abliterated:27b", SHOW["qwen3.8-abliterated:27b"]?.model_info);
    const kv = estimateKvCache(arch, 16384);
    expect(kv.layers).toBe(16); // 64 blocks, one in four
    expect(kv.bytes).toBe(16 * 4 * 512 * 16384 * 2);
  });

  it("caps sliding-window layers at window + one batch", () => {
    const arch = parseArchInfo("gemma4-abliterated:26b", SHOW["gemma4-abliterated:26b"]?.model_info);
    const kv = estimateKvCache(arch, 32768);
    const swa = 25 * 8 * (256 + 256) * (1024 + 512) * 2;
    const full = 5 * 2 * (512 + 512) * 32768 * 2;
    expect(kv.bytes).toBe(swa + full);
  });

  it("derives head dim from embedding_length when key_length is absent", () => {
    const arch = parseArchInfo("llama", {
      "general.architecture": "llama",
      "llama.block_count": 32,
      "llama.context_length": 131072,
      "llama.embedding_length": 4096,
      "llama.attention.head_count": 32,
      "llama.attention.head_count_kv": 8,
    });
    expect(estimateKvCache(arch, 16384).bytes).toBe(32 * 8 * (128 + 128) * 16384 * 2);
  });

  it("refuses incomplete model_info by code", () => {
    expect(() => parseArchInfo("x", {})).toThrow(expect.objectContaining({ code: "model-info-incomplete" }));
    expect(() => parseArchInfo("x", { "general.architecture": "a", "a.block_count": 2 })).toThrow(/context_length/);
  });

  it("refuses num_ctx below 8192 and above the model's context_length", () => {
    expect(checkNumCtx("m", 16384, 32768)).toEqual({ ok: true });
    expect(checkNumCtx("m", 8191)).toMatchObject({ ok: false, message: expect.stringContaining("below the 8192 floor") });
    expect(checkNumCtx("m", 8192).ok).toBe(true);
    expect(checkNumCtx("m", 8192.5).ok).toBe(false);
    expect(checkNumCtx("m", 65536, 32768)).toMatchObject({ ok: false, message: expect.stringContaining("context_length 32768") });
  });
});

describe("decideFit", () => {
  const base = { model: "m", numCtx: 16384, measuredAt: 1 };
  const free = 10 * GIB;
  const mem = 8 * GIB;

  it("fits at exactly free minus the margin", () => {
    const r = decideFit({ ...base, needBytes: free - VRAM_SAFETY_MARGIN_BYTES, freeVramBytes: free, memAvailableBytes: mem });
    expect(r).toMatchObject({ verdict: "fits", spillRamBytes: 0, source: "estimate" });
    expect(r.shortfallBytes).toBeUndefined();
  });

  it("spills one byte over the margin, and shows the spill", () => {
    const r = decideFit({ ...base, needBytes: free - VRAM_SAFETY_MARGIN_BYTES + 1, freeVramBytes: free, memAvailableBytes: mem });
    expect(r).toMatchObject({ verdict: "spills", spillRamBytes: 1 });
    expect(r.message).toContain("spills 1 bytes");
  });

  it("refuses past RAM minus its margin and names the shortfall", () => {
    const usable = free - VRAM_SAFETY_MARGIN_BYTES + (mem - RAM_SAFETY_MARGIN_BYTES);
    const r = decideFit({ ...base, needBytes: usable + 5e9, freeVramBytes: free, memAvailableBytes: mem });
    expect(r).toMatchObject({ verdict: "refuse", shortfallBytes: 5e9, spillRamBytes: 0 });
    expect(r.message).toContain("short by 5,000,000,000 bytes (5.00 GB)");
  });
});

describe("checkFit against a fake Ollama and this machine's GPU layout", () => {
  it("qwen3.5:9b at 16k fits beside whisper and the vision runtime", async () => {
    const s = await fakeOllama();
    const run = smi(MACHINE_GPU, MACHINE_APPS);
    const check = await checkFit({ baseUrl: s.baseUrl, model: "qwen3.5:9b", numCtx: 16384, runNvidiaSmi: run, readMeminfo: async () => MACHINE_MEMINFO });
    const need = 6594474711 + 8 * 4 * 512 * 16384 * 2 + RUNTIME_OVERHEAD_BYTES;
    expect(check.estimate?.totalBytes).toBe(need);
    expect(check.report).toMatchObject({ verdict: "fits", needVramBytes: need, freeVramBytes: 9468 * MIB, spillRamBytes: 0, source: "estimate" });
    expect(check.gpu?.tenants.find((t) => t.permanent)?.pid).toBe(5100);
  });

  it("gemma4 26b at 16k spills to RAM and shows how much", async () => {
    const s = await fakeOllama();
    const check = await checkFit({
      baseUrl: s.baseUrl,
      model: "gemma4-abliterated:26b",
      numCtx: 16384,
      runNvidiaSmi: smi(MACHINE_GPU, MACHINE_APPS),
      readMeminfo: async () => MACHINE_MEMINFO,
    });
    const need = check.estimate?.totalBytes ?? 0;
    expect(check.report.verdict).toBe("spills");
    expect(check.report.spillRamBytes).toBe(need - (9468 * MIB - VRAM_SAFETY_MARGIN_BYTES));
  });

  it("refuses below the floor before any request or nvidia-smi run", async () => {
    const s = await fakeOllama();
    const run = smi(MACHINE_GPU, MACHINE_APPS);
    const check = await checkFit({ baseUrl: s.baseUrl, model: "qwen3.5:9b", numCtx: 4096, runNvidiaSmi: run, readMeminfo: async () => MACHINE_MEMINFO });
    expect(check.report).toMatchObject({ verdict: "refuse", numCtx: 4096 });
    expect(check.report.message).toContain("below the 8192 floor");
    // The floor is the product's limit, not the model's: no contextLimit.
    expect(check.report.contextLimit).toBeUndefined();
    expect(s.requests).toEqual([]);
    expect(run.calls).toEqual([]);
  });

  it("refuses num_ctx above the model's context_length", async () => {
    const s = await fakeOllama();
    const check = await checkFit({ baseUrl: s.baseUrl, model: "qwen3.5:9b", numCtx: 524288, runNvidiaSmi: smi(MACHINE_GPU, MACHINE_APPS), readMeminfo: async () => MACHINE_MEMINFO });
    expect(check.report.verdict).toBe("refuse");
    expect(check.report.message).toContain("context_length 262144");
    // The client words this "Supports up to 256k context" from the number, not the message.
    expect(check.report.contextLimit).toBe(262144);
  });

  it("a model missing from /api/tags is an error by code, not a verdict", async () => {
    const s = await fakeOllama();
    await expect(
      checkFit({ baseUrl: s.baseUrl, model: "nope:1b", numCtx: 16384, runNvidiaSmi: smi(MACHINE_GPU, MACHINE_APPS), readMeminfo: async () => MACHINE_MEMINFO }),
    ).rejects.toMatchObject({ code: "model-not-found" });
  });

  it("an unreachable runtime is an error by code", async () => {
    await expect(
      checkFit({ baseUrl: "http://127.0.0.1:1", model: "qwen3.5:9b", numCtx: 16384, runNvidiaSmi: smi(MACHINE_GPU, MACHINE_APPS), readMeminfo: async () => MACHINE_MEMINFO }),
    ).rejects.toMatchObject({ code: "runtime-unreachable" });
  });

  it("uses the measured /api/ps report when the model is already loaded at that num_ctx", async () => {
    const s = await fakeOllama({ models: [{ name: "qwen3.5:9b", model: "qwen3.5:9b", size: 8_400_000_000, size_vram: 8_400_000_000, context_length: 16384 }] });
    const check = await checkFit({ baseUrl: s.baseUrl, model: "qwen3.5:9b", numCtx: 16384, runNvidiaSmi: smi(MACHINE_GPU, MACHINE_APPS), readMeminfo: async () => MACHINE_MEMINFO });
    expect(check.report).toMatchObject({ source: "measured", verdict: "fits", needVramBytes: 8_400_000_000, spillRamBytes: 0 });
    expect(s.requests.some((r) => r.path === "/api/show")).toBe(false);
  });

  it("a copy loaded at another num_ctx is estimated with its VRAM counted as reclaimable", async () => {
    const s = await fakeOllama({ models: [{ name: "qwen3.5:9b", size: 8e9, size_vram: 8e9, context_length: 4096 }] });
    const check = await checkFit({ baseUrl: s.baseUrl, model: "qwen3.5:9b", numCtx: 16384, runNvidiaSmi: smi(MACHINE_GPU, MACHINE_APPS), readMeminfo: async () => MACHINE_MEMINFO });
    expect(check.report).toMatchObject({ source: "estimate", freeVramBytes: 9468 * MIB + 8e9 });
    expect(check.report.message).toContain("Ollama replaces");
  });
});

describe("measuredFit", () => {
  it("reports size vs size_vram and the spill", async () => {
    const s = await fakeOllama({ models: [{ name: "gemma4-abliterated:26b", size: 20e9, size_vram: 9e9, context_length: 16384 }] });
    const check = await measuredFit({ baseUrl: s.baseUrl, model: "gemma4-abliterated:26b", numCtx: 16384, runNvidiaSmi: smi(MACHINE_GPU, MACHINE_APPS) });
    expect(check.report).toMatchObject({ source: "measured", verdict: "spills", needVramBytes: 20e9, spillRamBytes: 11e9 });
  });

  it("counts the runner's nvidia-smi memory when /api/ps understates it (this machine, qwen3.5:9b at 16k)", async () => {
    // Recorded 2026-11-07: /api/ps size = size_vram = 5.92 GB; nvidia-smi showed the runner at 6926 MiB.
    const s = await fakeOllama({ models: [{ name: "qwen3.5:9b", size: 5_920_000_000, size_vram: 5_920_000_000, context_length: 16384 }] });
    const loadedApps = `${MACHINE_APPS}5800, /usr/lib/ollama/llama-server, 6926\n`;
    const check = await measuredFit({ baseUrl: s.baseUrl, model: "qwen3.5:9b", numCtx: 16384, runNvidiaSmi: smi("16303, 13368, 2557\n", loadedApps) });
    expect(check.report).toMatchObject({ source: "measured", verdict: "fits", needVramBytes: 6926 * MIB, spillRamBytes: 0, freeVramBytes: 2557 * MIB });
    expect(check.report.message).toContain("runner holds 7.26 GB");
  });

  it("does not attribute runner memory when two models are loaded", async () => {
    const s = await fakeOllama({
      models: [
        { name: "qwen3.5:9b", size: 5e9, size_vram: 5e9 },
        { name: "gemma4:12b", size: 4e9, size_vram: 4e9 },
      ],
    });
    const loadedApps = `${MACHINE_APPS}11, /usr/lib/ollama/llama-server, 6000\n12, /usr/lib/ollama/llama-server, 5000\n`;
    const check = await measuredFit({ baseUrl: s.baseUrl, model: "qwen3.5:9b", numCtx: 16384, runNvidiaSmi: smi(MACHINE_GPU, loadedApps) });
    expect(check.report.needVramBytes).toBe(5e9);
  });

  it("is an error when nothing is loaded", async () => {
    const s = await fakeOllama();
    await expect(measuredFit({ baseUrl: s.baseUrl, model: "qwen3.5:9b", numCtx: 16384, runNvidiaSmi: smi(MACHINE_GPU, MACHINE_APPS) })).rejects.toMatchObject({ code: "not-loaded" });
  });
});

describe("checkModels", () => {
  it("skips embedding models and ranks fits before spills", async () => {
    const s = await fakeOllama();
    const result = await checkModels({ baseUrl: s.baseUrl, numCtx: 16384, runNvidiaSmi: smi(MACHINE_GPU, MACHINE_APPS), readMeminfo: async () => MACHINE_MEMINFO });
    expect(result.checks.map((c) => c.report.model)).not.toContain("nomic-embed-text:latest");
    expect(result.runnable[0]).toMatchObject({ model: "qwen3.5:9b", verdict: "fits" });
    expect(result.refusal).toBeUndefined();
  });

  it("when no model fits 16k, the refusal names the shortfall in bytes and GB", async () => {
    const s = await fakeOllama();
    // A crowded card: 13303 MiB used, 3000 MiB free; 4 GB RAM available.
    const lowGpu = "16303, 13303, 3000\n";
    const lowMem = `MemAvailable:    ${4_000_000} kB\n`;
    const result = await checkModels({ baseUrl: s.baseUrl, numCtx: 16384, runNvidiaSmi: smi(lowGpu, MACHINE_APPS), readMeminfo: async () => lowMem });
    expect(result.runnable).toEqual([]);
    expect(result.checks.every((c) => c.report.verdict === "refuse")).toBe(true);

    // Closest is qwen3.5:9b: need minus usable VRAM minus usable RAM.
    const need = 6594474711 + 8 * 4 * 512 * 16384 * 2 + RUNTIME_OVERHEAD_BYTES;
    const shortfall = need - (3000 * MIB - VRAM_SAFETY_MARGIN_BYTES) - (4_000_000 * 1024 - RAM_SAFETY_MARGIN_BYTES);
    const closest = result.checks.find((c) => c.report.model === "qwen3.5:9b")?.report;
    expect(closest?.shortfallBytes).toBe(shortfall);
    const bytes = `${shortfall.toLocaleString("en-US")} bytes (${(shortfall / 1e9).toFixed(2)} GB)`;
    expect(result.refusal).toContain("No installed model fits num_ctx 16384");
    expect(result.refusal).toContain(`qwen3.5:9b, is short by ${bytes}`);
  });
});
