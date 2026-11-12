import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTools } from "../../../../packages/harness/src/tools.ts";
import { createSources } from "./index.ts";
import { createLibraryImports } from "./imports.ts";
import { cloneRepository, githubRepo, importSize, REPO_BYTES, runGit, type GitTransport } from "./clone.ts";
import { SAMPLES, type PinnedSample } from "./samples.ts";
import { createImportActivity } from "./activity.ts";
import { createUpdateAdmission } from "../update/admission.ts";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup(id = "chinook") {
  const root = mkdtempSync(path.join(tmpdir(), "library-import-"));
  roots.push(root);
  const dataDir = path.join(root, "app");
  const sources = createSources({ dataDir });
  const fixture = path.join(root, "fixture.db");
  const db = new DatabaseSync(fixture);
  db.exec("CREATE TABLE albums (title TEXT); INSERT INTO albums VALUES ('First');");
  db.close();
  const bytes = readFileSync(fixture);
  const sample: PinnedSample = { ...SAMPLES.find(x => x.id === id)!, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  return { root, dataDir, sources, bytes, sample };
}
const fake = (bytes: Uint8Array): typeof fetch => vi.fn(async () => new Response(bytes));
const growingClone: GitTransport = async call => {
  const dest = call.args.at(-1)!; mkdirSync(dest);
  const file = path.join(dest, "large"); writeFileSync(file, "");
  truncateSync(file, REPO_BYTES + 1);
  return new Promise((_resolve, reject) => call.signal.addEventListener("abort", () => reject(call.signal.reason), { once: true }));
};
async function finished(imports: ReturnType<typeof createLibraryImports>, id: string) {
  await vi.waitFor(() => expect(imports.snapshot().jobs.find(j => j.id === id)?.state).toMatch(/^(ready|error|cancelled)$/), { timeout: 8000, interval: 10 });
  return imports.snapshot().jobs.find(j => j.id === id)!;
}
function git(cwd: string, ...args: string[]) { return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(cwd, "no-global"), GIT_CONFIG_NOSYSTEM: "1" } }); }
function bareRepo(root: string, huge = false) {
  const seed = path.join(root, "seed");
  mkdirSync(seed);
  git(seed, "init", "--quiet");
  git(seed, "config", "user.name", "Library fixture");
  git(seed, "config", "user.email", "fixture@example.test");
  writeFileSync(path.join(seed, "README.md"), "Read this fixture");
  writeFileSync(path.join(seed, ".gitattributes"), "*.md filter=hostile\n");
  writeFileSync(path.join(seed, "escape"), "../../outside");
  if (huge) { const big = path.join(seed, "huge.bin"); writeFileSync(big, ""); truncateSync(big, REPO_BYTES + 1); }
  git(seed, "add", ".");
  const oid = git(seed, "hash-object", "-w", "escape").trim();
  git(seed, "update-index", "--cacheinfo", `120000,${oid},escape`);
  git(seed, "commit", "--quiet", "-m", "Fixture");
  const head = git(seed, "rev-parse", "HEAD").trim();
  writeFileSync(path.join(seed, ".gitmodules"), `[submodule "nested"]\n path = nested\n url = ${path.join(root, "no-submodule.git")}\n`);
  git(seed, "add", ".gitmodules"); git(seed, "update-index", "--add", "--cacheinfo", `160000,${head},nested`);
  git(seed, "commit", "--quiet", "-m", "A submodule that must not be fetched");
  const bare = path.join(root, "fixture.git");
  git(root, "clone", "--quiet", "--bare", seed, bare);
  return bare;
}
function localTransport(bare: string, inspect?: GitTransport): GitTransport {
  return async call => {
    await inspect?.(call);
    const args = call.args.map(a => a.startsWith("https://github.com/") ? `file://${bare}` : a);
    return runGit({ ...call, args: ["-c", "protocol.file.allow=always", ...args], env: { ...call.env, GIT_ALLOW_PROTOCOL: "file" } });
  };
}

const pendingClone: GitTransport = call => {
  call.signal.throwIfAborted();
  return new Promise((_resolve, reject) => call.signal.addEventListener("abort", () => reject(call.signal.reason), { once: true }));
};
const stopped = (imports: ReturnType<typeof createLibraryImports>) => vi.waitFor(() => expect(imports.snapshot().jobs.every(job => ["ready", "error", "cancelled"].includes(job.state))).toBe(true));

