// The Library's list and its imports are ordered data: every value a listener is given, and every
// answer to sources.list and sources.imports, carries the number it was committed with.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createClient, type SocketLike, type Source, type SourceImports, type SyncChange, type SyncMetadata } from "@gates-local/contracts";
import { WebSocket } from "ws";
import { startWsServer, type HandlerContext, type WsServer } from "../ws/server.ts";
import { createSourcesHandlers } from "./handlers.ts";
import { createSources } from "./index.ts";
import { createLibraryImports } from "./imports.ts";
import { SAMPLES, type PinnedSample } from "./samples.ts";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).toReversed()) await close(); });
function scratch() {
  const root = mkdtempSync(path.join(tmpdir(), "ordered-sources-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const revs = (changes: readonly SyncChange[] | undefined) => changes?.map(change => change.kind === "snapshot" ? [change.scope, change.rev] : change);
/** What a handler captured for its answer. */
function captured<T>(run: (ctx: HandlerContext) => T): { value: T; changes: readonly SyncChange[] | undefined } {
  let changes: readonly SyncChange[] | undefined;
  const value = run({ clientId: 1, capture: c => { changes = c; } });
  return { value, changes };
}

it("every list the Library announces is numbered, and sources.list answers with the number of the list it holds", async () => {
  const root = scratch();
  const sources = createSources({ dataDir: path.join(root, "app") });
  const handlers = createSourcesHandlers({ sources });
  const seen: Array<[number, number]> = [];
  sources.onChange(list => seen.push([list.length, sources.stamp(list).rev]));
  expect(revs(captured(ctx => handlers["sources.list"]({}, ctx)).changes)).toEqual([["sources", 0]]);

  const file = path.join(root, "notes.txt"); writeFileSync(file, "hello");
  const source = await sources.add({ kind: "file", path: file });
  await sources.refresh(source.id);
  const read = captured(ctx => handlers["sources.list"]({}, ctx));
  sources.remove(source.id);

  // add, refresh (refreshing, then ready), remove: one number each, only going up.
  expect(seen).toEqual([[1, 1], [1, 2], [1, 3], [0, 4]]);
  expect(read.value).toEqual([expect.objectContaining({ id: source.id, state: "ready" })]);
  expect(revs(read.changes), "the answer carries the number of the list it holds, not a later one").toEqual([["sources", 3]]);
  // A copy is not what was announced: it has no number to give.
  expect(() => sources.stamp(sources.list())).toThrow(/not committed/);
});

it("the socket server refuses an unnumbered Library push", async () => {
  const root = scratch();
  const sources = createSources({ dataDir: path.join(root, "app") });
  let server: WsServer | undefined;
  sources.onChange(list => server?.push("sources.changed", list, [sources.stamp(list)]));
  server = await startWsServer({ port: 0, token: "fixture", allowedOrigins: [], handlers: createSourcesHandlers({ sources }) });
  cleanup.push(() => server?.close());
  const client = createClient(new WebSocket(`ws://127.0.0.1:${server.port}/?token=fixture`) as unknown as SocketLike);
  cleanup.push(() => client.close());
  const negotiated = await client.negotiate();
  expect(negotiated).toMatchObject({ epoch: expect.any(String) });
  const pushes: Array<{ ids: string[]; sync: SyncMetadata | undefined }> = [];
  client.subscribe("sources.changed", (list: readonly Source[], sync) => pushes.push({ ids: list.map(s => s.id), sync }));

  let readSync: SyncMetadata | undefined;
  await client.call("sources.list", {}, { onMetadata: sync => { readSync = sync; } });
  expect(revs(readSync?.changes)).toEqual([["sources", 0]]);
  const file = path.join(root, "notes.txt"); writeFileSync(file, "hello");
  const source = await sources.add({ kind: "file", path: file });
  await vi.waitFor(() => expect(pushes).toHaveLength(1));
  expect(pushes[0]).toEqual({ ids: [source.id], sync: { epoch: readSync?.epoch, changes: [{ scope: "sources", kind: "snapshot", rev: 1 }] } });

  expect(() => server?.push("sources.changed", [])).toThrow(/did not capture sources metadata/);
  expect(() => server?.push("sources.imports", { samples: [], jobs: [] }, [{ scope: "sources", kind: "snapshot", rev: 9 }])).toThrow(/did not capture source-imports metadata/);
});

it("an import's progress is numbered as it is announced, and sources.imports answers with the current number", async () => {
  const root = scratch();
  const sources = createSources({ dataDir: path.join(root, "app") });
  const fixture = path.join(root, "fixture.db");
  const db = new DatabaseSync(fixture);
  db.exec("CREATE TABLE albums (title TEXT); INSERT INTO albums VALUES ('First');");
  db.close();
  const bytes = readFileSync(fixture);
  const sample: PinnedSample = { ...SAMPLES[0]!, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const imports = createLibraryImports({ sources, samples: [sample], fetch: async () => new Response(bytes) });
  const announced: Array<{ state: string | undefined; rev: number }> = [];
  imports.onChange((value: SourceImports) => announced.push({ state: value.jobs[0]?.state, rev: imports.stamp(value).rev }));
  expect(revs(captured(ctx => imports.handlers["sources.imports"]({}, ctx)).changes)).toEqual([["source-imports", 0]]);

  const job = imports.handlers["sources.downloadSample"]({ id: sample.id });
  await vi.waitFor(() => expect(imports.snapshot().jobs.find(j => j.id === job.id)?.state).toBe("ready"), { timeout: 8000, interval: 10 });
  const read = captured(ctx => imports.handlers["sources.imports"]({}, ctx));

  expect(announced.length).toBeGreaterThanOrEqual(3);
  expect(announced.map(a => a.rev), "one number per announcement, only going up").toEqual(announced.map((_, i) => i + 1));
  expect(announced.at(-1)?.state).toBe("ready");
  expect(revs(read.changes)).toEqual([["source-imports", announced.length]]);
  expect(read.value).toBe(imports.snapshot());
});
