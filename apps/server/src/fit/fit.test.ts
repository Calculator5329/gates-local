import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GIB, MIB, RAM_SAFETY_MARGIN_BYTES, RUNTIME_OVERHEAD_BYTES, VRAM_SAFETY_MARGIN_BYTES } from "./constants.ts";
import { estimateKvCache, parseArchInfo } from "./estimate.ts";
import { json, startFakeServer, type FakeServer } from "./fake-http.ts";
import { blockingModels, checkFit, checkModels, decideFit, fitEach, measuredFit, planLoad } from "./fit.ts";
import { createNvidiaSmiRunner, forgetGpuReadings, GPU_APPS_ARGS, GPU_REUSE_MS, GPU_TOTALS_ARGS, parseComputeApps, parseGpuTotals, parseMemAvailable, parseMemTotal, readGpu, readMemAvailable, readNvidiaSmi } from "./gpu.ts";
import type { NvidiaSmiRunner } from "./types.ts";
import { readGpuStatus } from "./gpu-status.ts";

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

/** /api/show for a small chat model; with no `contextLength` it reports no maximum. */
const tinyShow = (contextLength?: number) => ({
  model_info: {
    "general.architecture": "tiny",
    "tiny.block_count": 4,
    "tiny.attention.head_count": 4,
    "tiny.attention.head_count_kv": 4,
    "tiny.attention.key_length": 64,
    "tiny.attention.value_length": 64,
    ...(contextLength === undefined ? {} : { "tiny.context_length": contextLength }),
  },
  capabilities: ["completion"],
});

async function oneModel(show: unknown, ps: unknown = { models: [] }): Promise<FakeServer> {
  server = await startFakeServer({
    "GET /api/tags": (_b, res) => json(res, 200, { models: [{ name: "tiny:2k", size: 500 * MIB, digest: "t" }] }),
    "GET /api/ps": (_b, res) => json(res, 200, ps),
    "POST /api/show": (_b, res) => json(res, 200, show),
  });
  return server;
}

const fitOf = async (s: FakeServer, model: string, numCtx: number) =>
  (await checkFit({ baseUrl: s.baseUrl, model, numCtx, runNvidiaSmi: smi(MACHINE_GPU, MACHINE_APPS), readMeminfo: async () => MACHINE_MEMINFO })).report;

const meminfo = (totalGib: number, freeGib: number) => async () => `MemTotal: ${Math.floor(totalGib * 1024 * 1024)} kB\nMemAvailable: ${Math.floor(freeGib * 1024 * 1024)} kB\n`;

describe("a send judges system memory by what the computer has (WIN-MEM-01, WIN-MEM-02)", () => {
  // docs/evidence/windows-low-memory-bug-report.md: a 6 GB card, 15.92 GiB of RAM, 3.7 GiB of it free at
  // the send. Every model that had to run partly in system memory was refused.
  const card = smi("6144, 4144, 2000\n", "");

  it("a model that fits this computer with part in system memory runs, though little is free right now", async () => {
    const s = await fakeOllama();
    const { report } = await checkFit({ baseUrl: s.baseUrl, model: "qwen3.5:9b", numCtx: 16384, runNvidiaSmi: card, readMeminfo: meminfo(15.92, 3.7) });
    expect(report.verdict).toBe("spills");
    expect(report.spillRamBytes).toBeGreaterThan(2 * GIB);
    expect(report.message).toContain("system RAM counts what this computer has");
  });

  it("a model this computer cannot hold at all is still refused", async () => {
    const s = await fakeOllama();
    const { report } = await checkFit({ baseUrl: s.baseUrl, model: "gemma4-abliterated:26b", numCtx: 16384, runNvidiaSmi: card, readMeminfo: meminfo(15.92, 3.7) });
    expect(report.verdict).toBe("refuse");
  });

  it("more free than the computer's own figure is never cut down to it", async () => {
    const s = await fakeOllama();
    const { report } = await checkFit({ baseUrl: s.baseUrl, model: "qwen3.5:9b", numCtx: 16384, runNvidiaSmi: card, readMeminfo: async () => "MemAvailable: 60000000 kB\n" });
    expect(report.verdict).toBe("spills");
    expect(report.message).not.toContain("system RAM counts");
  });
});

