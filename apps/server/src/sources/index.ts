import { randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmdirSync, statSync, writeFileSync, type Stats } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { Schema as S } from "effect";
import { Source } from "@gates-local/contracts";
import { canonicalPathSync, containsPath } from "../../../../packages/harness/src/paths.ts";
import type { LibraryEntry } from "../../../../packages/harness/src/types.ts";
import { lstatIfAny, openChild, openDir, openEntry, sameFile, unlinkIfAny, type Dir } from "./anchored.ts";
import { ownedSources, type OwnedSlot, type HeldImport, type WorkerIdentity } from "./owned.ts";
import type { SourceImport } from "@gates-local/contracts";

export interface Sources {
  list(): Source[];
  entries(): LibraryEntry[];
  add(input: { kind: Source["kind"]; path: string; label?: string }, signal?: AbortSignal): Promise<Source>;
  remove(id: string): void;
  refresh(id: string, signal?: AbortSignal): Promise<Source>;
  onChange(listener: (sources: Source[]) => void): () => void;
  allocateOwned(): OwnedSlot;
  discardOwned(id: string): void;
  rememberWorker(job: SourceImport, worker: WorkerIdentity): void;
  forgetWorker(id: string): void;
  heldImports(): HeldImport[];
  addOwned(slot: OwnedSlot, input: { kind: "sqlite" | "folder"; label: string; sizeBytes?: number; managed: NonNullable<Source["managed"]> }, signal?: AbortSignal): Promise<Source>;
}

const decodeRegistry = S.decodeUnknownSync(S.Array(Source));
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");
export const SQLITE_FILE_REFUSED = "This is a SQLite database; add it as a database source so the model reads a snapshot, never the live file.";

// VACUUM INTO runs on a worker thread so a large database never stalls the server.
// It reads a transactionally consistent view, including committed WAL frames; the
// read-only connection cannot change the live database or take its writer lock.
const VACUUM_WORKER = `
const { workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const live = new DatabaseSync(workerData.live, { readOnly: true, timeout: 5000, allowExtension: false });
try { live.prepare("VACUUM INTO ?").run(workerData.pending); } finally { live.close(); }
`;
function vacuumInto(live: string, pending: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(VACUUM_WORKER, { eval: true, workerData: { live, pending } });
    let failure: Error | undefined;
    const abort = () => { void worker.terminate().catch((error: unknown) => { failure = error instanceof Error ? error : new Error(String(error)); }); };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    worker.once("error", (e: unknown) => { failure = e instanceof Error ? e : new Error(String(e)); });
    worker.once("exit", code => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(new Error("Import interrupted while Gates Local is closing."));
      else if (failure) reject(failure);
      else if (code === 0) resolve();
      else reject(new Error(`Snapshot worker exited ${code}`));
    });
  });
}

function startsWithSqliteHeader(file: string): boolean {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(SQLITE_HEADER.length);
    return readSync(fd, head, 0, head.length, 0) === head.length && head.equals(SQLITE_HEADER);
  } finally { closeSync(fd); }
}

const what = (stat: Stats | undefined) => stat?.isSymbolicLink() ? "a link" : "not a folder";
/** A regular file with no other name: the only thing the app counts as its own copy. A hard link's other name may be outside. */
const ownFile = (stat: Stats | undefined) => stat?.isFile() === true && stat.nlink === 1;
const snapshotName = (id: string) => `${id}.db`;
/** One source's archived copies in `_archive`, newest first. */
const archivedCopies = (archive: Dir, id: string) => archive.names().flatMap(name => {
  const stat = archive.lstat(name);
  return name.startsWith(`${id}.`) && ownFile(stat) ? [{ name, mtimeMs: stat!.mtimeMs }] : [];
}).toSorted((a, b) => b.mtimeMs - a.mtimeMs);

