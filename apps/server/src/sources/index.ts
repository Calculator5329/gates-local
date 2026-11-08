import { randomUUID } from "node:crypto";
import { accessSync, chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { Schema as S } from "effect";
import { Source } from "@gates-local/contracts";
import { canonicalPathSync, containsPath } from "../../../../packages/harness/src/paths.ts";
import type { LibraryEntry } from "../../../../packages/harness/src/types.ts";

export interface Sources {
  list(): Source[];
  entries(): LibraryEntry[];
  add(input: { kind: Source["kind"]; path: string; label?: string }): Promise<Source>;
  remove(id: string): void;
  refresh(id: string): Promise<Source>;
  onChange(listener: (sources: Source[]) => void): () => void;
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
function vacuumInto(live: string, pending: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(VACUUM_WORKER, { eval: true, workerData: { live, pending } });
    let failure: Error | undefined;
    worker.once("error", (e: unknown) => { failure = e instanceof Error ? e : new Error(String(e)); });
    worker.once("exit", code => failure ? reject(failure) : code === 0 ? resolve() : reject(new Error(`Snapshot worker exited ${code}`)));
  });
}

function startsWithSqliteHeader(file: string): boolean {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(SQLITE_HEADER.length);
    return readSync(fd, head, 0, head.length, 0) === head.length && head.equals(SQLITE_HEADER);
  } finally { closeSync(fd); }
}

