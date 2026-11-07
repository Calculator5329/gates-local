import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { probeSandbox, runSandbox } from "./index.ts";

const probe = probeSandbox();
describe.skipIf(!probe.available)(`real bwrap confinement${probe.available ? "" : ` [SKIP: ${probe.reason}]`}`, () => {
  const root = mkdtempSync(path.join(tmpdir(), "gl-bwrap-"));
  const snapshotPath = path.join(root, "test.db");
  const db = new DatabaseSync(snapshotPath); db.exec("CREATE TABLE t(n); INSERT INTO t VALUES(42)"); db.close();
  const sources = [{ id: "test", label: "test.db", path: snapshotPath, snapshotPath, kind: "sqlite" as const }];
  it("SELECT returns real rows", async () => {
    expect(await runSandbox({ command: 'sqlite3 /data/test.db "SELECT * FROM t"', sources })).toContain("42");
  });
  for (const [name, command] of [
    ["CTE delete", 'sqlite3 /data/test.db "WITH x AS (SELECT 1) DELETE FROM t"'],
    ["pragma write", 'sqlite3 /data/test.db "PRAGMA user_version=7"'],
    ["data write", "echo nope > /data/test.db"],
    ["home read", 'cat "$HOME/.bashrc"'],
    ["network", "bash -c 'echo hi > /dev/tcp/1.1.1.1/80'"],
  ]) it(`${name} fails`, async () => { await expect(runSandbox({ command: command!, sources })).rejects.toThrow(); });
  it("kills commands over the time and output limits", async () => {
    await expect(runSandbox({ command: "sleep 10", sources, timeoutMs: 30 })).rejects.toThrow(/time limit/);
    await expect(runSandbox({ command: "yes", sources, outputCap: 100 })).rejects.toThrow(/output limit/);
  });
});
