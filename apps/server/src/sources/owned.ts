import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openChild, openDir, unlinkIfAny, type Dir } from "./anchored.ts";
import type { Source } from "@gates-local/contracts";
import { SourceImport } from "@gates-local/contracts";
import { Schema as S } from "effect";

export interface OwnedSlot { readonly id: string; readonly path: string; readonly work: string; }
const ID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/;
const intentName = (id: string) => id + ".remove.json";
const workerName = (id: string) => id + ".worker.json";
export const UNCONFIRMED_WORKER = "This import could not be stopped. Restart Windows to end its old worker, then retry.";
export interface WorkerIdentity { pid: number; token: string; }
export interface HeldImport { job: SourceImport; worker: WorkerIdentity | null; }
const decodeWorker = S.decodeUnknownSync(S.Struct({ job: SourceImport, worker: S.Struct({ pid: S.Number, token: S.String }) }));

/** Atomic, flushed lifecycle records. Directory fsync is available on POSIX. */
function syncDir(dir: Dir) {
  if (process.platform === "win32") return;
  const fd = openSync(dir.at("."), constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function writeRecord(dir: Dir, name: string, value: unknown) {
  if (!dir.placed()) throw new Error("The Library downloads folder moved; restart before trying again.");
  const pending = name + "." + randomUUID() + ".pending";
  writeFileSync(dir.at(pending), JSON.stringify(value), { mode: 0o600, flag: "wx", flush: true });
  if (!dir.placed()) throw new Error("The Library downloads folder moved; restart before trying again.");
  renameSync(dir.at(pending), dir.at(name));
  syncDir(dir);
}
function readRecord(dir: Dir, name: string): unknown {
  const stat = dir.lstat(name);
  if (!stat?.isFile() || stat.nlink !== 1) return undefined;
  try { return JSON.parse(readFileSync(dir.at(name), "utf8")) as unknown; } catch { return undefined; }
}

/** Completed copies never depend on registry membership for their lifetime. */
export function ownedSources(dataDir: string) {
  const rootPath = path.join(dataDir, "library-imports");
  try { mkdirSync(rootPath, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  const root = openDir(rootPath, process.platform);
  if (!root) throw new Error("The Library downloads folder is not a real folder; move it aside and restart.");
  root.chmod(0o700);
  const placed = () => { if (!root.placed()) throw new Error("The Library downloads folder moved; restart before trying again."); };
  const slot = (id: string): OwnedSlot => {
    if (!ID.test(id)) throw new Error("Invalid Library import id.");
    return { id, path: path.join(rootPath, id, "content"), work: path.join(rootPath, id) };
  };
  const opened = (id: string) => {
    placed();
    const dir = openChild(root, slot(id).id, process.platform);
    if (!dir) return undefined;
    const owner = readRecord(dir, "owner.json");
    if (typeof owner !== "object" || owner === null || !("id" in owner) || owner.id !== id) { dir.close(); return undefined; }
    return { dir, phase: "phase" in owner ? owner.phase : undefined };
  };
  // A link is unlinked as itself; traversal always uses held real folders.
  const empty = (dir: Dir) => {
    for (const name of dir.names()) {
      if (!dir.placed()) throw new Error("A Library import moved during removal.");
      const child = openChild(dir, name, process.platform);
      if (child) { try { empty(child); } finally { child.close(); } rmdirSync(dir.at(name)); }
      else unlinkIfAny(dir, name);
    }
  };
  const erase = (id: string) => {
    placed(); slot(id);
    if (root.lstat(workerName(id))) throw new Error("This import's worker must be confirmed stopped before its files can be removed.");
    const dir = openChild(root, id, process.platform);
    if (dir) {
      try { empty(dir); } finally { dir.close(); }
      placed(); rmdirSync(root.at(id));
    } else if (root.lstat(id)) unlinkIfAny(root, id);
    syncDir(root);
  };
  const hasIntent = (id: string) => {
    const value = readRecord(root, intentName(id));
    return typeof value === "object" && value !== null && "id" in value && value.id === id && "action" in value && value.action === "remove";
  };
  const discard = (id: string) => {
    placed(); slot(id);
    if (root.lstat(workerName(id))) return;
    const held = opened(id);
    if (!held) return;
    // Legacy copies with content are ambiguous and must survive. A directory
    // containing only its valid marker has no completed content to preserve.
    let staging: boolean;
    try { staging = held.phase === "staging" || held.dir.names().every(name => name === "owner.json"); }
    finally { held.dir.close(); }
    if (staging) erase(id);
  };
  return {
    allocate(): OwnedSlot {
      placed();
      const s = slot(randomUUID());
      mkdirSync(root.at(s.id), { mode: 0o700 });
      const dir = openChild(root, s.id, process.platform);
      if (!dir) throw new Error("The Library staging folder could not be opened.");
      try { writeRecord(dir, "owner.json", { id: s.id, phase: "staging" }); } finally { dir.close(); }
      syncDir(root);
      return s;
    },
    owns(source: Pick<Source, "id" | "path">): boolean {
      if (!ID.test(source.id) || source.path !== slot(source.id).path) return false;
      const held = opened(source.id);
      try { return held !== undefined && held.dir.lstat("content")?.isSymbolicLink() === false; } finally { held?.dir.close(); }
    },
    complete(id: string) {
      const held = opened(id);
      if (!held) throw new Error("This Library import is not owned by the app.");
      try {
        const content = held.dir.lstat("content");
        if (!content || !(content.isDirectory() || content.isFile())) throw new Error("The Library import has no completed content.");
        writeRecord(held.dir, "owner.json", { id, phase: "complete" });
      } finally { held.dir.close(); }
    },
    requestRemoval(id: string) {
      placed(); slot(id);
      if (!hasIntent(id)) writeRecord(root, intentName(id), { id, action: "remove" });
    },
    finishRemoval(id: string) {
      placed(); slot(id);
      if (!hasIntent(id)) throw new Error("There is no durable removal decision for this Library copy.");
      erase(id);
      unlinkIfAny(root, intentName(id));
      syncDir(root);
    },
    discard,
    rememberWorker(job: SourceImport, worker: WorkerIdentity) {
      placed(); slot(job.id);
      writeRecord(root, workerName(job.id), { job, worker });
    },
    forgetWorker(id: string) { placed(); slot(id); unlinkIfAny(root, workerName(id)); syncDir(root); },
    heldImports(): HeldImport[] {
      placed();
      return root.names().flatMap<HeldImport>(name => {
        if (!name.endsWith(".worker.json")) return [];
        const id = name.slice(0, -".worker.json".length);
        if (!ID.test(id)) return [];
        try {
          const record = decodeWorker(readRecord(root, name));
          if (record.job.id !== id || record.job.kind !== "repository" || !Number.isSafeInteger(record.worker.pid) || record.worker.pid <= 0 || record.worker.pid > 0x7fffffff || !ID.test(record.worker.token)) throw new Error("Invalid worker record");
          return [record];
        } catch {
          // An unreadable ownership record never authorizes cleanup or reuse.
          return [{ worker: null, job: { id, key: id, label: "Interrupted repository import " + id, kind: "repository" as const, state: "cloning" as const, bytes: 0, detail: "The worker record could not be read. Restart Windows before moving this import's staging folder and worker record aside." } }];
        }
      });
    },
    recover(): string[] {
      placed();
      const removals: string[] = [];
      for (const name of root.names()) {
        if (ID.test(name)) discard(name);
        else if (name.endsWith(".remove.json")) {
          const id = name.slice(0, -".remove.json".length);
          if (ID.test(id) && hasIntent(id)) removals.push(id);
        }
      }
      return removals;
    },
  };
}
