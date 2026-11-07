// gpu.status answers with a fresh reading; the watcher pushes gpu.changed.
import type { Handlers } from "../ws/server.ts";
import type { GpuWatcher } from "./gpu-watch.ts";

export function createGpuHandlers(deps: { readonly gpu: GpuWatcher }) {
  return {
    "gpu.status": () => deps.gpu.read(),
  } satisfies Partial<Handlers>;
}
