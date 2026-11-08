// The real image module over an injected ComfyUI service and HTTP fake, with
// an idle ComfyUI the app started: one job started the service, then failed
// before rendering, so the module owns a ComfyUI that close() must stop. No
// request reaches a real ComfyUI and nothing calls systemctl.
import path from "node:path";
import type { GpuLease } from "../gpu/lease.ts";
import { createImageModule, type ImageModule } from "../image/module.ts";
import { openThreadStore } from "../threads/store.ts";

export interface OwnedComfy {
  readonly image: ImageModule;
  /** comfyui.service stop calls so far. */
  stops(): number;
  close(): void;
}

export async function ownedIdleComfy(lease: GpuLease, dir: string): Promise<OwnedComfy> {
  const store = openThreadStore(path.join(dir, "image-threads.sqlite"));
  const calls: string[] = [];
  let active = false;
  const image = createImageModule({
    dataDir: dir,
    lease,
    store,
    push: () => undefined,
    settings: () => ({ imageGen: true }),
    appLoadedModels: () => [],
    ollamaUrl: () => undefined,
    readGpu: async () => ({ freeBytes: 1e12, holders: "nothing else" }),
    requiredBytes: 1,
    // Only close() stops it: no idle timer fires during a test.
    idleMs: 3_600_000,
    startupTimeoutMs: 2000,
    localAddresses: () => [],
    lookupHost: async () => ["127.0.0.1"],
    service: {
      inspect: async () => ({ present: true, active, activeState: active ? "active" : "inactive", pid: active ? 4242 : 0 }),
      start: async () => {
        calls.push("start");
        active = true;
      },
      stop: async () => {
        calls.push("stop");
        active = false;
      },
    },
    fetch: async (input) => {
      const route = new URL(String(input)).pathname;
      if (!active) throw new Error("connect ECONNREFUSED (fake ComfyUI is stopped)");
      if (route === "/system_stats") return Response.json({ system: { comfyui_version: "fake" }, devices: [{ type: "cuda", torch_vram_total: 0 }] });
      if (route === "/queue") return Response.json({ queue_running: [], queue_pending: [] });
      // The job ends here, before rendering: the module keeps the ComfyUI it started.
      return Response.json({ error: `no ${route} in this fake` }, { status: 500 });
    },
  });
  const { jobId } = await image.generate({ prompt: "a tree" });
  await image.wait(jobId);
  if (image.current().owner !== "app" || !calls.includes("start")) throw new Error(`the fake ComfyUI was not app-owned: ${JSON.stringify(image.current())}`);
  return { image, stops: () => calls.filter((c) => c === "stop").length, close: () => store.close() };
}
