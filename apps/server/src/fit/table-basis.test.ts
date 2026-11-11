// One basis per model in the fit table. Every context of a model is the estimate plus one offset:
// the loaded copy's measurement minus the estimate at its context when the copy is wholly on the GPU,
// zero otherwise. A larger context never needs less, and a smaller context of a loaded model is never
// refused while the loaded one runs.
import { readFileSync } from "node:fs";
import type { FitTable } from "@gates-local/contracts";
import { afterEach, expect, it } from "vitest";
import { GIB, MIB } from "./constants.ts";
import { json, startFakeServer, type FakeServer } from "./fake-http.ts";
import { createFitTable, TABLE_CONTEXTS } from "./table.ts";
import type { NvidiaSmiRunner } from "./types.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as unknown;
const QWEN9 = { name: "qwen3.5:9b", weights: 6594474711, show: fixture("show-qwen3-5-9b.json") };
const GEMMA = { name: "gemma4-abliterated:26b", weights: 17990843601, show: fixture("show-gemma4-abliterated-26b.json") };
const QWEN27 = { name: "qwen3.8-abliterated:27b", weights: Math.round(17.4 * GIB), show: fixture("show-qwen3-8-abliterated-27b.json") };
type Model = typeof QWEN9;

let servers: FakeServer[] = [];
afterEach(async () => {
  for (const s of servers) await s.close();
  servers = [];
});

/** A card of `totalMib` with whisper and, when `runnerMib` > 0, one runner holding that much. */
function card(runnerMib: number, totalMib = 65536): NvidiaSmiRunner {
  const used = 2202 + runnerMib;
  return async (args) => {
    if (args[0]?.startsWith("--query-gpu")) return `${totalMib}, ${used}, ${totalMib - used}\n`;
    return `5100, /usr/bin/whisper-server, 2202\n${runnerMib > 0 ? `5800, /usr/bin/ollama, ${runnerMib}\n` : ""}`;
  };
}

async function tableFor(m: Model, ps: { models: unknown[] }, smi: NvidiaSmiRunner, memAvailableBytes = 30e9): Promise<FitTable> {
  const s = await startFakeServer({
    "GET /api/tags": (_b, res) => json(res, 200, { models: [{ name: m.name, size: m.weights, digest: "d" }] }),
    "GET /api/ps": (_b, res) => json(res, 200, ps),
    "POST /api/show": (_b, res) => json(res, 200, m.show),
  });
  servers.push(s);
  const t = createFitTable({
    baseUrl: () => s.baseUrl,
    fit: { runNvidiaSmi: smi, readMeminfo: async () => `MemAvailable: ${Math.round(memAvailableBytes / 1024)} kB\n`, now: () => 1 },
    models: async () => [{ name: m.name, downloadBytes: m.weights, installed: true }],
    busy: () => [],
    comfyPid: () => undefined,
    push: () => undefined,
    boot: "b",
  });
  return t.get();
}

const rowsOf = (t: FitTable, model: string) => t.rows.filter((r) => r.model === model);
const show = (t: FitTable) => t.rows.map((r) => `${r.model}@${r.numCtx / 1024}k ${(r.needVramBytes / 1e9).toFixed(2)} ${r.source} ${r.verdict}`).join(" ; ");

function expectRising(t: FitTable, model: string): void {
  const rows = rowsOf(t, model);
  expect(rows.map((r) => r.numCtx), show(t)).toEqual([...TABLE_CONTEXTS]);
  for (let i = 1; i < rows.length; i++) expect(rows[i]!.needVramBytes, show(t)).toBeGreaterThanOrEqual(rows[i - 1]!.needVramBytes);
}

it("the real qwen3.5:9b copy at 16k, wholly on the GPU: its measurement moves every context by the same amount", async () => {
  // size_vram 5.92 GB, the runner 6926 MiB per nvidia-smi: 7.26 GB measured at 16k.
  const t = await tableFor(QWEN9, { models: [{ name: QWEN9.name, model: QWEN9.name, size: 5.92e9, size_vram: 5.92e9, context_length: 16384 }] }, card(6926));
  expectRising(t, QWEN9.name);
  expect(rowsOf(t, QWEN9.name).find((r) => r.numCtx === 16384)).toMatchObject({ source: "measured", needVramBytes: 6926 * MIB });
});

