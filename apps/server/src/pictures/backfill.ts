// Fills the pictures index from finished cards that have no row: every picture made before the index,
// and any an older build finished since. The missing rows are the only marker, so a second run finds
// nothing to do and a run cut short finishes on the next start. Seed and steps come from the file's
// `prompt` chunk, the done time from its mtime (the rename at save); the run time was never kept.
import { stat } from "node:fs/promises";
import path from "node:path";
import type { ThreadStore } from "../threads/store.ts";
import { chunkFacts, readPngFacts } from "./png.ts";

const safeImage = /^images\/[a-zA-Z0-9_-]+\.png$/;

export async function backfillPictures(deps: { store: Pick<ThreadStore, "pictures">; dataDir: string; log?: (line: string) => void }): Promise<void> {
  const { pictures } = deps.store;
  let filled = 0;
  for (const card of pictures.unindexed()) {
    if (!safeImage.test(card.imagePath)) continue;
    const file = path.join(deps.dataDir, card.imagePath);
    try {
      const [info, png] = await Promise.all([stat(file), readPngFacts(file)]);
      if (!info.isFile() || png === undefined) continue;
      // Each row is its own write: a kill leaves whole rows and the rest for next time.
      pictures.fill(card.jobId, { ...chunkFacts(png.text), width: png.width, height: png.height, bytes: info.size, doneAt: Math.round(info.mtimeMs) });
      filled++;
    } catch (error) {
      // A file gone since the card was read is not a picture; anything else is said once per card.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") deps.log?.(`picture ${card.jobId} not indexed: ${(error as Error).message}`);
    }
  }
  if (filled > 0) deps.log?.(`indexed ${filled} earlier pictures`);
}
