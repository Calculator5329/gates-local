import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Schema as S } from "effect";
import { Source } from "@gates-local/contracts";
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
const contains = (parent: string, file: string) => {
  const relative = path.relative(parent, file);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

/** Only explicit additions enter this registry; database readers see VACUUM snapshots. */
export function createSources(deps: { dataDir: string; now?: () => number }): Sources {
  mkdirSync(deps.dataDir, { recursive: true });
  const dataDir = realpathSync(deps.dataDir);
  const snapshots = path.join(dataDir, "snapshots");
  mkdirSync(snapshots, { recursive: true });
  const registryPath = path.join(dataDir, "sources.json");
  const now = deps.now ?? Date.now;
  let sources = existsSync(registryPath) ? [...decodeRegistry(JSON.parse(readFileSync(registryPath, "utf8")))] : [];
  // IDs form snapshot filenames; reject corrupted registry data before it can form a path.
  for (const source of sources) if (!/^[a-zA-Z0-9_-]+$/.test(source.id)) throw new Error("Invalid Library source id in registry");
  const listeners = new Set<(sources: Source[]) => void>();
  const list = () => sources.map(s => ({ ...s }));
  const save = () => {
    const pending = registryPath + ".pending";
    writeFileSync(pending, JSON.stringify(sources, null, 2), { mode: 0o600 });
    renameSync(pending, registryPath);
    for (const listener of listeners) listener(list());
  };
  const checkPath = (input: { path: string; kind: Source["kind"] }): string => {
    const canonical = realpathSync(input.path);
    if (contains(dataDir, canonical) || (input.kind === "folder" && contains(canonical, dataDir))) throw new Error("Cannot connect the app's own data directory or a folder containing it");
    const stat = statSync(canonical);
    if (input.kind === "folder" ? !stat.isDirectory() : !stat.isFile()) throw new Error(`Source path must be a ${input.kind === "folder" ? "folder" : "file"}`);
    accessSync(canonical, constants.R_OK | (input.kind === "folder" ? constants.X_OK : 0));
    return canonical;
  };
  const snapshotPath = (id: string) => path.join(snapshots, `${id}.db`);
  const materialize = (source: Source): Source => {
    const canonical = checkPath(source);
    if (source.kind !== "sqlite") return { ...source, path: canonical, state: "ready", sizeBytes: statSync(canonical).size, detail: undefined };
    const destination = snapshotPath(source.id);
    const pending = path.join(snapshots, `${source.id}.${randomUUID()}.pending.db`);
    const live = new DatabaseSync(canonical, { readOnly: true, timeout: 5000, allowExtension: false });
    try {
      // VACUUM INTO reads a transactionally consistent view, including committed WAL frames.
      // The read-only connection cannot change the live database or take its writer lock.
      live.prepare("VACUUM INTO ?").run(pending);
    } finally { live.close(); }
    if (existsSync(destination)) {
      const archive = path.join(snapshots, "_archive"); mkdirSync(archive, { recursive: true });
      renameSync(destination, path.join(archive, `${source.id}.${randomUUID()}.db`));
    }
    renameSync(pending, destination);
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
      const source = materialize({ id: randomUUID(), kind: input.kind, path: canonical, label: input.label?.trim() || path.basename(canonical), addedAt: now(), state: "refreshing" });
      sources = [...sources, source]; save(); return { ...source };
    },
    remove(id) { find(id); sources = sources.filter(s => s.id !== id); save(); },
    async refresh(id) {
      const old = find(id);
      sources = sources.map(s => s.id === id ? { ...s, state: "refreshing" } : s); save();
      try {
        const source = materialize(old);
        sources = sources.map(s => s.id === id ? source : s); save(); return { ...source };
      } catch (e) {
        const source: Source = { ...old, state: "error", detail: (e as Error).message };
        sources = sources.map(s => s.id === id ? source : s); save(); return { ...source };
      }
    },
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
