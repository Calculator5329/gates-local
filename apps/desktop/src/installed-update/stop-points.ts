import { STORE_FILES } from "./restore.ts";

export const ROWS = ["H", "W1", "W2", "S1", "S2", "S3", "L1", "L2", "A", "B1", "B2a", "B2b", "B3", "B4", "C"] as const;
export type Row = (typeof ROWS)[number];

export const INSIDE = [
  "S3.rename", "L1.spawned",
  ...STORE_FILES.map(name => `B2a.rename.${name}` as const),
  "B2b.flush", "B2b.rename", "B4.spawned", "B4.went-back",
] as const;

export type StopPoint = `${Row}.before` | `${Row}.after` | (typeof INSIDE)[number];

export const STOP_POINTS: readonly StopPoint[] = [...ROWS.flatMap(row => [`${row}.before` as const, `${row}.after` as const]), ...INSIDE];

export const rowOf = (point: StopPoint): Row => {
  const row = ROWS.find(r => point.startsWith(`${r}.`));
  if (row === undefined) throw new Error(`no row for ${point}`);
  return row;
};