describe("update admission integration", () => {
  it.each(["sample", "repository"] as const)("AV-03 refuses a new %s import before allocation or transport", async kind => {
    const s = setup(); const admission = createUpdateAdmission();
    const activity = createImportActivity(admission);
    admission.reserve("a".repeat(40));
    const get = fake(s.bytes); const transport = vi.fn(pendingClone);
    const options = { sources: s.sources, samples: [s.sample], fetch: get, git: transport, activity };
    const imports = createLibraryImports(options);
    try {
      const start = () => kind === "sample" ? imports.handlers["sources.downloadSample"]({ id: s.sample.id }) : imports.handlers["sources.clone"]({ url: "https://github.com/example/refused" });
      expect(start).toThrow("closing to update");
      expect(imports.snapshot().jobs).toEqual([]);
      expect(get).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
      expect(readdirSync(path.join(s.dataDir, "library-imports"))).toEqual([]);
    } finally { imports.close(); await stopped(imports); await activity.close(); }
  });

  it("AV-03 a returned sample job remains named through transport cancellation and cleanup", async () => {
    const s = setup(); const activity = createImportActivity(createUpdateAdmission());
    const get: typeof fetch = vi.fn((_url, options) => new Promise<Response>((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true })));
    const options = { sources: s.sources, samples: [s.sample], fetch: get, activity };
    const imports = createLibraryImports(options);
    try {
      const job = imports.handlers["sources.downloadSample"]({ id: s.sample.id });
      expect(job.state).toBe("downloading");
      expect(activity.activity()).toEqual([`Import: ${s.sample.label}`]);
      await activity.close();
      expect(imports.snapshot().jobs.find(value => value.id === job.id)?.state).toMatch(/error|cancelled/);
      expect(activity.activity()).toEqual([]);
      expect(s.sources.list()).toEqual([]);
      expect(readdirSync(path.join(s.dataDir, "library-imports"))).toEqual([]);
    } finally { imports.close(); await stopped(imports); }
  });
});

describe("review round 1", () => {
  it("refuses a third active import before allocating work, and releases capacity after cancellation (DD-01)", async () => {
    const s = setup();
    const imports = createLibraryImports({ sources: s.sources, git: pendingClone });
    try {
      const first = imports.handlers["sources.clone"]({ url: "https://github.com/example/one" });
      const second = imports.handlers["sources.clone"]({ url: "https://github.com/example/two" });
      expect(imports.handlers["sources.clone"]({ url: first.key }).id).toBe(first.id);
      expect(() => imports.handlers["sources.clone"]({ url: "https://github.com/example/three" })).toThrow(/2 imports.*finish.*cancel/i);
      expect(readdirSync(path.join(s.dataDir, "library-imports"))).toHaveLength(2);
      expect(imports.snapshot().jobs).toHaveLength(2);
      imports.handlers["sources.cancelImport"]({ id: first.id }); await finished(imports, first.id);
      const next = imports.handlers["sources.clone"]({ url: "https://github.com/example/three" });
      expect(next.id).not.toBe(first.id); expect(imports.snapshot().jobs.find(j => j.id === second.id)?.state).toBe("cloning");
    } finally { imports.close(); await stopped(imports); }
  });

  it("bounds retained jobs, protects recent failures, permits Retry when full and expires that protection (DD-01)", async () => {
    const s = setup(); let now = 0;
    const imports = createLibraryImports({ sources: s.sources, now: () => now, git: async () => { throw new Error("offline; retry"); } });
    try {
      const ids: string[] = [];
      for (let i = 0; i < 20; i++) {
        const job = imports.handlers["sources.clone"]({ url: `https://github.com/example/repo-${i}` }); ids.push(job.id);
        expect((await finished(imports, job.id)).state).toBe("error");
      }
      expect(imports.snapshot().jobs).toHaveLength(20);
      expect(() => imports.handlers["sources.clone"]({ url: "https://github.com/example/over-limit" })).toThrow(/history.*recent failures.*retry/i);
      expect(imports.snapshot().jobs.find(j => j.id === ids[0])?.state).toBe("error");
      const retry = imports.handlers["sources.clone"]({ url: "https://github.com/example/repo-0" });
      expect(retry.id).not.toBe(ids[0]); expect((await finished(imports, retry.id)).state).toBe("error");
      expect(imports.snapshot().jobs).toHaveLength(20);
      for (let i = 0; i < 25; i++) {
        now += 5 * 60_000 + 1;
        const job = imports.handlers["sources.clone"]({ url: `https://github.com/example/later-${i}` }); await finished(imports, job.id);
        expect(imports.snapshot().jobs.length).toBeLessThanOrEqual(20);
      }
    } finally { imports.close(); await stopped(imports); }
  });

  it.each(["missing", "corrupt", "unreadable"])("a %s registry preserves completed imports and backup references while proven staging is cleaned (DD-02)", async mode => {
    const s = setup();
    const slot = s.sources.allocateOwned(); mkdirSync(slot.path); writeFileSync(path.join(slot.path, "README.md"), "keep this imported content");
    const source = await s.sources.addOwned(slot, { kind: "folder", label: "Docs", managed: { kind: "repository", key: "https://github.com/example/docs" } });
    const partial = s.sources.allocateOwned(); mkdirSync(partial.path); writeFileSync(path.join(partial.path, "partial"), "keep until ownership is known");
    const registry = path.join(s.dataDir, "sources.json");
    if (mode === "corrupt") writeFileSync(registry, JSON.stringify([source, { invalid: true }]));
    else { renameSync(registry, registry + ".saved"); if (mode === "unreadable") mkdirSync(registry); }
    expect(createSources({ dataDir: s.dataDir, now: () => 1234 }).list()).toEqual([]);
    expect(readFileSync(path.join(slot.path, "README.md"), "utf8")).toBe("keep this imported content");
    expect(existsSync(partial.work)).toBe(false);
    // A second start sees a missing registry after the corrupt one was moved aside.
    createSources({ dataDir: s.dataDir });
    expect(existsSync(slot.path)).toBe(true); expect(existsSync(partial.work)).toBe(false);
    if (mode === "corrupt") {
      const backup: unknown = JSON.parse(readFileSync(registry + ".bad-1234", "utf8"));
      const first: unknown = Array.isArray(backup) ? backup[0] : undefined;
      if (typeof first !== "object" || first === null || !("path" in first) || typeof first.path !== "string") throw new Error("The backup lost the registered source");
      expect(first.path).toBe(source.path);
      expect(readFileSync(path.join(first.path, "README.md"), "utf8")).toBe("keep this imported content");
    }
  });
});