/** Only explicit additions enter this registry; database readers see VACUUM snapshots. */
export function createSources(deps: { dataDir: string; now?: () => number; log?: (line: string) => void }): Sources {
  mkdirSync(deps.dataDir, { recursive: true });
  const dataDir = canonicalPathSync(deps.dataDir);
  // Snapshots are copies of the owner's databases: only this user may open them.
  const snapshots = path.join(dataDir, "snapshots");
  mkdirSync(snapshots, { recursive: true, mode: 0o700 });
  chmodSync(snapshots, 0o700);
  const registryPath = path.join(dataDir, "sources.json");
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const snapshotPath = (id: string) => path.join(snapshots, `${id}.db`);

  const load = (): Source[] => {
    if (!existsSync(registryPath)) return [];
    try {
      const loaded = [...decodeRegistry(JSON.parse(readFileSync(registryPath, "utf8")))];
      // IDs form snapshot filenames; reject corrupted registry data before it can form a path.
      for (const source of loaded) if (!/^[a-zA-Z0-9_-]+$/.test(source.id)) throw new Error(`invalid source id ${JSON.stringify(source.id)}`);
      // A refresh never persists "refreshing"; an older file may still hold it. The last
      // snapshot (or the file itself) is still the last good state.
      return loaded.map(s => s.state !== "refreshing" ? s
        : s.kind !== "sqlite" || existsSync(snapshotPath(s.id)) ? { ...s, state: "ready" }
        : { ...s, state: "error", detail: "The last refresh did not finish; refresh this source again." });
    } catch (e) {
      const aside = `${registryPath}.bad-${now()}`;
      renameSync(registryPath, aside);
      log(`sources.json could not be read (${(e as Error).message}); kept it as ${path.basename(aside)} and started with no sources`);
      return [];
    }
  };
  let sources = load();
  // The first build moved every replaced snapshot to _archive/<id>.<uuid>.db and kept it for good,
  // removed sources included. Fold that layout into the one-copy-per-source policy: a registered
  // database keeps its newest copy as <id>.db (the current snapshot when there is one), and every
  // other archived copy goes.
  const archive = path.join(snapshots, "_archive");
  const archivedCopies = (id?: string) => !existsSync(archive) ? [] : readdirSync(archive)
    .filter(name => id === undefined || name.startsWith(`${id}.`)).map(name => path.join(archive, name));
  if (existsSync(archive)) {
    try {
      for (const source of sources) {
        if (source.kind !== "sqlite" || existsSync(snapshotPath(source.id))) continue;
        const newest = archivedCopies(source.id).filter(file => statSync(file).isFile()).toSorted((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
        if (newest) { chmodSync(newest, 0o600); renameSync(newest, snapshotPath(source.id)); }
      }
      rmSync(archive, { recursive: true, force: true });
    } catch (e) { log(`snapshots/_archive could not be cleaned up (${(e as Error).message}); it is retried at the next start`); }
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
  const checkPath = (input: { path: string; kind: Source["kind"] }): string => {
    const canonical = canonicalPathSync(input.path);
    if (containsPath(dataDir, canonical) || (input.kind === "folder" && containsPath(canonical, dataDir))) throw new Error("Cannot connect the app's own data directory or a folder containing it");
    const stat = statSync(canonical);
    if (input.kind === "folder" ? !stat.isDirectory() : !stat.isFile()) throw new Error(`Source path must be a ${input.kind === "folder" ? "folder" : "file"}`);
    accessSync(canonical, constants.R_OK | (input.kind === "folder" ? constants.X_OK : 0));
    if (input.kind === "file" && startsWithSqliteHeader(canonical)) throw new Error(SQLITE_FILE_REFUSED);
    return canonical;
  };
  const removeSnapshots = (id: string) => {
    for (const name of readdirSync(snapshots)) if (name === `${id}.db` || (name.startsWith(`${id}.`) && name.endsWith(".pending.db"))) rmSync(path.join(snapshots, name), { force: true });
    // Copies the old layout still holds when its cleanup at start could not finish.
    for (const file of archivedCopies(id)) rmSync(file, { force: true });
  };
  const materialize = async (source: Source): Promise<Source> => {
    const canonical = checkPath(source);
    if (source.kind !== "sqlite") return { ...source, path: canonical, state: "ready", sizeBytes: statSync(canonical).size, detail: undefined };
    const destination = snapshotPath(source.id);
    const pending = path.join(snapshots, `${source.id}.${randomUUID()}.pending.db`);
    try {
      await vacuumInto(canonical, pending);
      chmodSync(pending, 0o600);
      // These are the app's own derived copies: the rename replaces the previous snapshot.
      renameSync(pending, destination);
    } finally { rmSync(pending, { force: true }); }
    return { ...source, path: canonical, state: "ready", snapshotAt: now(), sizeBytes: statSync(destination).size, detail: undefined };
  };
  const find = (id: string) => {
    const source = sources.find(s => s.id === id);
    if (!source) throw new Error(`Library source ${id} was not found`);
    return source;
  };
  return {
    list,
    entries: () => sources.filter(s => {
      if (s.state !== "ready") return false;
      try { return checkPath(s) === s.path; } catch { return false; }
    }).map(s => ({ id: s.id, kind: s.kind, label: s.label, path: s.path, ...(s.kind === "sqlite" ? { snapshotPath: snapshotPath(s.id) } : {}) })),
    async add(input) {
      const canonical = checkPath(input);
      const id = randomUUID();
      try {
        const source = await materialize({ id, kind: input.kind, path: canonical, label: input.label?.trim() || path.basename(canonical), addedAt: now(), state: "refreshing" });
        sources = [...sources, source]; save(); return { ...source };
      } catch (e) { removeSnapshots(id); throw e; }
    },
    remove(id) { find(id); sources = sources.filter(s => s.id !== id); save(); removeSnapshots(id); },
    async refresh(id) {
      const old = find(id);
      sources = sources.map(s => s.id === id ? { ...s, state: "refreshing" } : s); save();
      let source: Source;
      try { source = await materialize(old); }
      catch (e) { source = { ...old, state: "error", detail: (e as Error).message }; }
      // Removed while the snapshot was being made: drop what it wrote.
      if (!sources.some(s => s.id === id)) { removeSnapshots(id); throw new Error(`Library source ${id} was removed during its refresh`); }
      sources = sources.map(s => s.id === id ? source : s); save(); return { ...source };
    },
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
