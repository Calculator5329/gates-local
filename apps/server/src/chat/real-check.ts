// Real-runtime check for the first turn (not part of vitest or pnpm verify).
//   node apps/server/src/chat/real-check.ts [model] [numCtx]
// Records whisper-server's PID and VRAM and the /api/ps list, runs the fit
// check, streams one short reply at an explicit num_ctx, reads the measured
// fit from /api/ps, unloads only a model this script loaded, and checks
// whisper again. Loads nothing when the fit refuses. Exits 1 if whisper
// changed or the turn did not finish.
import { pathToFileURL } from "node:url";
import { CHAT_MODELS } from "@gates-local/contracts";
import { checkFit, fetchPs, findLoaded, formatBytes, measuredFit, readGpu, type FitDeps, type GpuSnapshot } from "../fit/index.ts";
import { streamTurn } from "./stream.ts";

const prompt = "Reply with one sentence: what is 2+2?";
const WHISPER_TOLERANCE_MIB = 8;
const MiB = 1024 * 1024;

const stamp = () => new Date().toISOString();

function whisperOf(gpu: GpuSnapshot) {
  const w = gpu.tenants.filter((t) => t.permanent);
  return w.map((t) => ({ pid: t.pid, usedMiB: t.usedBytes === undefined ? undefined : t.usedBytes / MiB }));
}

function printGpu(label: string, gpu: GpuSnapshot) {
  console.log(`[${stamp()}] ${label}: GPU total ${gpu.totalBytes / MiB} MiB, used ${gpu.usedBytes / MiB} MiB, free ${gpu.freeBytes / MiB} MiB`);
  for (const t of gpu.tenants) {
    console.log(`    ${String(t.pid).padStart(8)}  ${(t.usedBytes === undefined ? "N/A" : `${t.usedBytes / MiB} MiB`).padStart(9)}  ${t.role}${t.permanent ? " (permanent)" : ""}  ${t.label}`);
  }
}

async function unload(baseUrl: string, name: string): Promise<void> {
  const res = await fetch(new URL("/api/generate", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: name, keep_alive: 0 }),
  });
  console.log(`[${stamp()}] unload ${name}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

/** The check itself; `probes` stand in for nvidia-smi and /proc/meminfo in the test. */
export async function realCheck({ baseUrl, model, numCtx }: { baseUrl: string; model: string; numCtx: number }, probes: Pick<FitDeps, "runNvidiaSmi" | "readMeminfo"> = {}): Promise<number> {
  console.log(`== real check: ${model} at num_ctx ${numCtx} against ${baseUrl}`);
  const gpuBefore = await readGpu(probes.runNvidiaSmi);
  printGpu("before", gpuBefore);
  const whisperBefore = whisperOf(gpuBefore);
  console.log(`[${stamp()}] whisper before: ${JSON.stringify(whisperBefore)}`);
  if (whisperBefore.length !== 1) {
    console.log("whisper-server is not exactly one GPU tenant; stopping without loading anything.");
    return 1;
  }
  const psBefore = await fetchPs(baseUrl);
  console.log(`[${stamp()}] /api/ps before: ${JSON.stringify(psBefore.models.map((m) => ({ name: m.name, size: m.size, size_vram: m.size_vram, context_length: m.context_length })))}`);
  const wasLoaded = findLoaded(psBefore, model) !== undefined;

  const fit = await checkFit({ baseUrl, model, numCtx, ...probes });
  const est = fit.estimate;
  if (est) {
    console.log(
      `[${stamp()}] estimate: weights ${formatBytes(est.weightsBytes)} + KV ${formatBytes(est.kvCacheBytes)} (${est.kvLayers} KV layers) + overhead ${formatBytes(est.overheadBytes)} = ${formatBytes(est.totalBytes)}`,
    );
  }
  console.log(`[${stamp()}] fit (${fit.report.source}): ${fit.report.verdict}`);
  console.log(`    ${fit.report.message}`);
  if (fit.report.verdict === "refuse") {
    console.log("Refused: nothing loaded.");
    return 0;
  }
  // The size the model runs at: what was asked for, never past the model's maximum.
  const effective = fit.report.numCtx;
  if (effective !== numCtx) console.log(`[${stamp()}] ${model} runs at num_ctx ${effective}, not the ${numCtx} asked for.`);

  let finished = false;
  process.stdout.write(`[${stamp()}] streaming "${prompt}"\n    deltas: `);
  const t0 = Date.now();
  let firstDeltaMs: number | undefined;
  for await (const event of streamTurn({
    baseUrl,
    model,
    numCtx: effective,
    think: false,
    messages: [{ role: "user", content: prompt }],
    signal: AbortSignal.timeout(300_000),
  })) {
    if (event.type === "delta") {
      firstDeltaMs ??= Date.now() - t0;
      process.stdout.write(`[${event.text}]`);
    } else if (event.type === "thinking") {
      process.stdout.write(`{think:${event.text}}`);
    } else if (event.type === "done") {
      finished = true;
      process.stdout.write("\n");
      console.log(`[${stamp()}] done: stopReason ${event.stopReason}, first delta after ${firstDeltaMs} ms`);
      console.log(`    content: ${JSON.stringify(event.message.content)}`);
      console.log(`    stats: ${JSON.stringify(event.message.stats)}`);
    } else {
      process.stdout.write("\n");
      console.log(`[${stamp()}] error ${event.code}: ${event.message}`);
    }
  }

  try {
    const measured = await measuredFit({ baseUrl, model, numCtx: effective, ...probes });
    console.log(`[${stamp()}] fit (${measured.report.source}): ${measured.report.verdict}`);
    console.log(`    ${measured.report.message}`);
    if (est) {
      const delta = measured.report.needVramBytes - est.totalBytes;
      console.log(`    measured minus estimate: ${delta >= 0 ? "+" : ""}${formatBytes(delta)}`);
    }
    if (measured.gpu) printGpu("loaded", measured.gpu);
  } catch (error) {
    console.log(`[${stamp()}] measured fit failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (wasLoaded) console.log(`[${stamp()}] ${model} was loaded before this script; leaving it loaded.`);
  else await unload(baseUrl, model);
  const psAfter = await fetchPs(baseUrl);
  console.log(`[${stamp()}] /api/ps after: ${JSON.stringify(psAfter.models.map((m) => m.name))}`);

  const gpuAfter = await readGpu(probes.runNvidiaSmi);
  printGpu("after", gpuAfter);
  const whisperAfter = whisperOf(gpuAfter);
  console.log(`[${stamp()}] whisper after: ${JSON.stringify(whisperAfter)}`);
  const before = whisperBefore[0];
  const after = whisperAfter[0];
  const unchanged =
    whisperAfter.length === 1 &&
    before !== undefined &&
    after !== undefined &&
    before.pid === after.pid &&
    Math.abs((before.usedMiB ?? 0) - (after.usedMiB ?? 0)) <= WHISPER_TOLERANCE_MIB;
  console.log(`whisper unchanged (PID equal, VRAM within ${WHISPER_TOLERANCE_MIB} MiB): ${unchanged}`);
  return unchanged && finished ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  realCheck({ baseUrl: process.env.OLLAMA_HOST_URL ?? "http://127.0.0.1:11434", model: process.argv[2] ?? CHAT_MODELS.example, numCtx: Number(process.argv[3] ?? 16384) }).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
