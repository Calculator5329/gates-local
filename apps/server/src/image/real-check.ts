// Explicit coordinator-only runtime check. Never imported or run by verify.
// Run: node apps/server/src/image/real-check.ts --execute
// The swap: node apps/server/src/image/real-check.ts --execute --swap-model <installed chat model tag> [--num-ctx 16384] [--ollama-url URL]
//   first loads that chat model through the app's own loader and fit planner, so the image job
//   has to unload it, wait for the memory and then render, as a chat's image does in the app.
// The warm swap: add --warm with a --swap-model that is already in memory (as after an app restart):
//   one chat turn runs on it, then the image has to unload it although this check never loaded it.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import type { ImageEvent } from "@gates-local/contracts";
import { planLoad } from "../fit/fit.ts";
import { readGpu } from "../fit/gpu.ts";
import { createGpuLease } from "../gpu/lease.ts";
import { createModelLoader, type ModelLoader } from "../runtime/load.ts";
import { listLoaded } from "../runtime/models.ts";
import { canonicalTag } from "../runtime/recommended.ts";
import { DEFAULT_EXTERNAL_BASE_URL } from "../runtime/runtime.ts";
import { openThreadStore } from "../threads/store.ts";
import { startWsServer } from "../ws/server.ts";
import { createImageHandlers } from "./handlers.ts";
import { createImageModule } from "./module.ts";
import { DEFAULT_CHOICE, resolveChoice } from "./presets.ts";

/** The first default's estimate; the job settles to the first default ComfyUI has, which may be the next one. */
const IMAGE_ESTIMATED_BYTES = resolveChoice(DEFAULT_CHOICE).size.bytes;

export interface SwapOptions {
  /**
   * An installed chat model that is not resident yet: this check must be the one that loads it.
   * With `warm`, one that is already resident (loaded before this check, as after an app restart).
   */
  model: string;
  numCtx: number;
  ollamaUrl: string;
  /** The warm swap: the model is already resident, one chat turn runs on it, then the image. */
  warm?: boolean;
}

/** Loads the chat model the way the app's models.load does (services.ts): its loader, its fit planner. */
async function loadChatModel(swap: SwapOptions): Promise<ModelLoader> {
  const loader = createModelLoader({
    baseUrl: () => swap.ollamaUrl,
    push: (load) => console.log(JSON.stringify({ chatLoad: load })),
    listLoaded: (url, signal) => listLoaded(url, undefined, signal),
    fit: async (model, numCtx, baseUrl, signal) => (await planLoad({ baseUrl, model, numCtx, signal, busy: [] })).report,
  });
  if (swap.warm) return warmTurn(swap, loader);
  const result = await loader.load(swap.model, swap.numCtx);
  assert.equal(result.state, "ready", result.message ?? `${swap.model} did not load`);
  assert.deepEqual(loader.appLoadedModels(), [canonicalTag(swap.model)], `${swap.model} was already in memory; unload it first so this check is the one that loads it`);
  const gpu = await readGpu();
  console.log(JSON.stringify({ chatModelLoaded: swap.model, numCtx: result.numCtx, freeBytes: gpu.freeBytes }));
  return loader;
}

/**
 * The owner's restart: the chat model is resident and the loader did not load it. One chat turn
 * runs on it through the loader's reservation, as chat.send does, so the image may unload it.
 */
async function warmTurn(swap: SwapOptions, loader: ModelLoader): Promise<ModelLoader> {
  const resident = (await listLoaded(swap.ollamaUrl)).map((m) => canonicalTag(m.name));
  assert(resident.includes(canonicalTag(swap.model)), `${swap.model} is not in memory; load it first (one message in any chat) so this check finds it warm`);
  const turn = loader.reserve(swap.model);
  try {
    const report = await turn.admit(swap.numCtx);
    assert.notEqual(report.verdict, "refuse", report.message ?? `${swap.model} does not fit`);
    const response = await fetch(new URL("/api/chat", swap.ollamaUrl), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: swap.model, stream: false, options: { num_ctx: report.numCtx }, messages: [{ role: "user", content: "Say ok." }] }),
    });
    assert.equal(response.status, 200, `the chat turn on ${swap.model} failed: HTTP ${response.status}`);
    await response.arrayBuffer();
    turn.firstToken();
  } finally {
    turn.end();
  }
  assert.deepEqual(loader.appLoadedModels(), [], `${swap.model} was loaded by this check, so it was not warm`);
  assert.deepEqual(await loader.imageMayUnload(), [canonicalTag(swap.model)], "the turn did not make the warm model the app's to unload");
  console.log(JSON.stringify({ warmChatTurn: swap.model, numCtx: swap.numCtx }));
  return loader;
}

async function whisperSnapshot() {
  const gpu = await readGpu();
  const tenants = gpu.tenants.filter((t) => t.role === "whisper");
  assert.equal(tenants.length, 1, "exactly one whisper GPU process must already be running; this check never starts it");
  const tenant = tenants[0];
  assert(tenant?.usedBytes !== undefined, "whisper must have a measurable GPU memory reading");
  return { pid: tenant.pid, gpuBytes: tenant.usedBytes };
}

