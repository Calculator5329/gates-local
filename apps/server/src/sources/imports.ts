import { createHash } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SourceImport, SourceImports } from "@gates-local/contracts";
import type { Handlers } from "../ws/server.ts";
import type { Sources } from "./index.ts";
import { IMPORT_MS, cloneRepository, githubRepo, importSize, type GitTransport } from "./clone.ts";
import { SAMPLES, SAMPLE_LICENSE, type PinnedSample } from "./samples.ts";
import { openDir, openChild, unlinkIfAny, type Dir } from "./anchored.ts";
import { rmdirSync } from "node:fs";

export interface ImportsDeps {
  sources: Sources;
  fetch?: typeof fetch;
  samples?: readonly PinnedSample[];
  git?: GitTransport;
  timeoutMs?: number;
  now?: () => number;
}
export type LibraryImports = ReturnType<typeof createLibraryImports>;

const MAX_ACTIVE_IMPORTS = 2;
const MAX_IMPORT_JOBS = 20;
const FAILED_RETRY_MS = 5 * 60_000;

/** Download only the pinned bytes; redirects, oversize and underlength are refused before add. */
async function download(sample: PinnedSample, file: string, signal: AbortSignal, progress: (bytes: number) => void, get: typeof fetch) {
  if (new URL(sample.url).protocol !== "https:") throw new Error("Sample downloads require HTTPS.");
  const response = await get(sample.url, { signal, redirect: "error", credentials: "omit" });
  if (!response.ok || !response.body) throw new Error("The sample could not be downloaded. Check your connection and retry.");
  const stated = response.headers.get("content-length");
  if (stated !== null && Number(stated) !== sample.sizeBytes) { await response.body.cancel(); throw new Error("The sample has the wrong size. Nothing was added; retry later."); }
  const handle = await open(file, "wx", 0o600);
  const hash = createHash("sha256");
  let bytes = 0;
  let head = Buffer.alloc(0);
  try {
    for await (const part of response.body) {
      signal.throwIfAborted();
      bytes += part.length;
      if (bytes > sample.sizeBytes) throw new Error("The sample has the wrong size. Nothing was added; retry later.");
      if (head.length < 16) head = Buffer.concat([head, part]).subarray(0, 16);
      hash.update(part);
      await handle.writeFile(part);
      progress(bytes);
    }
    if (bytes !== sample.sizeBytes) throw new Error("The sample has the wrong size. Nothing was added; retry later.");
    if (hash.digest("hex") !== sample.sha256) throw new Error("The sample failed its checksum. Nothing was added; retry later.");
    if (!head.equals(Buffer.from("SQLite format 3\0"))) throw new Error("The sample is not a SQLite database. Nothing was added; retry later.");
  } finally { await handle.close(); }
}

/** Deletes clone metadata before the ordinary folder path can expose or index it. */
function stripGit(folder: string) {
  const root = openDir(folder, process.platform);
  if (!root) throw new Error("The cloned folder could not be opened.");
  const empty = (dir: Dir) => {
    for (const name of dir.names()) {
      if (!dir.placed()) throw new Error("The cloned folder moved.");
      const child = openChild(dir, name, process.platform);
      if (child) { try { empty(child); } finally { child.close(); } rmdirSync(dir.at(name)); }
      else unlinkIfAny(dir, name);
    }
  };
  try {
    const git = openChild(root, ".git", process.platform);
    if (!git) throw new Error("The clone did not finish.");
    try { empty(git); } finally { git.close(); }
    rmdirSync(root.at(".git"));
  } finally { root.close(); }
}

