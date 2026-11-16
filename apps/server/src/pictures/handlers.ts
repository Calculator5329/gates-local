import type { Handlers } from "../ws/server.ts";
import type { ThreadStore } from "../threads/store.ts";
import { backfillPictures } from "./backfill.ts";

export function createPicturesModule(deps: { store: Pick<ThreadStore, "pictures">; dataDir: string; log: (line: string) => void }) {
  const ready = backfillPictures(deps).catch((error: unknown) => deps.log(`picture index not filled: ${error instanceof Error ? error.message : String(error)}`));
  const handlers = {
    "pictures.list": async (params) => {
      // why: the first page after an update already counts every earlier picture.
      await ready;
      return deps.store.pictures.list(params);
    },
  } satisfies Partial<Handlers>;
  return { handlers, ready };
}