async function completedFolder() {
  const s = setup();
  const slot = s.sources.allocateOwned(); mkdirSync(slot.path);
  writeFileSync(path.join(slot.path, "keep.txt"), "completed content");
  const source = await s.sources.addOwned(slot, { kind: "folder", label: "Docs", managed: { kind: "repository", key: "https://github.com/example/docs" } });
  return { ...s, slot, source, registry: path.join(s.dataDir, "sources.json") };
}

describe("review round 2 durable lifecycle", () => {
  it("keeps completed content after corrupt, backup rename, new source save and restart (DE-01)", async () => {
    const s = await completedFolder();
    writeFileSync(s.registry, JSON.stringify([s.source, { invalid: true }]));
    const recovered = createSources({ dataDir: s.dataDir, now: () => 5678 });
    const file = path.join(s.root, "new-file.txt"); writeFileSync(file, "new source");
    await recovered.add({ kind: "file", path: file });
    createSources({ dataDir: s.dataDir });
    expect(readFileSync(path.join(s.slot.path, "keep.txt"), "utf8")).toBe("completed content");
    const backup: unknown = JSON.parse(readFileSync(s.registry + ".bad-5678", "utf8"));
    expect(backup).toEqual([s.source, { invalid: true }]);
    expect(existsSync(s.source.path)).toBe(true);
  });

  it.each(["current", "legacy"])("a valid empty registry does not delete %s completed content (DE-02)", async version => {
    const s = await completedFolder();
    if (version === "legacy") writeFileSync(path.join(s.slot.work, "owner.json"), JSON.stringify({ id: s.slot.id }));
    writeFileSync(s.registry, "[]");
    createSources({ dataDir: s.dataDir });
    expect(readFileSync(path.join(s.slot.path, "keep.txt"), "utf8")).toBe("completed content");
  });

  it("preserves and can explicitly remove an older entry without managed metadata (DE-02)", async () => {
    const s = await completedFolder();
    writeFileSync(s.registry, JSON.stringify([{ ...s.source, managed: undefined }]));
    const reloaded = createSources({ dataDir: s.dataDir });
    expect(readFileSync(path.join(s.slot.path, "keep.txt"), "utf8")).toBe("completed content");
    expect(reloaded.entries()).toHaveLength(1);
    reloaded.remove(s.source.id);
    expect(existsSync(s.slot.work)).toBe(false);
  });

  it.each(["marker-only", "partial"])("first-import crash without a registry cleans only its %s staging slot (DE-03)", mode => {
    const s = setup(); const slot = s.sources.allocateOwned();
    if (mode === "partial") { mkdirSync(slot.path); writeFileSync(path.join(slot.path, "partial"), "unfinished"); }
    expect(existsSync(path.join(s.dataDir, "sources.json"))).toBe(false);
    createSources({ dataDir: s.dataDir });
    expect(existsSync(slot.work)).toBe(false);
  });

  it("persists removal intent before the registry changes or completed content is deleted", async () => {
    const s = await completedFolder(); let witnessed: unknown;
    const intent = path.join(s.dataDir, "library-imports", s.slot.id + ".remove.json");
    s.sources.onChange(() => { witnessed = existsSync(intent) && existsSync(s.slot.path) ? JSON.parse(readFileSync(intent, "utf8")) : undefined; });
    s.sources.remove(s.source.id);
    expect(witnessed).toEqual({ id: s.source.id, action: "remove" });
    expect(existsSync(s.slot.work)).toBe(false);
  });

  it.each(["intact", "marker-gone"])("a durable Remove finishes after a crash with %s metadata", async phase => {
    const s = await completedFolder();
    const intent = path.join(s.dataDir, "library-imports", s.slot.id + ".remove.json");
    writeFileSync(intent, JSON.stringify({ id: s.slot.id, action: "remove" }), { flush: true });
    if (phase === "marker-gone") rmSync(path.join(s.slot.work, "owner.json"));
    const reloaded = createSources({ dataDir: s.dataDir });
    expect(existsSync(s.slot.work)).toBe(false); expect(reloaded.list()).toEqual([]);
    expect(JSON.parse(readFileSync(s.registry, "utf8"))).toEqual([]);
    expect(existsSync(intent)).toBe(false);
  });

  it.skipIf(process.platform === "win32").each(["cancel", "timeout"])("stopped workers settle and release both import slots after %s (DE-04)", async mode => {
    const s = setup(); const pids: number[] = [];
    const imports = createLibraryImports({ sources: s.sources, timeoutMs: mode === "timeout" ? 500 : 10_000, git: call => {
      if (pids.length >= 2) throw new Error("replacement admitted");
      return runGit({ ...call, args: ["-c", "alias.wait=!node -e 'setTimeout(()=>{},60000)'", "wait"], onWorkerStart: pid => { pids.push(pid); process.kill(pid, "SIGSTOP"); } });
    } });
    try {
      const jobs = ["one", "two"].map(name => imports.handlers["sources.clone"]({ url: `https://github.com/example/${name}` }));
      await vi.waitFor(() => expect(pids).toHaveLength(2));
      if (mode === "cancel") for (const job of jobs) imports.handlers["sources.cancelImport"]({ id: job.id });
      await vi.waitFor(() => expect(imports.snapshot().jobs.map(j => j.state)).toEqual([mode === "cancel" ? "cancelled" : "error", mode === "cancel" ? "cancelled" : "error"]), { timeout: 2000, interval: 10 });
      const replacement = imports.handlers["sources.clone"]({ url: "https://github.com/example/replacement" });
      expect((await finished(imports, replacement.id)).detail).toContain("replacement admitted");
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      // The unfixed implementation needs its stopped workers resumed to service EOF.
      for (const pid of pids) { try { process.kill(pid, "SIGCONT"); } catch { /* Already reaped. */ } }
      imports.close(); await vi.waitFor(() => expect(imports.snapshot().jobs.every(j => ["ready", "error", "cancelled"].includes(j.state))).toBe(true), { timeout: 12_000 });
    }
  }, 16_000);
});

