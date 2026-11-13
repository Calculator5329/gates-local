// Non-image files a person attaches (chat row 3, owner pick C, 2026-11-11): "to get all
// content from the file might not fit in the context window". The server keeps its own copy
// under files/ in the data folder, the message names it, and only that thread's turns may
// read it, with the read tool, by its label. Its contents never go into the prompt.
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AttachedFile } from "@gates-local/contracts";
import type { LibraryEntry } from "../../../../packages/harness/src/index.ts";

const sizeWords = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
const FILE_PATH = /^files\/att-[a-f0-9-]{36}$/;
const NAME = /^att-[a-f0-9-]{36}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const unavailable = (name: string) => new Error(`${name} is no longer attached. Attach it again; your words are kept.`);

/** The copy's folder, made if missing, refused when it is a link out of the data folder. */
async function folder(dataDir: string): Promise<string> {
  await mkdir(path.join(dataDir, "files"), { recursive: true, mode: 0o700 });
  const root = path.join(await realpath(dataDir), "files");
  if (await realpath(root) !== root) throw new Error("The attached-files folder is not available.");
  return root;
}

/** files.attach: the bytes go to a generated name; the person's file name is only ever the label. */
export async function saveFile(dataDir: string, input: { name: string; type: string; data: string }): Promise<AttachedFile> {
  // Base64 is 4 characters per 3 bytes: refuse an oversized upload before decoding it.
  if (input.data.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) throw new Error(`${input.name} is over 50 MB, so it was not attached.`);
  const bytes = Buffer.from(input.data, "base64");
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`${input.name} is over 50 MB, so it was not attached.`);
  const root = await folder(dataDir);
  const name = `att-${randomUUID()}`;
  const handle = await open(path.join(root, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.writeFile(bytes); } finally { await handle.close(); }
  return { path: `files/${name}`, name: input.name, size: bytes.length, type: input.type };
}

/** chat.send: every file is a regular file under files/ (never a link), sized as stored. */
export async function checkFiles(dataDir: string, files: readonly AttachedFile[]): Promise<AttachedFile[]> {
  if (!files.length) return [];
  const root = await folder(dataDir);
  return Promise.all(files.map(async file => {
    if (!FILE_PATH.test(file.path)) throw unavailable(file.name);
    const info = await lstat(path.join(root, path.basename(file.path))).catch(() => undefined);
    if (!info?.isFile()) throw unavailable(file.name);
    return { ...file, size: info.size };
  }));
}

/**
 * The one line the model gets for each file in the message that carries it: label, size and
 * type, and where to read it. With tools off it is told it cannot open the file.
 */
export function fileLine(file: AttachedFile, entry: LibraryEntry | undefined): string {
  const facts = [sizeWords(file.size), file.type || undefined].filter(Boolean).join(", ");
  const where = entry ? `read it with the read tool at /library/${entry.id}` : "you cannot open it in this reply, because tools are off";
  return `[Attached file "${file.name}" (${facts}): ${where}.]`;
}

/** A label as a Library id ([\w-]+, as the sandbox needs), unique beside the ids already taken. */
function idFor(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "file";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/** The thread's files as read-only Library entries for one turn: the read tool and the shell's read-only binds take them. */
export async function fileSources(dataDir: string, files: readonly AttachedFile[], library: readonly LibraryEntry[]): Promise<Map<string, LibraryEntry>> {
  const entries = new Map<string, LibraryEntry>();
  if (!files.length) return entries;
  const root = await folder(dataDir);
  const taken = new Set(library.map(s => s.id));
  for (const file of files) {
    if (entries.has(file.path) || !FILE_PATH.test(file.path)) continue;
    entries.set(file.path, { id: idFor(file.name, taken), kind: "file", label: file.name, path: path.join(root, path.basename(file.path)) });
  }
  return entries;
}

interface References { fileReferences(): ReadonlyMap<string, number>; }

/** Saved messages own the copies. A copy no message holds is removed with its last message, or after a day (a draft or queue may still send it). */
export function fileLifecycle(dataDir: string, store: References) {
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work, work);
    tail = result.catch(() => undefined);
    return result;
  };
  const collect = async (paths: readonly string[]) => {
    let root: string;
    try { root = await folder(dataDir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const refs = store.fileReferences();
    for (const file of new Set(paths)) {
      // Only a generated name, joined under this folder: a stored path cannot reach anywhere else.
      if (!FILE_PATH.test(file) || (refs.get(file) ?? 0) > 0) continue;
      try { await unlink(path.join(root, path.basename(file))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  };
  return {
    collect: (paths: readonly string[]) => serial(() => collect(paths)),
    /** The message row goes in inside the queue, so a collect cannot remove a copy it is about to hold. */
    save: <T>(files: readonly AttachedFile[], append: () => T): Promise<T> => serial(async () => {
      await checkFiles(dataDir, files);
      return append();
    }),
    sweep: () => serial(async () => {
      const root = await folder(dataDir);
      for (const name of await readdir(root)) {
        if (!NAME.test(name)) continue;
        const info = await lstat(path.join(root, name)).catch(() => undefined);
        if (info && Date.now() - info.mtimeMs >= DAY_MS) await collect([`files/${name}`]);
      }
    }),
  };
}
