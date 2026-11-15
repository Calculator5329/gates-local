import { describe, expect, it } from "vitest";
import { groupAlive, processAlive, type ProcessSystem } from "./process-state.ts";

const stat = (state: string, group = 10, start = "987654") => `11 (odd) name (x)) ${state} 1 ${group} 3 0 -1 4 5 6 7 8 9 10 11 12 20 0 1 0 ${start} 1000 2000`;
const denied = () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); };
function table(rows: Record<number, string>, extra: Partial<ProcessSystem> = {}): ProcessSystem {
  return {
    platform: "linux", exists: () => true, pids: () => Object.keys(rows).map(Number), tasks: (pid) => [pid],
    stat: (pid) => {
      const value = rows[pid];
      if (value === undefined) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return value;
    }, ...extra,
  };
}

describe("process liveness", () => {
  it("distinguishes exited zombies from running, sleeping and stopped processes", () => {
    for (const state of ["Z", "X", "x"]) expect(processAlive(11, table({ 11: stat(state) }))).toBe(false);
    for (const state of ["R", "S", "D", "T", "t", "I"]) expect(processAlive(11, table({ 11: stat(state) }))).toBe(true);
    expect(processAlive(11, table({}))).toBe(false);
    expect(processAlive(11, table({}, { platform: "win32" }))).toBe(true);
  });
  it("clears a stable all-zombie group, including when the leader is gone", () => {
    expect(groupAlive(10, table({ 10: stat("Z"), 11: stat("Z") }))).toBe(false);
    expect(groupAlive(10, table({ 11: stat("Z"), 12: stat("X") }))).toBe(false);
  });
  it("a zombie main thread with a live worker still blocks", () => {
    const on = table({ 11: stat("Z"), 12: stat("S") }, { pids: () => [11], tasks: () => [11, 12] });
    expect(processAlive(11, on)).toBe(true);
    expect(groupAlive(10, on)).toBe(true);
    expect(processAlive(11, table({ 11: stat("Z"), 12: stat("Z") }, { pids: () => [11], tasks: () => [11, 12] }))).toBe(false);
    expect(groupAlive(10, table({ 11: stat("Z"), 12: stat("Z") }, { pids: () => [11], tasks: () => [11, 12] }))).toBe(false);
  });
  it("a live member blocks with a dead or absent leader, whatever unrelated processes do", () => {
    expect(groupAlive(10, table({ 10: stat("Z"), 11: stat("S"), 12: stat("Z", 12) }))).toBe(true);
    expect(groupAlive(10, table({ 11: stat("S") }))).toBe(true);
    expect(groupAlive(10, table({ 11: stat("Z"), 12: stat("S", 12) }))).toBe(false);
    expect(groupAlive(10, table({}, { platform: "darwin" }))).toBe(true);
  });
  it("does not claim an unreadable, malformed or unseen group ended", () => {
    expect(processAlive(11, table({}, { stat: denied }))).toBe(true);
    expect(processAlive(11, table({ 11: "invalid stat" }))).toBe(true);
    expect(groupAlive(10, table({ 11: "invalid stat" }))).toBe(true);
    expect(groupAlive(10, table({}, { pids: denied }))).toBe(true);
    expect(groupAlive(10, table({ 11: stat("Z") }, { stat: denied }))).toBe(true);
    expect(groupAlive(10, table({}))).toBe(true);
    expect(processAlive(11, table({ 11: stat("Z") }, { tasks: denied }))).toBe(true);
    expect(groupAlive(10, table({ 11: stat("Z") }, { tasks: denied }))).toBe(true);
    const vanishedWorker = table({ 11: stat("Z") }, { pids: () => [11], tasks: () => [11, 12] });
    expect(processAlive(11, vanishedWorker)).toBe(true);
    expect(groupAlive(10, vanishedWorker)).toBe(true);
  });
  it("a changing group membership or start time stays live", () => {
    let reads = 0;
    expect(groupAlive(10, table({ 11: stat("Z"), 12: stat("Z") }, { pids: () => ++reads === 1 ? [11] : [11, 12] }))).toBe(true);
    reads = 0;
    expect(groupAlive(10, table({}, { pids: () => [11], stat: () => stat("Z", 10, String(++reads)) }))).toBe(true);
  });
  it("ignores vanished entries but never treats an invalid id as this process group", () => {
    expect(groupAlive(10, table({ 11: stat("Z") }, { pids: () => [11, 12] }))).toBe(false);
    const absent = table({}, { exists: () => false });
    expect(processAlive(11, absent)).toBe(false);
    expect(groupAlive(10, absent)).toBe(false);
    for (const id of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(processAlive(id)).toBe(false);
      expect(groupAlive(id)).toBe(false);
    }
  });
});