export async function realCheck(dataDir: string, comfyUrl?: string, swap?: SwapOptions) {
  await mkdir(dataDir, { recursive: true });
  const before = await whisperSnapshot();
  const gpu = await readGpu();
  console.log(JSON.stringify({ whisperBefore: before, freeBytes: gpu.freeBytes, imageEstimateBytes: IMAGE_ESTIMATED_BYTES }));
  // Without --swap-model this check loads no chat model, so it owns none to unload.
  const loader = swap ? await loadChatModel(swap) : undefined;
  // The module checks the remaining estimate after crediting healthy ComfyUI's
  // resident bytes. A full-free-memory precheck would reject every warm job.
  const store = openThreadStore(path.join(dataDir, "real-check.sqlite"));
  let terminal: ImageEvent | undefined;
  let progressFrames = 0;
  let freeingAt: number | undefined, freedAt: number | undefined;
  let server: Awaited<ReturnType<typeof startWsServer>> | undefined;
  const image = createImageModule({ dataDir, store, lease: createGpuLease(),
    settings: () => ({ imageGen: true, ...(comfyUrl ? { comfyUrl } : {}) }),
    // Wired as main.ts wires the app's loader.
    imageMayUnload: () => loader?.imageMayUnload() ?? [], ollamaUrl: () => swap?.ollamaUrl,
    onModelUnloaded: (model) => loader?.unloaded(model),
    push: (channel, payload) => {
      server?.push(channel, payload);
      if (channel === "image.event") {
        const event = payload as ImageEvent;
        if (event.phase === "freeing") freeingAt ??= Date.now();
        else if (event.state === "running" && freeingAt !== undefined) freedAt ??= Date.now();
        if (event.state === "running" && event.progress !== undefined && event.progress > 0) progressFrames++;
        if (["done", "error", "cancelled"].includes(event.state)) terminal = event;
      }
    },
  });
  try {
    const token = randomUUID(); // per-launch only, never logged or persisted
    const handlers = createImageHandlers({ image });
    server = await startWsServer({ port: 0, token, allowedOrigins: [], handlers, dataDir });
    const thread = store.createThread({ title: "Image real check" });
    const { jobId } = await handlers["image.generate"]({ prompt: "a small green tree on a gray background, pixel art", threadId: thread.id });
    await image.wait(jobId);
    assert.equal(terminal?.state, "done", terminal?.message ?? "image did not finish");
    assert(progressFrames > 0, "no nonzero progress frame was observed");
    const response = await fetch(`http://127.0.0.1:${server.port}/files/images/${jobId}.png?token=${encodeURIComponent(token)}`);
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "served result must be PNG");
    assert.deepEqual(store.getThread(thread.id).messages[0]?.images, [`images/${jobId}.png`]);
    console.log(JSON.stringify({ image: path.join(dataDir, "images", `${jobId}.png`), progressFrames, servedBytes: bytes.length }));
    if (swap && loader) {
      assert(freeingAt !== undefined, `the image fit beside ${swap.model}, so no swap ran; pick a larger --swap-model or --num-ctx`);
      assert(freedAt !== undefined, "the job never left its freeing step");
      assert.deepEqual(loader.appLoadedModels(), [], "the chat model is still counted as loaded");
      assert.deepEqual(await loader.imageMayUnload(), [], "the chat model is still counted as the app's to unload");
      const resident = (await listLoaded(swap.ollamaUrl)).map((m) => canonicalTag(m.name));
      assert(!resident.includes(canonicalTag(swap.model)), `${swap.model} is still resident in Ollama`);
      console.log(JSON.stringify({ swap: { model: swap.model, unloadAndWaitMs: freedAt - freeingAt } }));
    }
  } finally {
    try { await image.close(); }
    finally {
      await server?.close(); store.close();
      const after = await whisperSnapshot();
      console.log(JSON.stringify({ whisperAfter: after, unchanged: before.pid === after.pid && before.gpuBytes === after.gpuBytes }));
      assert.deepEqual(after, before, "whisper PID and GPU bytes must be unchanged");
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { execute: { type: "boolean" }, "data-dir": { type: "string" }, "comfy-url": { type: "string" },
    "swap-model": { type: "string" }, "num-ctx": { type: "string" }, "ollama-url": { type: "string" }, warm: { type: "boolean" } } });
  if (!values.execute) throw new Error("Real GPU work requires --execute. The fake suites use pnpm verify:image instead.");
  const swapModel = values["swap-model"];
  if (values.warm && swapModel === undefined) throw new Error("--warm needs --swap-model: the chat model that is already in memory.");
  const swap = swapModel === undefined ? undefined : { model: swapModel, numCtx: Number(values["num-ctx"] ?? 16384), ollamaUrl: values["ollama-url"] ?? DEFAULT_EXTERNAL_BASE_URL, ...(values.warm ? { warm: true } : {}) };
  if (swap && !(Number.isInteger(swap.numCtx) && swap.numCtx > 0)) throw new Error("--num-ctx must be a positive whole number.");
  await realCheck(values["data-dir"] ?? path.join(os.tmpdir(), "gates-local-real-check"), values["comfy-url"], swap);
}