it("every fixture, every loaded context, a measurement from 0.8 to 1.3 times its estimate or exactly the weights: need rises with context", async () => {
  for (const m of [QWEN9, GEMMA, QWEN27]) {
    const cold = rowsOf(await tableFor(m, { models: [] }, card(0)), m.name).map((r) => r.needVramBytes);
    for (const [i, numCtx] of TABLE_CONTEXTS.entries()) {
      const helds = [0.8, 0.9, 1, 1.1, 1.2, 1.3].map((f) => cold[i]! * f).concat(m.weights);
      for (const held of helds) {
        const mib = Math.ceil(held / MIB);
        const t = await tableFor(m, { models: [{ name: m.name, model: m.name, size: mib * MIB, size_vram: mib * MIB, context_length: numCtx }] }, card(mib));
        expectRising(t, m.name);
        // No context needs less than the weights, whatever the offset.
        for (const r of rowsOf(t, m.name)) expect(r.needVramBytes, show(t)).toBeGreaterThanOrEqual(m.weights);
        // A copy holding at least its weights is measured: its row is the measurement exactly.
        if (mib * MIB >= m.weights) expect(rowsOf(t, m.name)[i], show(t)).toMatchObject({ source: "measured", needVramBytes: mib * MIB });
      }
    }
  }
});

it("a copy partly in system memory: no smaller context is refused while the loaded one runs, at any free RAM", async () => {
  // 10 GiB on the GPU of a 16303 MiB card at 16k, the rest in system memory.
  const held = 10 * GIB;
  for (const memGb of [4, 8, 12, 30]) {
    const t = await tableFor(QWEN27, { models: [{ name: QWEN27.name, model: QWEN27.name, size: held + 256 * MIB, size_vram: held, context_length: 16384 }] }, card(held / MIB, 16303), memGb * 1e9);
    const loaded = rowsOf(t, QWEN27.name).find((r) => r.numCtx === 16384);
    expect(loaded?.verdict, show(t)).not.toBe("refuse");
    expect(rowsOf(t, QWEN27.name).filter((r) => r.numCtx < 16384 && r.verdict === "refuse"), `${memGb} GB available: ${show(t)}`).toEqual([]);
  }
});

it("a copy partly in system memory: a larger context gets no credit for the loaded context's estimate", async () => {
  // P8's state at 4 GB: /api/ps says 0.27 GB of the copy is outside the GPU. Unloading frees that
  // much system memory, not what the estimate at 16k puts there (weights mapped from disk).
  const held = 10 * GIB;
  const t = await tableFor(QWEN27, { models: [{ name: QWEN27.name, model: QWEN27.name, size: held + 256 * MIB, size_vram: held, context_length: 16384 }] }, card(held / MIB, 16303), 4e9);
  const verdicts = Object.fromEntries(rowsOf(t, QWEN27.name).map((r) => [r.numCtx, r.verdict]));
  expect({ 32768: verdicts[32768], 65536: verdicts[65536] }, show(t)).toEqual({ 32768: "refuse", 65536: "refuse" });
  expect(verdicts[8192], show(t)).not.toBe("refuse");
});

it("a copy /api/ps lists under another name is counted once: every row's free memory matches the same-name case", async () => {
  const gemmaPs = (name: string) => ({ models: [{ name, model: GEMMA.name, size: 11.3e9, size_vram: 11.0e9, context_length: 16384 }] });
  const free = async (name: string) => rowsOf(await tableFor(GEMMA, gemmaPs(name), card(10490, 16303), 6.144e9), GEMMA.name).map((r) => [r.numCtx, r.freeVramBytes, r.verdict]);
  expect(await free("alias:latest")).toEqual(await free(GEMMA.name));
});

it("a copy /api/ps lists under another name is the requested model's row", async () => {
  const t = await tableFor(QWEN9, { models: [{ name: "alias:latest", model: QWEN9.name, size: 7.5e9, size_vram: 7.5e9, context_length: 16384 }] }, card(7200));
  expect(t.rows.map((r) => r.model), show(t)).toEqual(TABLE_CONTEXTS.map(() => QWEN9.name));
  expect(rowsOf(t, QWEN9.name).find((r) => r.numCtx === 16384)).toMatchObject({ source: "measured" });
});

it("a copy that spills is not measured, even when the runner holds more than the weights", async () => {
  // /api/ps says 1.5 GB is in system memory; the runner's 19 GB on the GPU does not make it whole.
  const t = await tableFor(GEMMA, { models: [{ name: GEMMA.name, model: GEMMA.name, size: 20.5e9, size_vram: 19e9, context_length: 16384 }] }, card(Math.round(19e9 / MIB)));
  expect(rowsOf(t, GEMMA.name).find((r) => r.numCtx === 16384), show(t)).toMatchObject({ source: "estimate", verdict: "spills" });
});

it("a model that holds 8k at most has one row, at 8k", async () => {
  const small = { ...QWEN9, show: { ...(QWEN9.show as Record<string, unknown>), model_info: { ...((QWEN9.show as { model_info: Record<string, unknown> }).model_info), "qwen35.context_length": 8192 } } };
  const t = await tableFor(small, { models: [] }, card(0));
  expect(rowsOf(t, QWEN9.name).map((r) => r.numCtx), show(t)).toEqual([8192]);
});
