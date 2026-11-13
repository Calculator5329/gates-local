import type { Handlers } from "../ws/server.ts";
import type { ImageModule } from "./module.ts";
import { NO_ENGINE, type ImageSetupModule } from "./setup.ts";

export function createImageHandlers(deps: { image: ImageModule; setup?: ImageSetupModule }) {
  return {
    "image.status": () => deps.image.status(),
    "image.presets": () => deps.image.presets(),
    "image.generate": (params) => deps.image.generate(params),
    "image.cancel": ({ jobId }) => deps.image.cancel(jobId),
    "image.download": ({ preset }) => deps.image.download(preset),
    "image.stopDownload": ({ preset }) => deps.image.stopDownload(preset),
    "image.start": () => deps.image.start(),
    "image.setupInfo": async () => deps.setup === undefined ? { why: NO_ENGINE } : deps.setup.info(),
    "image.setup": async () => {
      if (deps.setup === undefined) throw Object.assign(new Error(NO_ENGINE), { code: "image-setup" });
      return deps.setup.run();
    },
  } satisfies Partial<Handlers>;
}
