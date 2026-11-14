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
  /** POST /free calls so far (the memory owner's handoff): ComfyUI stays up and gives its weights back. */
  frees(): number;
  /**
   * The next service.inspect(), stop() or POST /free waits for release() (a /free also ends on its
   * request's abort); `asked` resolves when it is called.
   */
  hold(call: "inspect" | "stop" | "free"): { asked: Promise<void>; release(): void };
  close(): void;
}

export async function ownedIdleComfy(lease: GpuLease, dir: string): Promise<OwnedComfy> {
  const store = openThreadStore(path.join(dir, "image-threads.sqlite"));
  const calls: string[] = [];
  let active = false;
  const holds = new Map<string, { ask: () => void; until: Promise<void> }>();
  const held = async (call: string) => {
    const h = holds.get(call);
    holds.delete(call);
    h?.ask();
    await h?.until;
  };
  const image = createImageModule({
    dataDir: dir,
    lease,
    store,
    push: () => undefined,
    settings: () => ({ imageGen: true }),
    readGpu: async () => ({ freeBytes: 1e12, holders: "nothing else" }),
    requiredBytes: 1,
    // Only close() stops it: no idle timer fires during a test.
    idleMs: 3_600_000,
    startupTimeoutMs: 2000,
    localAddresses: () => [],
    lookupHost: async () => ["127.0.0.1"],
    service: {
      inspect: async () => {
        await held("inspect");
        return { present: true, active, activeState: active ? "active" : "inactive", pid: active ? 4242 : 0 };
      },
      start: async () => {
        calls.push("start");
        active = true;
      },
      stop: async () => {
        await held("stop");
        calls.push("stop");
        active = false;
      },
    },
    fetch: async (input, init) => {
      const route = new URL(String(input)).pathname;
      if (!active) throw new Error("connect ECONNREFUSED (fake ComfyUI is stopped)");
      if (route === "/system_stats") return Response.json({ system: { comfyui_version: "fake" }, devices: [{ type: "cuda", torch_vram_total: 0 }] });
      if (route === "/queue") return Response.json({ queue_running: [], queue_pending: [] });
      if (route === "/free") {
        const signal = init?.signal ?? undefined;
        const aborted = new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
        await Promise.race([held("free"), aborted]);
        calls.push("free");
        return new Response(null, { status: 200 });
      }
      // The job ends here, before rendering: the module keeps the ComfyUI it started.
      return Response.json({ error: `no ${route} in this fake` }, { status: 500 });
    },
  });
  const { jobId } = await image.generate({ prompt: "a tree" });
  await image.wait(jobId);
  if (image.current().owner !== "app" || !calls.includes("start")) throw new Error(`the fake ComfyUI was not app-owned: ${JSON.stringify(image.current())}`);
  const hold = (call: "inspect" | "stop" | "free") => {
    let ask!: () => void;
    let release!: () => void;
    const asked = new Promise<void>((r) => (ask = r));
    holds.set(call, { ask, until: new Promise<void>((r) => (release = r)) });
    return { asked, release };
  };
  return { image, stops: () => calls.filter((c) => c === "stop").length, frees: () => calls.filter((c) => c === "free").length, hold, close: () => store.close() };
}
