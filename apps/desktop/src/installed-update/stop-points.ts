// The named points where a test build can kill the watcher (design section
// 10, "Interruption, row level"). Reading GATES_LOCAL_UPDATE_TEST_STOP_AT in a
// test build and turning it into a `stopAt` effect is the wiring lane's job.
//
// `<row>.before`: the row's intent is on disk and its action has not started
// (rows with no intent of their own, W1 and L2, at the row's start).
// `<row>.after`: the row's action and its flush are done, and the next row's
// intent is not written. A crash just before an intent is written is the
// previous row's `.after`. "Between the result write and row C" is `A.after`
// and `B4.after`.
import { STORE_FILES } from "./restore.ts";

export const ROWS = ["H", "W1", "W2", "S1", "S2", "S3", "L1", "L2", "A", "B1", "B2a", "B2b", "B3", "B4", "C"] as const;
export type Row = (typeof ROWS)[number];

/** Points inside an operation: after each B2a rename, after the B2b copy flush and rename, after the S3 rename, and the spawns whose record is not saved yet. */
export const INSIDE = [
  "S3.rename", "L1.spawned",
  ...STORE_FILES.map(name => `B2a.rename.${name}` as const),
  "B2b.flush", "B2b.rename", "B4.spawned", "B4.went-back",
] as const;

export type StopPoint = `${Row}.before` | `${Row}.after` | (typeof INSIDE)[number];

export const STOP_POINTS: readonly StopPoint[] = [...ROWS.flatMap(row => [`${row}.before` as const, `${row}.after` as const]), ...INSIDE];

/** The row a point belongs to. */
export const rowOf = (point: StopPoint): Row => {
  const row = ROWS.find(r => point.startsWith(`${r}.`));
  if (row === undefined) throw new Error(`no row for ${point}`);
  return row;
};
