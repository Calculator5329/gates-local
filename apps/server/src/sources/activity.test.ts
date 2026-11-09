import { expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createSources } from "./index.ts";
import { createUpdateAdmission } from "../update/admission.ts";
import { createImportActivity, withImportAdmission } from "./activity.ts";

it("AV-03 shutdown cancels and joins a real snapshot worker before returning", async () => {
  const base = path.join(homedir(), ".cache", "gates-local-tests"); mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, "import-stop-"));
  try {
    const file = path.join(dir, "live.db"); const db = new DatabaseSync(file);
    db.exec("CREATE TABLE records (value TEXT); INSERT INTO records VALUES ('Retained live data')"); db.close();
    const imports = createImportActivity(createUpdateAdmission());
    const sources = withImportAdmission(createSources({ dataDir: path.join(dir, "app") }), imports);
    const outcome = sources.add({ kind: "sqlite", path: file }).catch((error: unknown) => error);
    await imports.close();
    expect(await outcome).toBeInstanceOf(Error);
    expect(sources.list()).toEqual([]);
    expect(readdirSync(path.join(dir, "app", "snapshots"))).toEqual([]);
    const live = new DatabaseSync(file, { readOnly: true });
    expect(live.prepare("SELECT value FROM records").get()?.["value"]).toBe("Retained live data"); live.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("AV-03 imports pass admission before starting any worker or writes", async () => {
  const admission = createUpdateAdmission();
  const imports = createImportActivity(admission);
  let started = false;
  admission.reserve("a".repeat(40));
  await expect(imports.run("Import: Default data", async () => { started = true; })).rejects.toMatchObject({ code: "update-installing" });
  expect(started).toBe(false);
});

it("AV-03 background import APIs stay active after returning their job id until cleanup finishes", async () => {
  const admission = createUpdateAdmission();
  const imports = createImportActivity(admission);
  const scope = imports.begin("Import: Pinned sample");
  expect(imports.activity()).toEqual(["Import: Pinned sample"]);
  let closed = false;
  const closing = imports.close().then(() => { closed = true; });
  await Promise.resolve();
  expect(scope.signal.aborted).toBe(true);
  expect(closed).toBe(false);
  scope.finish(); await closing;
  expect(imports.activity()).toEqual([]);
  expect(closed).toBe(true);
  const held = createUpdateAdmission(); held.reserve("a".repeat(40));
  expect(() => createImportActivity(held).begin("Forbidden sample")).toThrow("closing to update");
});

it("AV-03 running imports are named and shutdown drains them before returning", async () => {
  const imports = createImportActivity(createUpdateAdmission());
  let finish: () => void = vi.fn();
  const work = imports.run("Import: Library database", () => new Promise<void>(resolve => { finish = resolve; }));
  let closed = false;
  try {
    expect(imports.activity()).toEqual(["Import: Library database"]);
    const closing = imports.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish(); await work; await closing;
    expect(imports.activity()).toEqual([]);
    await expect(imports.run("Too late", async () => undefined)).rejects.toThrow("shutting down");
  } finally { finish(); await work; }
});
