// Explicit coordinator-only runtime check. Never imported or run by verify.
// Run: node apps/server/src/image/real-check.ts --execute
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import type { ImageEvent } from "@gates-local/contracts";
import { readGpu } from "../fit/gpu.ts";
import { createGpuLease } from "../gpu/lease.ts";
import { openThreadStore } from "../threads/store.ts";
import { startWsServer } from "../ws/server.ts";
import { createImageHandlers } from "./handlers.ts";
import { createImageModule } from "./module.ts";
import { IMAGE_ESTIMATED_BYTES } from "./workflow.ts";

async function whisperSnapshot() {
  const gpu = await readGpu();
  const tenants = gpu.tenants.filter((t) => t.role === "whisper");
  assert.equal(tenants.length, 1, "exactly one whisper GPU process must already be running; this check never starts it");
  const tenant = tenants[0];
  assert(tenant?.usedBytes !== undefined, "whisper must have a measurable GPU memory reading");
  return { pid: tenant.pid, gpuBytes: tenant.usedBytes };
}

export async function realCheck(dataDir: string, comfyUrl?: string) {
  await mkdir(dataDir, { recursive: true });
  const before = await whisperSnapshot();
  const gpu = await readGpu();
  console.log(JSON.stringify({ whisperBefore: before, freeBytes: gpu.freeBytes, imageEstimateBytes: IMAGE_ESTIMATED_BYTES }));
  assert(gpu.freeBytes >= IMAGE_ESTIMATED_BYTES, "not enough measured free VRAM for the conservative image estimate; no image attempted and no models unloaded");
  const store = openThreadStore(path.join(dataDir, "real-check.sqlite"));
  let terminal: ImageEvent | undefined;
  let progressFrames = 0;
  let server: Awaited<ReturnType<typeof startWsServer>> | undefined;
  const image = createImageModule({ dataDir, store, lease: createGpuLease(),
    settings: () => ({ imageGen: true, ...(comfyUrl ? { comfyUrl } : {}) }),
    // This separate check has loaded no chat models, so it owns none to unload.
    appLoadedModels: () => [], ollamaUrl: () => undefined,
    push: (channel, payload) => {
      server?.push(channel, payload);
      if (channel === "image.event") {
        const event = payload as ImageEvent;
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
  const { values } = parseArgs({ options: { execute: { type: "boolean" }, "data-dir": { type: "string" }, "comfy-url": { type: "string" } } });
  if (!values.execute) throw new Error("Real GPU work requires --execute. The fake suites use pnpm verify:image instead.");
  await realCheck(values["data-dir"] ?? path.join(os.homedir(), ".cache/gates-local-lanes/build-image/real-check"), values["comfy-url"]);
}