// AUTOINCREMENT makes sqlite_sequence; FTS5 and R-tree each keep their rows in shadow tables beside their virtual table.
function shop(root: string) {
  const file = path.join(root, "shop.db");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT); INSERT INTO notes (body) VALUES ('a'), ('b');
    CREATE TABLE tags (name TEXT); INSERT INTO tags VALUES ('x');
    CREATE VIRTUAL TABLE docs USING fts5(body); INSERT INTO docs VALUES ('hello');
    CREATE VIRTUAL TABLE box USING rtree(id, x0, x1); INSERT INTO box VALUES (1, 0, 1);
    CREATE VIEW recent AS SELECT * FROM notes;`);
  db.close();
  return file;
}
describe("a database's tables", () => {
  it("lists the plain tables with their rows and the virtual ones by name, never shadow or sqlite_ tables; a refresh replaces the list", async () => {
    const s = setup();
    const file = shop(s.root);
    const source = await s.sources.add({ kind: "sqlite", path: file });
    expect(source.tables).toEqual([{ name: "box" }, { name: "docs" }, { name: "notes", rows: 2 }, { name: "tags", rows: 1 }]);
    expect(source.tableCount).toBeUndefined();
    const live = new DatabaseSync(file);
    live.exec("DROP TABLE tags; INSERT INTO notes (body) VALUES ('c'); DROP TABLE box;"); live.close();
    await s.sources.refresh(source.id);
    expect(s.sources.list()[0]?.tables).toEqual([{ name: "docs" }, { name: "notes", rows: 3 }]);
  });
  it("past 500 tables lists the first 500 and carries how many there are", async () => {
    const s = setup();
    const file = path.join(s.root, "wide.db");
    const db = new DatabaseSync(file);
    // One transaction: 501 separate commits are 501 waits on the disk, which a busy machine turned into a timeout.
    db.exec(`BEGIN;${Array.from({ length: 501 }, (_, i) => `CREATE TABLE t${String(i).padStart(3, "0")} (a);`).join("")}COMMIT;`);
    db.close();
    const source = await s.sources.add({ kind: "sqlite", path: file });
    expect(source.tables).toHaveLength(500);
    expect(source.tables?.at(-1)).toEqual({ name: "t499", rows: 0 });
    expect(source.tableCount).toBe(501);
    const live = new DatabaseSync(file);
    live.exec("DROP TABLE t000; DROP TABLE t001;"); live.close();
    await s.sources.refresh(source.id);
    expect(s.sources.list()[0]?.tables).toHaveLength(499);
    expect(s.sources.list()[0]?.tableCount).toBeUndefined();
  }, 16_000);
});

describe("sample downloads", () => {
  it("does nothing until clicked, checks bytes, uses the ordinary read-only snapshot, deduplicates and removes only its own copy", async () => {
    const s = setup();
    const get = fake(s.bytes);
    const imports = createLibraryImports({ sources: s.sources, samples: [s.sample], fetch: get });
    expect(get).not.toHaveBeenCalled();
    expect(imports.snapshot().samples[0]?.sizeBytes).toBe(s.bytes.length);
    const job = imports.handlers["sources.downloadSample"]({ id: s.sample.id });
    expect(imports.handlers["sources.downloadSample"]({ id: s.sample.id }).id).toBe(job.id);
    expect(await finished(imports, job.id)).toMatchObject({ state: "ready" });
    const source = s.sources.list()[0]!;
    expect(source).toMatchObject({ kind: "sqlite", managed: { kind: "sample", key: "chinook" }, tables: [{ name: "albums", rows: 1 }] });
    const snapshot = s.sources.entries()[0]!.snapshotPath!;
    const db = new DatabaseSync(snapshot, { readOnly: true });
    expect(db.prepare("SELECT title FROM albums").get()).toEqual({ title: "First" });
    expect(() => db.exec("DELETE FROM albums")).toThrow(/readonly/);
    db.close();
    const live = new DatabaseSync(source.path);
    live.exec("INSERT INTO albums VALUES ('Second')"); live.close();
    await s.sources.refresh(source.id);
    expect(s.sources.list()[0]).toMatchObject({ state: "ready", tables: [{ name: "albums", rows: 2 }] });
    expect(imports.handlers["sources.downloadSample"]({ id: s.sample.id }).sourceId).toBe(source.id);
    expect(get).toHaveBeenCalledTimes(1);
    expect(createSources({ dataDir: s.dataDir }).entries()).toHaveLength(1);
    // The counts are kept with the source, so a later list reads no database.
    expect(createSources({ dataDir: s.dataDir }).list()[0]?.tables).toEqual([{ name: "albums", rows: 2 }]);
    const manual = await s.sources.add({ kind: "sqlite", path: path.join(s.root, "fixture.db") });
    expect(manual.tables).toEqual([{ name: "albums", rows: 1 }]);
    s.sources.remove(manual.id);
    expect(existsSync(path.join(s.root, "fixture.db"))).toBe(true);
    s.sources.remove(source.id);
    expect(existsSync(source.path)).toBe(false);
    expect(existsSync(snapshot)).toBe(false);
  });
  // Not the first sample, and not MIT: a copy that got the first sample's notice, or one text for all, reads wrong here.
  it("writes the downloaded sample's own licence beside its copy", async () => {
    const s = setup("worldcup");
    const imports = createLibraryImports({ sources: s.sources, samples: [SAMPLES[0]!, s.sample], fetch: fake(s.bytes) });
    const job = imports.handlers["sources.downloadSample"]({ id: "worldcup" });
    expect(await finished(imports, job.id)).toMatchObject({ state: "ready" });
    const notice = readFileSync(path.join(path.dirname(s.sources.list()[0]!.path), "LICENSE.txt"), "utf8");
    expect(notice).toBe(s.sample.notice);
    expect(notice).toContain("CC BY-SA 4.0");
    expect(notice).toContain("Joshua C. Fjelstul");
    expect(notice).not.toContain("MIT");
  });
  it.each(["hash", "type", "short", "long", "length", "invalid-sqlite"])("rejects %s and leaves no source, snapshot or partial download", async fault => {
    const s = setup();
    const bytes = fault === "type" ? Buffer.alloc(s.bytes.length, 65) : fault === "invalid-sqlite" ? Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(s.bytes.length - 16)]) : fault === "short" ? s.bytes.subarray(0, 20) : fault === "long" ? Buffer.concat([s.bytes, s.bytes]) : s.bytes;
    const sample = fault === "type" || fault === "invalid-sqlite" ? { ...s.sample, sha256: createHash("sha256").update(bytes).digest("hex") } : fault === "hash" ? { ...s.sample, sha256: "0".repeat(64) } : s.sample;
    const imports = createLibraryImports({ sources: s.sources, samples: [sample], fetch: vi.fn(async () => new Response(bytes, fault === "length" ? { headers: { "content-length": "1" } } : {})) });
    const job = imports.handlers["sources.downloadSample"]({ id: sample.id });
    const failed = await finished(imports, job.id);
    expect(failed.state).toBe("error");
    if (fault === "hash") expect(failed.detail).toMatch(/checksum/);
    if (fault === "type") expect(failed.detail).toMatch(/not a SQLite/);
    if (["short", "long", "length"].includes(fault)) expect(failed.detail).toMatch(/wrong size/);
    expect(s.sources.list()).toEqual([]);
    expect(readdirSync(path.join(s.dataDir, "snapshots"))).toEqual([]);
    expect(readdirSync(path.join(s.dataDir, "library-imports"))).toEqual([]);
  });
  it("allows cancel and offline retry, and timeout never registers a source", async () => {
    const s = setup();
    let slow = true;
    const get: typeof fetch = vi.fn(async (_url, init) => {
      if (!slow) return new Response(s.bytes);
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
    });
    const imports = createLibraryImports({ sources: s.sources, samples: [s.sample], fetch: get });
    const first = imports.handlers["sources.downloadSample"]({ id: s.sample.id });
    expect(imports.handlers["sources.cancelImport"]({ id: first.id })).toEqual({ cancelled: true });
    expect((await finished(imports, first.id)).state).toBe("cancelled");
    slow = false;
    const retry = imports.handlers["sources.downloadSample"]({ id: s.sample.id });
    expect((await finished(imports, retry.id)).state).toBe("ready");
    s.sources.remove(retry.id);
    const offline = createLibraryImports({ sources: s.sources, samples: [s.sample], fetch: vi.fn(async () => { throw new TypeError("fetch failed"); }) });
    const failed = offline.handlers["sources.downloadSample"]({ id: s.sample.id });
    expect((await finished(offline, failed.id)).detail).toMatch(/connection.*retry/i);
    slow = true;
    const timed = createLibraryImports({ sources: s.sources, samples: [s.sample], fetch: get, timeoutMs: 10 });
    const job = timed.handlers["sources.downloadSample"]({ id: s.sample.id });
    expect((await finished(timed, job.id)).detail).toMatch(/too long/);
    expect(s.sources.list()).toEqual([]);
  });
  it("refuses non-HTTPS before invoking the download transport", async () => {
    const s = setup(); const get = fake(s.bytes);
    const imports = createLibraryImports({ sources: s.sources, samples: [{ ...s.sample, url: "http://example.test/file" }], fetch: get });
    expect((await finished(imports, imports.handlers["sources.downloadSample"]({ id: s.sample.id }).id)).detail).toMatch(/HTTPS/);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("repository imports", () => {
  it("parses the exact GitHub form separately from git transport", () => {
    expect(githubRepo("https://github.com/example/docs.git/")).toBe("https://github.com/example/docs");
    for (const bad of ["--upload-pack=evil", "https://github.com/example/--upload-pack=evil", "https://user:pass@github.com/example/docs", "http://github.com/example/docs", "https://github.com:443/example/docs", "https://github.com/example/docs?x=y", "https://github.com/example/docs#x", "https://github.com/example/docs/tree/main", "https://github.com/example/../docs", "https://github.com/example/%2ddocs", "https://github.com/example/docs\n", " https://github.com/example/docs", "https://github.com/example/docs\\evil"]) expect(() => githubRepo(bad), bad).toThrow(/public GitHub URL/);
  });
  it("clones a hostile local bare repo through the injected transport with no hooks, symlinks, submodules or git metadata in Library", async () => {
    const s = setup();
    const bare = bareRepo(s.root);
    const outside = path.join(s.root, "outside"); writeFileSync(outside, "do not touch");
    const hooks = path.join(s.root, "hooks"); mkdirSync(hooks);
    writeFileSync(path.join(hooks, "post-checkout"), `#!/bin/sh\nprintf owned > '${outside}'\n`, { mode: 0o700 });
    const config = path.join(s.root, "evil-config");
    writeFileSync(config, `[core]\n hooksPath = ${hooks}\n[filter "hostile"]\n smudge = touch '${outside}'\n required = true\n`);
    vi.stubEnv("GIT_CONFIG_GLOBAL", config); vi.stubEnv("GIT_CONFIG_COUNT", "1"); vi.stubEnv("GIT_CONFIG_KEY_0", "core.hooksPath"); vi.stubEnv("GIT_CONFIG_VALUE_0", hooks);
    const calls: string[][] = [];
    const transport = localTransport(bare, async call => {
      calls.push([...call.args]);
      expect(call.env["GIT_TERMINAL_PROMPT"]).toBe("0"); expect(call.env["GIT_LFS_SKIP_SMUDGE"]).toBe("1"); expect(call.env["GIT_ALLOW_PROTOCOL"]).toBe("https"); expect(call.env["GIT_CONFIG_COUNT"]).toBeUndefined(); expect(call.env["GIT_CONFIG_GLOBAL"]).not.toBe(config);
      expect(call.env["ELECTRON_RUN_AS_NODE"]).toBe("1");
      return "";
    });
    const imports = createLibraryImports({ sources: s.sources, git: transport });
    const job = imports.handlers["sources.clone"]({ url: "https://github.com/example/docs" });
    const done = await finished(imports, job.id);
    expect(done).toMatchObject({ state: "ready" });
    const source = s.sources.list()[0]!;
    expect(readFileSync(outside, "utf8")).toBe("do not touch");
    const expectedBytes = ["README.md", ".gitattributes", "escape", ".gitmodules"].reduce((total, name) => total + readFileSync(path.join(s.root, "seed", name)).length, 0);
    expect(source.sizeBytes).toBe(expectedBytes);
    expect(lstatSync(path.join(source.path, "escape")).isSymbolicLink()).toBe(false);
    expect(existsSync(path.join(source.path, ".git"))).toBe(false);
    const tools = createTools({ sources: s.sources.entries() });
    const result = await tools.execute({ name: "read", input: { path: `/library/${source.id}` } }, new AbortController().signal);
    expect(result.output).toContain("README.md"); expect(result.output).not.toContain(".git\n");
    const clone = calls.find(a => a.includes("clone"))!;
    expect(clone).toContain("core.symlinks=false"); expect(clone).toContain("--depth=1"); expect(clone).toContain("--no-recurse-submodules");
    expect(clone[clone.indexOf("--") + 1]).toBe("https://github.com/example/docs");
    expect(imports.handlers["sources.clone"]({ url: "https://github.com/EXAMPLE/docs.git" }).sourceId).toBe(source.id);
    const manualPath = path.join(s.root, "manual"); mkdirSync(manualPath); writeFileSync(path.join(manualPath, "keep"), "keep");
    const manual = await s.sources.add({ kind: "folder", path: manualPath });
    s.sources.remove(manual.id); s.sources.remove(source.id);
    expect(existsSync(path.join(manualPath, "keep"))).toBe(true); expect(existsSync(source.path)).toBe(false);
  });
  it("rejects a huge tree before checkout and discards the partial clone", async () => {
    const s = setup();
    const calls: string[][] = [];
    const transport = localTransport(bareRepo(s.root, true), async call => { calls.push([...call.args]); return ""; });
    const imports = createLibraryImports({ sources: s.sources, git: transport });
    const job = imports.handlers["sources.clone"]({ url: "https://github.com/example/docs" });
    expect((await finished(imports, job.id)).detail).toMatch(/too large/);
    expect(s.sources.list()).toEqual([]); expect(readdirSync(path.join(s.dataDir, "library-imports"))).toEqual([]);
    expect(calls).toHaveLength(2); expect(calls.some(args => args.includes("reset"))).toBe(false);
  });
  it("bounds incoming disk bytes and cancels a clone that grows past the limit", async () => {
    const s = setup();
    const imports = createLibraryImports({ sources: s.sources, git: growingClone, timeoutMs: 500 });
    const job = imports.handlers["sources.clone"]({ url: "https://github.com/example/docs" });
    expect((await finished(imports, job.id)).detail).toMatch(/too large/);
    expect(readdirSync(path.join(s.dataDir, "library-imports"))).toEqual([]);
  });
  it("recovers a restart mid-clone without following a link out, then allows retry", async () => {
    const s = setup(); const outside = path.join(s.root, "outside"); mkdirSync(outside); writeFileSync(path.join(outside, "keep"), "keep");
    expect(existsSync(path.join(s.dataDir, "sources.json"))).toBe(false);
    const partial = s.sources.allocateOwned(); mkdirSync(partial.path);
    const { symlinkSync } = await import("node:fs"); symlinkSync(outside, path.join(partial.path, "escape"), "dir");
    writeFileSync(path.join(partial.path, "unfinished"), "partial clone");
    const sources = createSources({ dataDir: s.dataDir });
    expect(sources.list()).toEqual([]); expect(existsSync(partial.work)).toBe(false); expect(readFileSync(path.join(outside, "keep"), "utf8")).toBe("keep");
    const imports = createLibraryImports({ sources, git: localTransport(bareRepo(s.root)) });
    const job = imports.handlers["sources.clone"]({ url: "https://github.com/example/docs" });
    expect((await finished(imports, job.id)).state).toBe("ready");
  });
  it("ends git when the worker loses its parent pipe", async () => {
    const s = setup();
    // A real git alias that waits for stdin EOF cannot run with the clone settings;
    // this calls the worker directly to test its parent-death contract in isolation.
    const child = spawn(process.execPath, [path.join(import.meta.dirname, "git-worker.ts"), JSON.stringify(["-c", "alias.wait=!node -e 'console.log(process.pid); setTimeout(()=>{},1000)'", "wait"]), s.root], { detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.resume();
    if (process.platform === "win32") child.stdin.write("start\n");
    const [data] = await once(child.stdout, "data");
    expect(Number(String(data).trim())).toBeGreaterThan(0);
    child.stdin.end();
    const [code, signal] = await once(child, "exit"); expect(code === 1 || signal === "SIGKILL").toBe(true);
  });
  it.each(["Git is not installed. Install Git and try again.", "This repository is private, missing or unavailable. Choose a public GitHub repository and retry.", "GitHub could not be reached. Check your connection and retry."])("reports %s without a partial folder", async message => {
    const s = setup(); const imports = createLibraryImports({ sources: s.sources, git: async () => { throw new Error(message); } });
    const job = imports.handlers["sources.clone"]({ url: "https://github.com/example/docs" });
    expect((await finished(imports, job.id)).detail).toBe(message); expect(s.sources.list()).toEqual([]); expect(readdirSync(path.join(s.dataDir, "library-imports"))).toEqual([]);
  });
  it("refuses manually adding the imports folder and a forged ownership path cannot delete a manual folder", async () => {
    const s = setup(); const slot = s.sources.allocateOwned(); mkdirSync(slot.path);
    await expect(s.sources.add({ kind: "folder", path: slot.path })).rejects.toThrow(/app.*data/);
    const manual = path.join(s.root, "manual"); mkdirSync(manual); writeFileSync(path.join(manual, "keep"), "keep");
    const source = await s.sources.add({ kind: "folder", path: manual });
    const registry = path.join(s.dataDir, "sources.json"); writeFileSync(registry, JSON.stringify([{ ...source, managed: { kind: "repository", key: "forged" } }]));
    const loaded = createSources({ dataDir: s.dataDir }); loaded.remove(source.id);
    expect(readFileSync(path.join(manual, "keep"), "utf8")).toBe("keep");
  });
  it("refuses an unrecognized git tree format before checkout", async () => {
    const s = setup(); expect(await importSize(s.root, new AbortController().signal)).toBeGreaterThan(0);
    const slot = s.sources.allocateOwned();
    await expect(cloneRepository({ url: "https://github.com/example/docs", work: slot.work, destination: slot.path, signal: new AbortController().signal, progress: () => {}, git: async () => "not a tree" })).rejects.toThrow(/unsupported/);
  });
});