/** Points where a test swaps an entry for a link (`beforeStep`). */
export type SwapStep = "copy-chosen" | "copy-promoting" | "dir-chmod" | "dir-listed" | "archive-listed";
export interface SourcesDeps {
  dataDir: string;
  now?: () => number;
  log?: (line: string) => void;
  /** Picks how folders are held (anchored.ts); tests pass "win32" to run the path fallback on Linux. */
  platform?: NodeJS.Platform;
  /**
   * Tests only: called at each SwapStep with the entry's name. main.ts never passes it, and
   * nothing from sources.json, the wire or the model reaches it.
   */
  beforeStep?: (step: SwapStep, name: string) => void;
}

/** Only explicit additions enter this registry; database readers see VACUUM snapshots. */
export function createSources(deps: SourcesDeps): Sources {
  mkdirSync(deps.dataDir, { recursive: true });
  const dataDir = canonicalPathSync(deps.dataDir);
  const owned = ownedSources(dataDir);
  const platform = deps.platform ?? process.platform;
  const step = deps.beforeStep ?? (() => undefined);
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  // Snapshots are copies of the owner's databases: only this user may open them. The folder is
  // held for the app's life (anchored.ts) and every snapshot operation goes through that hold,
  // so nothing done in it follows a link out of the data dir. A link there is refused as it is.
  const snapshotsPath = path.join(dataDir, "snapshots");
  try { mkdirSync(snapshotsPath, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  const snapshots = openDir(snapshotsPath, platform);
  if (!snapshots) throw new Error(`Refused ${snapshotsPath}: it is ${what(lstatIfAny(snapshotsPath))}, and database snapshots are kept only in a real folder there. It was left in place, and nothing was read or changed through it; move it away and start the app again.`);
  snapshots.chmod(0o700);
  const moved = () => new Error(`The snapshots folder ${snapshotsPath} was moved or replaced while the app was running; nothing was written, changed or deleted there. Restart the app.`);
  const registryPath = path.join(dataDir, "sources.json");
  /** What the shell binds and the sql tool opens; the app itself goes through `snapshots`. */
  const snapshotPath = (id: string) => path.join(snapshotsPath, snapshotName(id));

  type Loaded = { sources: Source[]; registry: "decoded" | "missing" | "corrupt" };
  const load = (): Loaded => {
    if (!existsSync(registryPath)) return { sources: [], registry: "missing" };
    try {
      const loaded = [...decodeRegistry(JSON.parse(readFileSync(registryPath, "utf8")))];
      // IDs form snapshot filenames; reject corrupted registry data before it can form a path.
      for (const source of loaded) if (!/^[a-zA-Z0-9_-]+$/.test(source.id)) throw new Error(`invalid source id ${JSON.stringify(source.id)}`);
      // A refresh never persists "refreshing"; an older file may still hold it. The last
      // snapshot (or the file itself) is still the last good state.
      return { registry: "decoded", sources: loaded.map(s => s.state !== "refreshing" ? s
        : s.kind !== "sqlite" || ownFile(snapshots.lstat(snapshotName(s.id))) ? { ...s, state: "ready" }
        : { ...s, state: "error", detail: "The last refresh did not finish; refresh this source again." }) };
    } catch (e) {
      const aside = `${registryPath}.bad-${now()}`;
      renameSync(registryPath, aside);
      log(`sources.json could not be read (${(e as Error).message}); kept it as ${path.basename(aside)} and started with no sources`);
      return { sources: [], registry: "corrupt" };
    }
  };
  const loaded = load();
  // Staging is disposable independently of the registry. Completed content is
  // removed only for an explicit, durable removal decision, never for absence.
  const removals = owned.recover();
  let sources = loaded.sources.filter(source => !removals.includes(source.id));
  // The first build moved every replaced snapshot to _archive/<id>.<uuid>.db and kept it for good,
  // removed sources included. Fold that layout into the one-copy-per-source policy: a registered
  // database keeps its newest copy as <id>.db (the current snapshot when there is one), and every
  // other archived copy goes. That deletion needs the registry: when it is missing or corrupt, no
  // copy's owner is known, so the whole folder is set aside for the owner and never read again.
  // Nothing here follows a link (anchored.ts): `_archive` and every entry in it are opened without
  // following one, only the app's own regular files count as copies, a chmod goes through the
  // entry's own handle, and a link is left as it is or renamed as itself, never chmodded or read.
  const ARCHIVE = "_archive";
  /** `_archive` held open, or undefined; a link or anything but a folder is refused and left in place. */
  const openArchive = (): Dir | undefined => {
    if (!snapshots.lstat(ARCHIVE)) return undefined;
    const archive = openChild(snapshots, ARCHIVE, platform);
    if (!archive) log(`refused snapshots/_archive: it is ${what(snapshots.lstat(ARCHIVE))}; it was left in place, and nothing was read, changed, moved or deleted through it`);
    return archive;
  };
  /** Renames `name` in snapshots as itself (a link stays a link) to a name the app never reads, changes or deletes. */
  const setAside = (name: string) => {
    let unclaimed = `_archive-unclaimed-${now()}`;
    if (snapshots.lstat(unclaimed)) unclaimed = `${unclaimed}-${randomUUID()}`;
    renameSync(snapshots.at(name), snapshots.at(unclaimed));
    return unclaimed;
  };
  /** Folders 0700 and files 0600 below `dir` (called `name`), each opened without following a link and changed through its own handle. */
  const makePrivate = (dir: Dir, name: string) => {
    if (!dir.placed()) return;
    step("dir-chmod", name);
    dir.chmod(0o700);
    const names = dir.names();
    step("dir-listed", name);
    for (const child of names) {
      const entry = openEntry(dir, child, platform);
      if (!entry) continue;
      try {
        if (entry.dir) makePrivate(entry.dir, child);
        else if (ownFile(entry.stat) && dir.placed()) entry.chmod(0o600);
      } finally { entry.close(); }
    }
  };
  /** Moves an archived copy to `<id>.db` only when what lands there is the regular file that was checked. */
  const promote = (archive: Dir, name: string, id: string) => {
    step("copy-chosen", name);
    const entry = openEntry(archive, name, platform);
    if (!entry || !ownFile(entry.stat) || !archive.placed()) { entry?.close(); return; }
    try {
      entry.chmod(0o600);
      step("copy-promoting", name);
      renameSync(archive.at(name), snapshots.at(snapshotName(id)));
      const landed = snapshots.lstat(snapshotName(id));
      if (landed && !sameFile(landed, entry.stat)) {
        const unclaimed = setAside(snapshotName(id));
        log(`snapshots/_archive/${name} was not the copy it checked when it was moved; what was moved was renamed to snapshots/${unclaimed} and left as it is`);
      }
    } finally { entry.close(); }
  };
  const archiveStat = snapshots.lstat(ARCHIVE);
  if (archiveStat && !archiveStat.isDirectory()) openArchive(); // refused, logged and left in place
  else if (archiveStat && loaded.registry !== "decoded") {
    // A failed rename stops the start: left in place, the folder would meet a decoded registry later.
    const unclaimed = setAside(ARCHIVE);
    // A link swapped in before the rename was renamed as itself: it opens as nothing here.
    const kept = openChild(snapshots, unclaimed, platform);
    try { if (kept) makePrivate(kept, unclaimed); }
    catch (e) { log(`snapshots/${unclaimed} could not be made private (${(e as Error).message})`); }
    finally { kept?.close(); }
    log(`snapshots/_archive was kept as snapshots/${unclaimed} because sources.json was ${loaded.registry === "missing" ? "missing" : "could not be read"}; nothing in it was deleted`);
  } else if (archiveStat) {
    const archive = openArchive();
    try {
      if (archive) {
        for (const source of sources) {
          if (source.kind !== "sqlite" || snapshots.lstat(snapshotName(source.id))) continue;
          const newest = archivedCopies(archive, source.id)[0];
          if (newest) promote(archive, newest.name, source.id);
        }
        // Only the app's own copies are the old layout's to delete; anything else is the owner's.
        const left = archive.names();
        if (left.every(name => ownFile(archive.lstat(name)))) {
          for (const name of left) { if (!archive.placed()) throw new Error("it was moved during the cleanup"); unlinkIfAny(archive, name); }
          if (archive.placed()) rmdirSync(snapshots.at(ARCHIVE));
        } else {
          const unclaimed = setAside(ARCHIVE);
          log(`snapshots/_archive held links, folders or files with other names, not only snapshot copies; it was renamed to snapshots/${unclaimed} and left as it is (nothing was read, changed or moved through it)`);
        }
      }
    } catch (e) { log(`snapshots/_archive could not be cleaned up (${(e as Error).message}); it is retried at the next start`); }
    finally { archive?.close(); }
  }
  /** What is on disk: never a "refreshing" state, so a crash mid-refresh loads back as the last good one. */
  const lastGood = new Map(sources.map(s => [s.id, s]));
  const listeners = new Set<(sources: Source[]) => void>();
  const list = () => sources.map(s => ({ ...s }));
  const save = () => {
    for (const s of sources) if (s.state !== "refreshing") lastGood.set(s.id, s);
    for (const id of lastGood.keys()) if (!sources.some(s => s.id === id)) lastGood.delete(id);
    const pending = registryPath + ".pending";
    writeFileSync(pending, JSON.stringify(sources, null, 2), { mode: 0o600 });
    renameSync(pending, registryPath);
    for (const listener of listeners) listener(list());
  };
  const checkPath = (input: { path: string; kind: Source["kind"]; id?: string; managed?: Source["managed"] }): string => {
    const canonical = canonicalPathSync(input.path);
    const appOwned = input.id !== undefined && owned.owns({ id: input.id, path: canonical });
    if (!appOwned && (containsPath(dataDir, canonical) || (input.kind === "folder" && containsPath(canonical, dataDir)))) throw new Error("Cannot connect the app's own data directory or a folder containing it");
    const stat = statSync(canonical);
    if (input.kind === "folder" ? !stat.isDirectory() : !stat.isFile()) throw new Error(`Source path must be a ${input.kind === "folder" ? "folder" : "file"}`);
    accessSync(canonical, constants.R_OK | (input.kind === "folder" ? constants.X_OK : 0));
    if (input.kind === "file" && startsWithSqliteHeader(canonical)) throw new Error(SQLITE_FILE_REFUSED);
    return canonical;
  };
  /** Deletes a source's snapshot files; while the snapshots folder or `_archive` is not where it was, nothing. */
  const removeSnapshots = (id: string) => {
    if (!snapshots.placed()) { log(moved().message); return; }
    for (const name of snapshots.names()) if (name === snapshotName(id) || (name.startsWith(`${id}.`) && name.endsWith(".pending.db"))) unlinkIfAny(snapshots, name);
    // Copies the old layout still holds when its cleanup at start could not finish.
    const archive = openArchive();
    if (!archive) return;
    try {
      const copies = archivedCopies(archive, id);
      step("archive-listed", id);
      for (const { name } of copies) if (archive.placed()) unlinkIfAny(archive, name);
    } finally { archive.close(); }
  };
  const materialize = async (source: Source, signal?: AbortSignal): Promise<Source> => {
    signal?.throwIfAborted();
    const canonical = checkPath(source);
    if (source.kind !== "sqlite") return { ...source, path: canonical, state: "ready", sizeBytes: statSync(canonical).size, detail: undefined };
    if (!snapshots.placed()) throw moved();
    const pending = `${source.id}.${randomUUID()}.pending.db`;
    try {
      await vacuumInto(canonical, snapshots.at(pending), signal);
      signal?.throwIfAborted();
      if (!snapshots.placed()) throw moved();
      const copy = openEntry(snapshots, pending, platform);
      try {
        if (!copy || !ownFile(copy.stat)) throw new Error("The snapshot was replaced while it was being made; refresh this source again.");
        copy.chmod(0o600);
        // These are the app's own derived copies: the rename replaces the previous snapshot.
        renameSync(snapshots.at(pending), snapshots.at(snapshotName(source.id)));
      } finally { copy?.close(); }
    } finally { if (snapshots.placed()) unlinkIfAny(snapshots, pending); }
    return { ...source, path: canonical, state: "ready", snapshotAt: now(), sizeBytes: snapshots.lstat(snapshotName(source.id))?.size ?? 0, detail: undefined };
  };
  const find = (id: string) => {
    const source = sources.find(s => s.id === id);
    if (!source) throw new Error(`Library source ${id} was not found`);
    return source;
  };
  /** Every addition, including verified imports, takes this same snapshot and registry path. */
  const register = async (input: Source, complete?: () => void, signal?: AbortSignal): Promise<Source> => {
    try {
      const materialized = await materialize(input, signal);
      signal?.throwIfAborted();
      const source = input.managed?.kind === "repository" && input.sizeBytes !== undefined ? { ...materialized, sizeBytes: input.sizeBytes } : materialized;
      complete?.(); // Completion must be durable before registry persistence can expose it.
      sources = [...sources, source]; save(); return { ...source };
    } catch (e) { removeSnapshots(input.id); throw e; }
  };
  // Keep the intent until both the registry update and physical removal finish.
  if (removals.length > 0) {
    if (loaded.registry === "decoded") save();
    for (const id of removals) {
      try { removeSnapshots(id); owned.finishRemoval(id); }
      catch { log("A requested Library removal is still pending and will be retried at the next start."); }
    }
  }
  return {
    list,
    entries: () => sources.filter(s => {
      if (s.state !== "ready") return false;
      try { return checkPath(s) === s.path; } catch { return false; }
    }).map(s => ({ id: s.id, kind: s.kind, label: s.label, path: s.path, ...(s.kind === "sqlite" ? { snapshotPath: snapshotPath(s.id) } : {}) })),
    async add(input, signal) {
      signal?.throwIfAborted();
      const canonical = checkPath({ kind: input.kind, path: input.path });
      return register({ id: randomUUID(), kind: input.kind, path: canonical, label: input.label?.trim() || path.basename(canonical), addedAt: now(), state: "refreshing" }, undefined, signal);
    },
    allocateOwned: () => owned.allocate(),
    discardOwned: id => owned.discard(id),
    rememberWorker: (job, worker) => owned.rememberWorker(job, worker),
    forgetWorker: id => owned.forgetWorker(id),
    heldImports: () => owned.heldImports(),
    async addOwned(slot, input, signal) {
      signal?.throwIfAborted();
      if (!owned.owns({ id: slot.id, path: slot.path })) throw new Error("This Library import is not owned by the app.");
      return register({ id: slot.id, path: slot.path, ...input, addedAt: now(), state: "refreshing" }, () => owned.complete(slot.id), signal);
    },
    remove(id) {
      const source = find(id);
      const appOwned = owned.owns(source);
      if (appOwned) owned.requestRemoval(id);
      sources = sources.filter(s => s.id !== id); save(); removeSnapshots(id);
      if (appOwned) owned.finishRemoval(id);
    },
    async refresh(id, signal) {
      signal?.throwIfAborted();
      const old = find(id);
      sources = sources.map(s => s.id === id ? { ...s, state: "refreshing" } : s); save();
      let source: Source;
      try { source = await materialize(old, signal); }
      catch (e) { source = { ...old, state: "error", detail: (e as Error).message }; }
      // Removed while the snapshot was being made: drop what it wrote.
      if (!sources.some(s => s.id === id)) { removeSnapshots(id); throw new Error(`Library source ${id} was removed during its refresh`); }
      sources = sources.map(s => s.id === id ? source : s); save(); return { ...source };
    },
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
