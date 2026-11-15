import fs, { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readRecord, RECORD_FILE, removeRecord, takeRecord, writeRecord, type UpdateRecord } from "./record.ts";

const folder = () => mkdtempSync(path.join(process.env["TMPDIR"] ?? os.tmpdir(), "record-"));
afterEach(() => vi.restoreAllMocks());

const rolledBack: UpdateRecord = {
  at: 1,
  outcome: "rolled-back",
  installed: { id: "tx-1", from: "0.4.0", to: "0.4.1", text: "Version 0.4.1 did not start, so Gates Local went back to 0.4.0. Your chats are as they were when you clicked Restart.", token: "t2" },
};

it("UR-01 an installed copy's rolled-back result keeps its token and transaction, and reading it leaves the file", () => {
  const dir = folder();
  writeRecord(dir, rolledBack);
  expect(readRecord(dir)).toEqual(rolledBack);
  // A token launch and a phone status call read it; neither consumes it.
  expect(readRecord(dir)).toEqual(rolledBack);
  expect(existsSync(path.join(dir, RECORD_FILE))).toBe(true);
  removeRecord(dir);
  expect(readRecord(dir)).toBeUndefined();
});

it("UR-02 a rollback-failed result keeps the paths it names", () => {
  const dir = folder();
  const failed: UpdateRecord = { at: 2, outcome: "rollback-failed", installed: { id: "tx-2", from: "0.4.0", to: "0.4.1", text: "words", link: true, keeps: ["/a/.previous", "/b/updates/0.4.1"] } };
  writeRecord(dir, failed);
  expect(takeRecord(dir)).toEqual(failed);
  expect(existsSync(path.join(dir, RECORD_FILE))).toBe(false);
});

it("UR-03 the write flushes the file and its folder, and leaves no temporary file", () => {
  const dir = folder();
  const synced = vi.spyOn(fs, "fsyncSync");
  writeRecord(dir, rolledBack);
  expect(synced).toHaveBeenCalledTimes(2);
  expect(readdirSync(dir)).toEqual([RECORD_FILE]);
});

it("UR-04 an installed part that does not decode is dropped, the clone fields stay", () => {
  const dir = folder();
  writeFileSync(path.join(dir, RECORD_FILE), JSON.stringify({ version: 1, at: 3, outcome: "updated", installed: { id: 5 } }));
  expect(readRecord(dir)).toEqual({ at: 3, outcome: "updated" });
  writeFileSync(path.join(dir, RECORD_FILE), JSON.stringify({ version: 1, at: 3, outcome: "went-sideways" }));
  expect(readRecord(dir)).toBeUndefined();
  expect(JSON.parse(readFileSync(path.join(dir, RECORD_FILE), "utf8"))).toMatchObject({ outcome: "went-sideways" });
});