describe("a model's own context window", () => {
  it("runs a model that takes at most 2048 at 2048 when more is asked for: memory decides, nothing refuses", async () => {
    const report = await fitOf(await oneModel(tinyShow(2048)), "tiny:2k", 16384);
    expect(report).toMatchObject({ verdict: "fits", numCtx: 2048, source: "estimate" });
    expect(report.message).not.toMatch(/refused|context_length/);
  });

  it("never goes past the reported maximum, and never jumps up to it", async () => {
    const s = await fakeOllama();
    expect((await fitOf(s, "qwen3.5:9b", 524288)).numCtx).toBe(262144);
    expect(await fitOf(s, "qwen3.5:9b", 16384)).toMatchObject({ verdict: "fits", numCtx: 16384 });
  });

  it("falls back to 4096 when the model reports no maximum, and keeps a smaller ask", async () => {
    const s = await oneModel(tinyShow());
    expect(await fitOf(s, "tiny:2k", 16384)).toMatchObject({ verdict: "fits", numCtx: 4096 });
    expect((await fitOf(s, "tiny:2k", 2048)).numCtx).toBe(2048);
  });

  it("still gives a verdict for a model that reports no geometry at all", async () => {
    const report = await fitOf(await oneModel({ model_info: {}, capabilities: ["completion"] }), "tiny:2k", 16384);
    expect(report).toMatchObject({ verdict: "fits", numCtx: 4096, source: "estimate" });
  });

  it("counts a copy resident at the smaller size as measured", async () => {
    const ps = { models: [{ name: "tiny:2k", size: GIB, size_vram: GIB, context_length: 2048 }] };
    expect(await fitOf(await oneModel(tinyShow(2048), ps), "tiny:2k", 16384)).toMatchObject({ source: "measured", numCtx: 2048 });
  });
});

/** A runner whose runs wait until released, counting runs and keeping each run's signal. */
function held() {
  const signals: Array<AbortSignal | undefined> = [];
  const waiting: Array<() => void> = [];
  const run = ((args: readonly string[], signal?: AbortSignal) => {
    signals.push(signal);
    return new Promise<string>((resolve) => waiting.push(() => resolve(args[0]?.startsWith("--query-gpu") ? MACHINE_GPU : MACHINE_APPS)));
  }) as NvidiaSmiRunner;
  return { run, signals, release: () => { for (const go of waiting.splice(0)) go(); } };
}

