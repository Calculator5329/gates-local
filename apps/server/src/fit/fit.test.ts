import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { GIB, MIB, NUM_CTX_FLOOR, RAM_SAFETY_MARGIN_BYTES, RUNTIME_OVERHEAD_BYTES, VRAM_SAFETY_MARGIN_BYTES } from "./constants.ts";
import { checkNumCtx, estimateKvCache, parseArchInfo } from "./estimate.ts";
import { json, startFakeServer, type FakeServer } from "./fake-http.ts";
import { blockingModels, checkFit, checkModels, decideFit, measuredFit } from "./fit.ts";
import { GPU_APPS_ARGS, GPU_TOTALS_ARGS, parseComputeApps, parseGpuTotals, parseMemAvailable, readGpu, readMemAvailable } from "./gpu.ts";
import type { NvidiaSmiRunner } from "./types.ts";

/** Lets queued rejections surface as unhandled before a test looks. */
const settle = () => new Promise((r) => setTimeout(r, 30));
/** Work that fails a little after it starts. */
const late = <T,>() => new Promise<T>((_r, reject) => setTimeout(() => reject(new Error("late failure")), 10));

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
      expect.objectContaining({ pid: 428377, label: "whisper-server", role: "whisper", usedBytes: 2202 * MIB }),
    ]);
    expect(tenants.find((t) => t.pid === 2303957)).toMatchObject({
      label: "media-vault vision runtime",
      role: "occupant",
      permanent: false,
      usedBytes: 1822 * MIB,
    });
    expect(tenants.find((t) => t.pid === 4192851)?.label).toBe("chrome");
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

  it("refuses num_ctx below 16384 and above the model's context_length", () => {
    expect(checkNumCtx("m", 16384, 32768)).toEqual({ ok: true });
    expect(checkNumCtx("m", 16383)).toMatchObject({ ok: false, message: expect.stringContaining("below the 16384 floor") });
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
    expect(check.gpu?.tenants.find((t) => t.permanent)?.pid).toBe(428377);
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

  it("R2-02: an abort ends the check while nvidia-smi and meminfo never answer, and reaches both", async () => {
    const s = await fakeOllama();
    const seen: (AbortSignal | undefined)[] = [];
    const never = <T,>(signal: AbortSignal | undefined) => (seen.push(signal), new Promise<T>(() => {}));
    const controller = new AbortController();
    const reason = new Error("shutting down");
    const check = checkFit({
      baseUrl: s.baseUrl,
      model: "qwen3.5:9b",
      numCtx: 16384,
      runNvidiaSmi: (_args, signal) => never<string>(signal),
      readMeminfo: (signal) => never<string>(signal),
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    controller.abort(reason);
    await expect(check).rejects.toBe(reason);
    expect(Date.now() - started).toBeLessThan(500);
    // Two nvidia-smi runs and one meminfo read, each handed the check's signal.
    expect(seen).toHaveLength(3);
    expect(seen.every((sig) => sig?.aborted === true)).toBe(true);
  });

  describe("R3-03: an aborted read leaves no unhandled rejection", () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    const broken = { runs: 0, smi: (async () => {
      broken.runs++;
      throw new Error("nvidia-smi broke");
    }) as NvidiaSmiRunner, meminfo: async () => {
      broken.runs++;
      throw new Error("meminfo broke");
    } };
    afterEach(() => {
      process.off("unhandledRejection", onUnhandled);
      unhandled.length = 0;
      broken.runs = 0;
    });

    it("already aborted: both reads reject with the reason, start no work, and leave nothing unobserved", async () => {
      process.on("unhandledRejection", onUnhandled);
      const reason = new Error("gone");
      const signal = AbortSignal.abort(reason);
      await expect(readGpu(broken.smi, Date.now, signal)).rejects.toBe(reason);
      await expect(readMemAvailable(broken.meminfo, signal)).rejects.toBe(reason);
      await settle();
      expect(unhandled).toEqual([]);
      expect(broken.runs).toBe(0);
    });

    it("aborted while the work runs, which then fails: rejects with the reason, nothing unobserved", async () => {
      process.on("unhandledRejection", onUnhandled);
      const controller = new AbortController();
      const reason = new Error("gone");
      const gpu = readGpu(() => late<string>(), Date.now, controller.signal);
      const mem = readMemAvailable(() => late<string>(), controller.signal);
      controller.abort(reason);
      await expect(gpu).rejects.toBe(reason);
      await expect(mem).rejects.toBe(reason);
      await settle();
      expect(unhandled).toEqual([]);
    });
  });

  it("refuses below the floor before any request or nvidia-smi run", async () => {
    const s = await fakeOllama();
    const run = smi(MACHINE_GPU, MACHINE_APPS);
    const check = await checkFit({ baseUrl: s.baseUrl, model: "qwen3.5:9b", numCtx: 8192, runNvidiaSmi: run, readMeminfo: async () => MACHINE_MEMINFO });
    expect(check.report).toMatchObject({ verdict: "refuse", numCtx: 8192 });
    expect(check.report.message).toContain("below the 16384 floor");
    expect(s.requests).toEqual([]);
    expect(run.calls).toEqual([]);
  });

  it("refuses num_ctx above the model's context_length", async () => {
    const s = await fakeOllama();
    const check = await checkFit({ baseUrl: s.baseUrl, model: "qwen3.5:9b", numCtx: 524288, runNvidiaSmi: smi(MACHINE_GPU, MACHINE_APPS), readMeminfo: async () => MACHINE_MEMINFO });
    expect(check.report.verdict).toBe("refuse");
    expect(check.report.message).toContain("context_length 262144");
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

/** A 16303 MiB GPU with `freeMib` free and no compute apps listed. */
const gpuWith = (freeMib: number) => smi(`16303, ${16303 - freeMib}, ${freeMib}\n`, "");
const plenty = async () => "MemAvailable: 60000000 kB\n";
/** /api/ps with each model resident at 16k, wholly in VRAM. */
const resident = (models: { name: string; vram: number }[]) => ({ models: models.map((m) => ({ name: m.name, size: m.vram, size_vram: m.vram, context_length: 16384 })) });

describe("blockingModels: which busy resident models a load would push out", () => {
  const GEMMA = "gemma4-abliterated:26b";
  const QWEN27 = "qwen3.8-abliterated:27b";
  const QWEN9 = "qwen3.5:9b";

  it("none when the model fits beside them, is resident at this num_ctx, or is the busy model itself", async () => {
    const s = await fakeOllama(resident([{ name: QWEN27, vram: 2e9 }, { name: QWEN9, vram: 8e9 }]));
    const base = { baseUrl: s.baseUrl, numCtx: 16384, readMeminfo: plenty };
    expect(await blockingModels({ ...base, model: QWEN9, busy: [QWEN27], runNvidiaSmi: gpuWith(15000) })).toEqual([]);
    expect(await blockingModels({ ...base, model: QWEN9, busy: [QWEN27], runNvidiaSmi: gpuWith(500) })).toEqual([]);
    expect(await blockingModels({ ...base, model: QWEN27, busy: [QWEN27], runNvidiaSmi: gpuWith(500) })).toEqual([]);
  });

  it("the fewest, largest first, whose VRAM makes it fit; an idle resident model never counts", async () => {
    const s = await fakeOllama(resident([{ name: GEMMA, vram: 2e9 }, { name: QWEN27, vram: 12e9 }, { name: "idle:7b", vram: 14e9 }]));
    expect(await blockingModels({ baseUrl: s.baseUrl, model: QWEN9, numCtx: 16384, busy: [GEMMA, QWEN27], runNvidiaSmi: gpuWith(500), readMeminfo: plenty })).toEqual([QWEN27]);
  });

  it("all of them when the model only spills even with them gone; none when it refuses anyway", async () => {
    const s = await fakeOllama(resident([{ name: QWEN9, vram: 2e9 }, { name: QWEN27, vram: 3e9 }]));
    const base = { baseUrl: s.baseUrl, model: GEMMA, numCtx: 16384, busy: [QWEN9, QWEN27], runNvidiaSmi: gpuWith(1000) };
    expect(await blockingModels({ ...base, readMeminfo: plenty })).toEqual([QWEN27, QWEN9]);
    expect(await blockingModels({ ...base, readMeminfo: async () => "MemAvailable: 1000000 kB\n" })).toEqual([]);
  });

  it("the plan with them gone counts their VRAM as free (FitDeps.reclaim)", async () => {
    const s = await fakeOllama(resident([{ name: QWEN27, vram: 12e9 }]));
    const check = await checkFit({ baseUrl: s.baseUrl, model: QWEN9, numCtx: 16384, reclaim: [QWEN27], runNvidiaSmi: gpuWith(500), readMeminfo: plenty });
    expect(check.report).toMatchObject({ verdict: "fits", freeVramBytes: 500 * MIB + 12e9 });
    expect(check.report.message).toContain(`held by ${QWEN27}, whose turns stopped for this load`);
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
    const loadedApps = `${MACHINE_APPS}3006409, /usr/lib/ollama/llama-server, 6926\n`;
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
    const result = await checkModels({ baseUrl: s.baseUrl, numCtx: NUM_CTX_FLOOR, runNvidiaSmi: smi(lowGpu, MACHINE_APPS), readMeminfo: async () => lowMem });
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
