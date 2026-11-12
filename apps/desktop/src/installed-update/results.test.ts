// The watcher's results in update-result.json (section 1): what it writes is
// what the token launch and the next ordinary start read back, by transaction.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRecord, RECORD_FILE, writeRecord } from "../../../server/src/update/record.ts";
import { hasEarlierFailure, readResult, writeResult } from "./results.ts";
import type { InstalledResult } from "./watch.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function dataDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "iu-results-"));
  roots.push(root);
  return root;
}
const updated: InstalledResult = { id: "tx1", from: "0.9.0", to: "0.9.1", outcome: "updated", token: "T1", words: { text: "Updated to v0.9.1." } };
const failed: InstalledResult = { id: "tx2", from: "0.9.0", to: "0.9.1", outcome: "rollback-failed", keeps: ["/a/.x.previous-tx2"], words: { text: "Could not go back.", detail: "Start it by hand.", link: true } };
const stopped: InstalledResult = { id: "tx3", from: "0.9.0", to: "0.9.1", outcome: "stopped", words: { text: "Stopped before changing anything." } };

describe("results", () => {
  it("RS-01 each kind round-trips through the record, read by its transaction id only", () => {
    const dir = dataDir();
    const rolledBack: InstalledResult = { ...stopped, id: "tx4", outcome: "rolled-back", token: "T2" };
    for (const result of [updated, failed, stopped, rolledBack]) {
      writeResult(dir, result, () => 1000);
      expect(readResult(dir, result.id)).toEqual(result);
      expect(readResult(dir, "other")).toBeNull();
    }
  });

  it("RS-02 the server's reader sees the installed part with the token and the outcome", () => {
    const dir = dataDir();
    writeResult(dir, updated, () => 1000);
    expect(readRecord(dir)).toEqual({ at: 1000, outcome: "updated", installed: { id: "tx1", from: "0.9.0", to: "0.9.1", text: "Updated to v0.9.1.", token: "T1" } });
  });

  it("RS-03 an earlier failure is an installed rollback-failed note; anything else, or a torn file, is not", () => {
    const dir = dataDir();
    expect(hasEarlierFailure(dir)).toBe(false);
    writeResult(dir, updated, () => 1);
    expect(hasEarlierFailure(dir)).toBe(false);
    writeResult(dir, failed, () => 1);
    expect(hasEarlierFailure(dir)).toBe(true);
    writeRecord(dir, { at: 1, outcome: "rollback-failed" });
    expect(hasEarlierFailure(dir)).toBe(false);
    writeFileSync(path.join(dir, RECORD_FILE), "{");
    expect(hasEarlierFailure(dir)).toBe(false);
    expect(readResult(dir, "tx2")).toBeNull();
  });
});