export function createLibraryImports(deps: ImportsDeps) {
  const samples = deps.samples ?? SAMPLES;
  const jobs = new Map<string, SourceImport>();
  const running = new Map<string, AbortController>();
  const finishedAt = new Map<string, number>();
  const now = deps.now ?? Date.now;
  const listeners = new Set<(value: SourceImports) => void>();
  const snapshot = (): SourceImports => ({ samples: samples.map(s => ({ id: s.id, label: s.label, description: s.description, sizeBytes: s.sizeBytes, url: s.url, license: s.license, licenseUrl: s.licenseUrl })), jobs: [...jobs.values()].map(j => ({ ...j })) });
  const emit = () => { const value = snapshot(); for (const listener of listeners) listener(value); };
  const update = (id: string, patch: Partial<SourceImport>) => { const old = jobs.get(id); if (old) { jobs.set(id, { ...old, ...patch }); emit(); } };
  const begin = (kind: SourceImport["kind"], key: string, label: string, sample?: PinnedSample): SourceImport => {
    const existing = deps.sources.list().find(s => s.managed?.kind === kind && s.managed.key.toLowerCase() === key.toLowerCase());
    if (existing) return { id: existing.id, key, label, kind, state: "ready", bytes: existing.sizeBytes ?? 0, sourceId: existing.id };
    const active = [...jobs.values()].find(j => j.kind === kind && j.key.toLowerCase() === key.toLowerCase() && running.has(j.id));
    if (active) return { ...active };
    if (running.size >= MAX_ACTIVE_IMPORTS) throw new Error("The Library can run 2 imports at once. Wait for one to finish or cancel one, then retry.");
    // Reserve history space before starting work. Recent failures can only be
    // replaced by their own Retry; when all slots are protected, refuse new work.
    const evictions = new Set([...jobs.values()].filter(j => j.kind === kind && j.key.toLowerCase() === key.toLowerCase()).map(j => j.id));
    for (const [id, ended] of finishedAt) {
      if (jobs.size - evictions.size < MAX_IMPORT_JOBS) break;
      const job = jobs.get(id);
      if (job && (job.state !== "error" || now() - ended >= FAILED_RETRY_MS)) evictions.add(id);
    }
    if (jobs.size - evictions.size >= MAX_IMPORT_JOBS) throw new Error("The Library import history is full of recent failures. Retry an existing import or wait five minutes.");
    const slot = deps.sources.allocateOwned();
    const controller = new AbortController();
    const signal = controller.signal;
    const job: SourceImport = { id: slot.id, key, label, kind, state: kind === "sample" ? "downloading" : "cloning", bytes: 0, ...(sample ? { total: sample.sizeBytes } : {}) };
    for (const id of evictions) { jobs.delete(id); finishedAt.delete(id); }
    jobs.set(slot.id, job);
    running.set(slot.id, controller);
    emit();
    const timer = setTimeout(() => controller.abort(new Error("This import took too long. Check your connection and retry.")), deps.timeoutMs ?? IMPORT_MS);
    let scanning = false;
    const monitor = kind === "repository" ? setInterval(() => {
      if (scanning || signal.aborted) return;
      scanning = true;
      void importSize(slot.work, signal).then(bytes => update(slot.id, { bytes }), e => { if (!signal.aborted) controller.abort(e); }).finally(() => { scanning = false; });
    }, 50) : undefined;
    void (async () => {
      let added: string | undefined;
      let sourceBytes: number | undefined;
      try {
        const progress = (bytes: number) => update(slot.id, { bytes });
        if (sample) {
          await download(sample, slot.path, signal, progress, deps.fetch ?? fetch);
          await writeFile(path.join(slot.work, "LICENSE.txt"), SAMPLE_LICENSE, { mode: 0o600, flag: "wx" });
        }
        else {
          const bytes = await cloneRepository({ url: key, work: slot.work, destination: slot.path, signal, progress, onStopUnconfirmed: () => update(slot.id, { detail: "This import could not be stopped. Restart the app to retry." }), ...(deps.git ? { git: deps.git } : {}) });
          sourceBytes = bytes;
          if (monitor) clearInterval(monitor);
          signal.throwIfAborted();
          stripGit(slot.path);
          update(slot.id, { bytes });
        }
        signal.throwIfAborted();
        update(slot.id, { state: "adding" });
        const source = await deps.sources.addOwned(slot, { kind: sample ? "sqlite" : "folder", label, sizeBytes: sourceBytes, managed: { kind, key } });
        added = source.id;
        signal.throwIfAborted();
        update(slot.id, { state: "ready", sourceId: source.id });
      } catch (error) {
        let cleanup = "";
        try {
          if (added) deps.sources.remove(added);
          else deps.sources.discardOwned(slot.id);
        } catch { cleanup = " The partial copy could not be cleaned up. Restart Gates Local before retrying."; }
        const reason: unknown = signal.aborted ? signal.reason : error;
        const detail = reason instanceof Error ? (/fetch failed/i.test(reason.message) ? "The download could not connect. Check your connection and retry." : reason.message) : "The import failed. Retry.";
        update(slot.id, { state: reason instanceof Error && reason.name === "AbortError" ? "cancelled" : "error", detail: detail + cleanup });
      } finally {
        clearTimeout(timer);
        if (monitor) clearInterval(monitor);
        running.delete(slot.id);
        finishedAt.set(slot.id, now());
      }
    })();
    return { ...job };
  };
  const handlers = {
    "sources.imports": () => snapshot(),
    "sources.downloadSample": ({ id }) => { const sample = samples.find(s => s.id === id); if (!sample) throw new Error("This sample is not available."); return begin("sample", id, sample.label, sample); },
    "sources.clone": ({ url }) => { const key = githubRepo(url); return begin("repository", key, key.slice("https://github.com/".length)); },
    "sources.cancelImport": ({ id }) => { const controller = running.get(id); controller?.abort(new DOMException("Cancelled. Nothing was added; retry whenever you like.", "AbortError")); return { cancelled: controller !== undefined }; },
  } satisfies Partial<Handlers>;
  return { handlers, snapshot, onChange(listener: (value: SourceImports) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }, close() { for (const c of running.values()) c.abort(new DOMException("The app closed during the import. Retry.", "AbortError")); } };
}
