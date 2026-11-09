import { readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createServerShutdown } from "./shutdown.ts";
import { createUpdateAdmission } from "./update/admission.ts";
import { createUpdateModule } from "./update/module.ts";
import { fakePnpm, makeRepos, removeRepos, testEnv } from "./update/testing.ts";
import { createImportActivity, withImportAdmission } from "./sources/activity.ts";
import { createSources } from "./sources/index.ts";

const noop = () => undefined;

it("shutdown aborts an in-flight update fetch instead of waiting for the network", async () => {
  const repos = makeRepos();
  for (const [key, value] of Object.entries(testEnv(repos.base))) vi.stubEnv(key, value);
  let entered: () => void = noop;
  let release: () => void = noop;
  let aborted = false;
  const fetching = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const fake = fakePnpm();
  const update = createUpdateModule({ root: repos.clone, dataDir: repos.data, everyChange: () => true, runner: async (command, args, options) => {
    if (args[0] === "fetch") {
      options.signal?.addEventListener("abort", () => { aborted = true; release(); }, { once: true });
      entered(); await held;
    }
    return fake.runner(command, args, options);
  } });
  const checking = update.check();
  await fetching;
  const closing = update.close();
  try {
    expect(aborted).toBe(true);
    await closing;
  } finally { release(); await checking; await closing; vi.unstubAllEnvs(); removeRepos(repos); }
});

it("AW-03 the server shutdown path cancels and joins a snapshot while an update fetch is stalled", async () => {
  const repos = makeRepos();
  for (const [key, value] of Object.entries(testEnv(repos.base))) vi.stubEnv(key, value);
  const admission = createUpdateAdmission();
  const imports = createImportActivity(admission);
  const sources = withImportAdmission(createSources({ dataDir: repos.data }), imports);
  let releaseFetch: () => void = noop;
  let enteredFetch: () => void = noop;
  const gate = new Promise<void>(resolve => { releaseFetch = resolve; });
  const entered = new Promise<void>(resolve => { enteredFetch = resolve; });
  const fake = fakePnpm();
  const update = createUpdateModule({ root: repos.clone, dataDir: repos.data, admission, everyChange: () => true, runner: async (command, args, options) => {
    if (args[0] === "fetch") { enteredFetch(); await gate; }
    return fake.runner(command, args, options);
  } });
  const check = update.check();
  let closing: Promise<void> | undefined;
  try {
    await entered;
    const live = path.join(repos.base, "large.db");
    const db = new DatabaseSync(live);
    db.exec("CREATE TABLE records (value BLOB); INSERT INTO records VALUES (zeroblob(8388608))"); db.close();
    const outcome = sources.add({ kind: "sqlite", path: live, label: "Pending database" }).catch((error: unknown) => error);
    expect(imports.activity()).toEqual(["Import: Pending database"]);
    const exit = vi.fn<(code: number) => void>();
    const idle = { close: async () => undefined, killRuntimeNow: noop };
    const shutdown = createServerShutdown({ admission, stopAutomatic: () => undefined, app: { shutdown: async () => undefined }, update, imports, loader: idle, image: idle, server: () => idle, store: idle, models: { ...idle, killRuntimeNow: () => undefined }, log: () => undefined, exit });
    closing = shutdown("stdin closed");
    expect(await outcome).toBeInstanceOf(Error);
    expect(imports.activity()).toEqual([]);
    expect(sources.list()).toEqual([]);
    expect(readdirSync(path.join(repos.data, "snapshots"))).toEqual([]);
    expect(exit).not.toHaveBeenCalled(); // The fetch is still held; the snapshot is already cleaned.
    releaseFetch(); await check; await closing;
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  } finally {
    releaseFetch(); await check; await closing; await imports.close(); await update.close();
    vi.unstubAllEnvs(); removeRepos(repos);
  }
});