describe("nvidia-smi parsing", () => {
  it("keeps stdout from the real runner's non-zero exit for classification", async () => {
    const run = createNvidiaSmiRunner(process.execPath, ["-e", 'process.stdout.write("No devices were found\\n"); process.exit(1)', "--"]);
    expect(await readNvidiaSmi(run, GPU_TOTALS_ARGS, parseGpuTotals)).toMatchObject({ kind: "none", detail: expect.stringContaining("nvidia-smi found no NVIDIA GPU") });
  });
  it.each([
    Object.assign(new Error("spawn nvidia-smi ENOENT"), { code: "ENOENT" }),
    Object.assign(new Error("Command failed"), { stdout: "No devices were found\n" }),
    Object.assign(new Error("Command failed"), { stderr: "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver. Make sure that the latest NVIDIA driver is installed and running." }),
    new Error("NVIDIA-SMI has failed because it couldn't communicate with Nvidia Driver"),
    new Error("NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver. Make sure that the latest NVIDIA driver is installed and running. This can also be happening if non-NVIDIA GPU is running as primary display, and NVIDIA GPU is in WDDM mode."),
    "No devices were found\n",
  ])("plans in system memory and agrees with status when no NVIDIA GPU is usable: %s", async (error) => {
    const s = await fakeOllama();
    let totalsReads = 0;
    const run: NvidiaSmiRunner = async (args) => { if (args[0]?.startsWith("--query-gpu")) totalsReads++; if (typeof error === "string") return error; throw error; };
    const missing = typeof error === "object" && "code" in error && error.code === "ENOENT";
    const status = await readGpuStatus({ runNvidiaSmi: run, readMeminfo: async () => MACHINE_MEMINFO });
    expect(totalsReads).toBe(missing ? 1 : 2);
    const check = await checkFit({ baseUrl: s.baseUrl, model: "qwen3.5:9b", numCtx: 16384, runNvidiaSmi: run, readMeminfo: async () => MACHINE_MEMINFO });
    expect(status.vendor).toBe("none");
    if (missing) expect(status.detail).toBeUndefined();
    else {
      const reason = typeof error === "string" || "stdout" in error ? "nvidia-smi found no NVIDIA GPU" : "nvidia-smi couldn't communicate with the NVIDIA driver";
      expect(status.detail).toBe(`${reason}. If this computer has an NVIDIA card, its driver is not answering: fix or reinstall the NVIDIA driver. Until then models run in system memory.`);
    }
    expect(check.report).toMatchObject({ verdict: "spills", freeVramBytes: 0 });
    expect(check.report.spillRamBytes).toBe(check.report.needVramBytes);
    expect(totalsReads).toBe(missing ? 2 : 4);
  });

  it.each(["fit", "status"])("%s refuses when no-device output is followed by a readable card", async (reader) => {
    let reads = 0;
    const run: NvidiaSmiRunner = async (args) => !args[0]?.startsWith("--query-gpu") ? MACHINE_APPS
      : ++reads === 1 ? "No devices were found\n" : args[0].includes("name,") ? `RTX, ${MACHINE_GPU}` : MACHINE_GPU;
    if (reader === "fit") await expect(readGpu(run)).rejects.toMatchObject({ code: "gpu-unreadable" });
    else expect((await readGpuStatus({ runNvidiaSmi: run, readMeminfo: async () => MACHINE_MEMINFO })).vendor).toBe("unreadable");
    expect(reads).toBe(2);
  });

  it.each([
    Object.assign(new Error("missing"), { code: "ENOENT" }),
    new Error("No devices were found"),
    new Error("NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver"),
  ])("distinguishes missing NVIDIA software from reported absence with resident VRAM: %s", async (error) => {
    const s = await fakeOllama({ models: [{ name: "resident", size: 5 * GIB, size_vram: 5 * GIB }] });
    const run: NvidiaSmiRunner = async () => { throw error; };
    const status = await readGpuStatus({ runNvidiaSmi: run, readMeminfo: async () => MACHINE_MEMINFO, residentModels: async () => [{ name: "resident", sizeVramBytes: 5 * GIB }] });
    if ("code" in error && error.code === "ENOENT") {
      expect(status.vendor).toBe("none");
      expect(status.detail).toBeUndefined();
      const deps = { baseUrl: s.baseUrl, model: "qwen3.5:9b", numCtx: 16384, runNvidiaSmi: run, readMeminfo: async () => MACHINE_MEMINFO };
      await expect(checkFit(deps)).resolves.toMatchObject({ gpu: { gpuCount: 0 }, report: { verdict: "spills" } });
      await expect(planLoad({ ...deps, busy: ["resident"], comfyPid: 999 })).resolves.toMatchObject({ stop: [], comfy: false, report: { verdict: "spills" } });
      await expect(measuredFit({ ...deps, model: "resident" })).resolves.toMatchObject({ gpu: { gpuCount: 0 }, report: { source: "measured", verdict: "fits" } });
      return;
    }
    expect(status.vendor).toBe("unreadable");
    expect(status.detail).toContain("Ollama reports a model in GPU memory");
    await expect(checkFit({ baseUrl: s.baseUrl, model: "qwen3.5:9b", numCtx: 16384, runNvidiaSmi: run, readMeminfo: async () => MACHINE_MEMINFO })).rejects.toMatchObject({ code: "gpu-unreadable", message: status.detail });
    await expect(measuredFit({ baseUrl: s.baseUrl, model: "resident", numCtx: 16384, runNvidiaSmi: run })).rejects.toMatchObject({ code: "gpu-unreadable", message: status.detail });
  });

  it.each([
    "garbled table",
    "Failed to initialize NVML: Unknown Error",
    "Failed to initialize NVML: Driver/library version mismatch",
    "Failed to initialize NVML: Insufficient Permissions",
    "Unable to determine the device handle for GPU 0000:01:00.0: Unknown Error",
    "The diagnostic contains No devices were found but does not establish GPU availability",
    "NVIDIA driver reported an unknown error",
  ])("retries %s once, then refuses with the same actionable words as status", async (failure) => {
    const s = await fakeOllama();
    let totalsReads = 0;
    const run: NvidiaSmiRunner = async (args) => {
      if (!args[0]?.startsWith("--query-gpu")) return MACHINE_APPS;
      totalsReads++;
      if (failure === "garbled table") return "GPU memory unavailable";
      throw new Error(failure);
    };
    const status = await readGpuStatus({ runNvidiaSmi: run, readMeminfo: async () => MACHINE_MEMINFO });
    expect(status.vendor).toBe("unreadable");
    expect(totalsReads).toBe(2);
    await expect(checkFit({ baseUrl: s.baseUrl, model: "qwen3.5:9b", numCtx: 16384, runNvidiaSmi: run, readMeminfo: async () => MACHINE_MEMINFO })).rejects.toMatchObject({ code: "gpu-unreadable", message: status.detail });
    expect(totalsReads).toBe(4);
    expect(status.detail).toMatch(/^Gates Local could not read GPU memory .*so it cannot check whether a model fits\. Try again\./);
  });

  it.each([
    { reader: "fit", query: "totals" }, { reader: "fit", query: "apps" },
    { reader: "status", query: "totals" }, { reader: "status", query: "apps" },
  ])("$reader runs each query once when $query hits a timeout", async ({ reader, query }) => {
    const queries: string[] = [];
    const run: NvidiaSmiRunner = async (args) => {
      const command = args[0] ?? "";
      queries.push(command);
      const totals = command.startsWith("--query-gpu");
      if (totals === (query === "totals")) throw Object.assign(new Error("nvidia-smi timed out"), { code: "ETIMEDOUT" });
      return totals ? command.includes("name,") ? `RTX, ${MACHINE_GPU}` : MACHINE_GPU : MACHINE_APPS;
    };
    if (reader === "fit") await expect(readGpu(run)).rejects.toMatchObject({ code: "gpu-unreadable", message: expect.stringContaining("nvidia-smi timed out") });
    else expect(await readGpuStatus({ runNvidiaSmi: run, readMeminfo: async () => MACHINE_MEMINFO })).toMatchObject({ vendor: "unreadable", detail: expect.stringContaining("nvidia-smi timed out") });
    expect(queries.filter(command => command.startsWith("--query-gpu"))).toHaveLength(1);
    expect(queries.filter(command => command.startsWith("--query-compute-apps"))).toHaveLength(1);
  });

  it.each(["fit", "status"])("%s recovers from a transient malformed read", async (reader) => {
    vi.useFakeTimers();
    try {
    let reads = 0;
    const run: NvidiaSmiRunner = async (args) => !args[0]?.startsWith("--query-gpu") ? MACHINE_APPS
      : ++reads === 1 ? "garbled" : args[0].includes("name,") ? `RTX, ${MACHINE_GPU}` : MACHINE_GPU;
    const check = reader === "fit" ? readGpu(run) : readGpuStatus({ runNvidiaSmi: run, readMeminfo: async () => MACHINE_MEMINFO });
    await vi.advanceTimersByTimeAsync(249);
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    if (reader === "fit") expect(await check).toMatchObject({ freeBytes: 9468 * MIB });
    else expect(await check).toMatchObject({ vendor: "nvidia" });
    expect(reads).toBe(2);
    } finally { vi.useRealTimers(); }
  });

  it("reports a real execFile timeout identically despite the readers' different query arguments", async () => {
    const s = await fakeOllama();
    let reads = 0;
    const run: NvidiaSmiRunner = async (args) => {
      reads++;
      throw Object.assign(new Error(`Command failed: nvidia-smi ${args.join(" ")}\n`), { code: null, killed: true, signal: "SIGTERM", stdout: "", stderr: "" });
    };
    const status = await readGpuStatus({ runNvidiaSmi: run, readMeminfo: async () => MACHINE_MEMINFO });
    expect(status.detail).toContain("nvidia-smi timed out");
    await expect(checkFit({ baseUrl: s.baseUrl, model: "qwen3.5:9b", numCtx: 16384, runNvidiaSmi: run, readMeminfo: async () => MACHINE_MEMINFO })).rejects.toMatchObject({ message: status.detail });
    expect(reads).toBe(4);
  });

  it("never treats a process-query error as no GPU when memory was readable", async () => {
    let calls = 0;
    const run: NvidiaSmiRunner = async (args) => {
      calls++;
      if (args[0]?.startsWith("--query-gpu")) return args[0].includes("name,") ? `RTX, ${MACHINE_GPU}` : MACHINE_GPU;
      throw new Error("No devices were found");
    };
    expect((await readGpuStatus({ runNvidiaSmi: run, readMeminfo: async () => MACHINE_MEMINFO })).vendor).toBe("unreadable");
    await expect(readGpu(run)).rejects.toMatchObject({ code: "gpu-unreadable" });
    expect(calls).toBe(8);
  });

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
      label: "Media Vault vision",
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

  // Chat row 33: two sends starting at once each ran nvidia-smi twice; on one core that was 40% of Send to first word.
  describe("one GPU reading is shared", () => {
    it("callers at the same time share one run of each query", async () => {
      const smiHeld = held();
      const first = readGpu(smiHeld.run), second = readGpu(smiHeld.run);
      await settle();
      expect(smiHeld.signals).toHaveLength(2);
      smiHeld.release();
      expect(await second).toBe(await first);
    });

    it("a survey takes a finished reading under 500 ms old and not an older one; a send never takes a finished one", async () => {
      vi.useFakeTimers({ toFake: ["performance"] });
      try {
        const run = smi(MACHINE_GPU, MACHINE_APPS);
        const first = await readGpu(run);
        vi.advanceTimersByTime(400);
        expect(await readGpu(run, Date.now, undefined, GPU_REUSE_MS)).toBe(first);
        expect(run.calls).toHaveLength(2);
        expect(await readGpu(run)).not.toBe(first);
        expect(run.calls).toHaveLength(4);
        vi.advanceTimersByTime(600);
        await readGpu(run, Date.now, undefined, GPU_REUSE_MS);
        expect(run.calls).toHaveLength(6);
      } finally { vi.useRealTimers(); }
    });

    it("a caller that gives up leaves the read to the others; the read stops only when every caller has gone", async () => {
      const smiHeld = held();
      const one = new AbortController(), two = new AbortController();
      const first = readGpu(smiHeld.run, Date.now, one.signal), second = readGpu(smiHeld.run, Date.now, two.signal);
      await settle();
      const reason = new Error("first window closed");
      one.abort(reason);
      await expect(first).rejects.toBe(reason);
      expect(smiHeld.signals.every(s => s?.aborted === false)).toBe(true);
      two.abort(reason);
      await expect(second).rejects.toBe(reason);
      expect(smiHeld.signals.every(s => s?.aborted === true)).toBe(true);
    });

    it("after the app changes the GPU (a load, an unload), no caller gets a reading from before it", async () => {
      const run = smi(MACHINE_GPU, MACHINE_APPS);
      const first = await readGpu(run);
      forgetGpuReadings();
      expect(await readGpu(run, Date.now, undefined, GPU_REUSE_MS)).not.toBe(first);
      expect(run.calls).toHaveLength(4);

      const smiHeld = held();
      const before = readGpu(smiHeld.run);
      await settle();
      forgetGpuReadings();
      const after = readGpu(smiHeld.run);
      await settle();
      expect(smiHeld.signals).toHaveLength(4);
      smiHeld.release();
      await settle();
      smiHeld.release();
      expect(await after).not.toBe(await before);
    });

    it("a failed reading is not kept: the next caller reads again", async () => {
      let runs = 0;
      const flaky: NvidiaSmiRunner = async (args) => {
        runs++;
        // a timeout never retries: the first reading is these two runs
        if (runs <= 2) throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
        return args[0]?.startsWith("--query-gpu") ? MACHINE_GPU : MACHINE_APPS;
      };
      await expect(readGpu(flaky)).rejects.toMatchObject({ code: "gpu-unreadable" });
      await expect(readGpu(flaky)).resolves.toMatchObject({ totalBytes: 16303 * MIB });
      expect(runs).toBe(4);
    });
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

  it("reads MemTotal, the computer's memory: undefined when the line is not there", () => {
    expect(parseMemTotal(MACHINE_MEMINFO)).toBe(32768000 * 1024);
    expect(parseMemTotal("MemAvailable: 1 kB")).toBeUndefined();
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
    expect(() => parseArchInfo("x", { "general.architecture": "a", "a.context_length": 2 })).toThrow(/block_count/);
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

    it("aborted after a failed first attempt: starts no second attempt", async () => {
      vi.useFakeTimers();
      try {
        const controller = new AbortController();
        const reason = new Error("gone during retry pause");
        const gpu = readGpu(broken.smi, Date.now, controller.signal).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(0);
        expect(broken.runs).toBe(2);
        controller.abort(reason);
        expect(await gpu).toBe(reason);
        await vi.advanceTimersByTimeAsync(500);
        expect(broken.runs).toBe(2);
      } finally { vi.useRealTimers(); }
    });
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

  it("CPU-only plans never stop another busy reply to reclaim VRAM", async () => {
    const s = await fakeOllama({ models: [{ name: QWEN27, size: 10 * GIB, size_vram: 0, context_length: 16384 }] });
    const base = { baseUrl: s.baseUrl, model: QWEN9, numCtx: 16384, readMeminfo: plenty, now: () => 1,
      runNvidiaSmi: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } };
    const alone = await planLoad({ ...base, busy: [] });
    expect(alone.report.verdict).toBe("spills");
    expect(await planLoad({ ...base, busy: [QWEN27], comfyPid: 999 })).toEqual({ report: alone.report, stop: [], comfy: false });
  });

  it("none when the model fits beside them, is resident at this num_ctx, or is the busy model itself", async () => {
    const s = await fakeOllama(resident([{ name: QWEN27, vram: 2e9 }, { name: QWEN9, vram: 8e9 }]));
    const base = { baseUrl: s.baseUrl, numCtx: 16384, readMeminfo: plenty };
    expect(await blockingModels({ ...base, model: QWEN9, busy: [QWEN27], runNvidiaSmi: gpuWith(15000) })).toEqual([]);
    expect(await blockingModels({ ...base, model: QWEN9, busy: [QWEN27], runNvidiaSmi: gpuWith(500) })).toEqual([]);
    expect(await blockingModels({ ...base, model: QWEN27, busy: [QWEN27], runNvidiaSmi: gpuWith(500) })).toEqual([]);
  });

  it("the fewest, largest first, whose VRAM makes it fit", async () => {
    const s = await fakeOllama(resident([{ name: GEMMA, vram: 2e9 }, { name: QWEN27, vram: 12e9 }]));
    expect(await blockingModels({ baseUrl: s.baseUrl, model: QWEN9, numCtx: 16384, busy: [GEMMA, QWEN27], runNvidiaSmi: gpuWith(500), readMeminfo: plenty })).toEqual([QWEN27]);
  });

  it("R4-04: idle resident models count first: ~1 GB free, busy 4 GB, idle 9 GB stops nothing", async () => {
    const s = await fakeOllama(resident([{ name: QWEN27, vram: 4e9 }, { name: GEMMA, vram: 9e9 }]));
    expect(await blockingModels({ baseUrl: s.baseUrl, model: QWEN9, numCtx: 16384, busy: [QWEN27], runNvidiaSmi: gpuWith(1000), readMeminfo: plenty })).toEqual([]);
    // Not enough idle memory alone: the busy one goes, and the idle one still counts.
    const t = await fakeOllama(resident([{ name: QWEN27, vram: 4e9 }, { name: GEMMA, vram: 3e9 }]));
    expect(await blockingModels({ baseUrl: t.baseUrl, model: QWEN9, numCtx: 16384, busy: [QWEN27], runNvidiaSmi: gpuWith(1000), readMeminfo: plenty })).toEqual([QWEN27]);
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
    expect(check.report.message).toContain(`held by ${QWEN27}, which Ollama unloads to make room`);
  });
});

describe("fitEach: the chat pick's fit", () => {
  it("MP-05: a model that happens to be loaded counts as room, the way a load counts it", async () => {
    const QWEN27 = "qwen3.8-abliterated:27b";
    const s = await fakeOllama(resident([{ name: QWEN27, vram: 12e9 }]));
    const fit = await fitEach({ baseUrl: s.baseUrl, numCtx: 16384, runNvidiaSmi: gpuWith(500), readMeminfo: plenty });
    expect(await fit("qwen3.5:9b")).toMatchObject({ verdict: "fits", freeVramBytes: 500 * MIB + 12e9 });
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
