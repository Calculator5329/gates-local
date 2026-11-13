import { mkdir, readdir, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";

interface References {
  imageReferences(): ReadonlyMap<string, number>;
}
const safeImage = (image: string) => /^images\/[a-zA-Z0-9_-]+\.(png|jpeg|gif|webp)$/.test(image);

/** Saved messages own files. Unreferenced uploads get a full day for drafts and queues. */
export function imageLifecycle(dataDir: string, store: References) {
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work, work);
    tail = result.catch(() => undefined);
    return result;
  };
  const collect = async (images: readonly string[]) => {
    const root = path.join(await realpath(dataDir), "images");
    try { if (await realpath(root) !== root) throw new Error("The image folder is not available."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const image of new Set(images)) {
      if (!safeImage(image) || (store.imageReferences().get(image) ?? 0) > 0) continue;
      // A picture's thumbnail (pictures/thumbs.ts) goes with it.
      const base = path.basename(image);
      for (const file of [base, `thumbs/${base.replace(/\.[a-z]+$/, "")}.webp`]) {
        try { await unlink(path.join(root, file)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
  };
  return {
    /** The one queue collection runs in: work here cannot pass a collect. */
    queue: serial,
    collect: (images: readonly string[]) => serial(() => collect(images)),
    // Collection and the synchronous row insert cannot pass one another.
    save: <T>(images: readonly string[], append: () => T): Promise<T> => serial(async () => {
      for (const image of images) {
        const filename = path.join(dataDir, image);
        if (!safeImage(image) || await realpath(filename).catch(() => "") !== filename) throw new Error("An attached image is no longer available. Paste it again; your words are kept.");
      }
      return append();
    }),
    sweep: () => serial(async () => {
      await mkdir(path.join(dataDir, "images"), { recursive: true });
      const files = await readdir(path.join(dataDir, "images"));
      for (const name of files) {
        if (!/^paste-[a-f0-9-]+\.(png|jpeg|gif|webp)$/.test(name)) continue;
        const info = await stat(path.join(dataDir, "images", name));
        if (Date.now() - info.mtimeMs >= 24 * 60 * 60 * 1000) await collect([`images/${name}`]);
      }
    }),
  };
}
