import type { Handlers } from "../ws/server.ts";
import type { ImageModule } from "./module.ts";

export function createImageHandlers(deps: { image: ImageModule }) {
  return {
    "image.status": () => deps.image.status(),
    "image.presets": () => deps.image.presets(),
    "image.generate": (params) => deps.image.generate(params),
    "image.cancel": ({ jobId }) => deps.image.cancel(jobId),
  } satisfies Partial<Handlers>;
}
