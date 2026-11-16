import { readFileSync, readdirSync } from "node:fs";

/** `exists` answers as kill(pid, 0): a negative id asks about a process group, and EPERM counts as present. */
export interface ProcessSystem {
  readonly platform: NodeJS.Platform;
  exists(pid: number): boolean;
  stat(pid: number): string;
  pids(): readonly number[];
  tasks(pid: number): readonly number[];
}

function code(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
const missing = (error: unknown) => code(error) === "ENOENT" || code(error) === "ESRCH";
const system: ProcessSystem = {
  platform: process.platform,
  exists: (pid) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return code(error) === "EPERM"; }
  },
  stat: (pid) => readFileSync(`/proc/${pid}/stat`, "utf8"),
  pids: () => readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).map(Number),
  tasks: (pid) => readdirSync(`/proc/${pid}/task`).filter((entry) => /^\d+$/.test(entry)).map(Number),
};
const valid = (pid: number) => Number.isSafeInteger(pid) && pid > 0;
// external: on Linux an exited process stays listed, as a zombie, until its parent or a subreaper collects it.
const dead = (state: string) => state === "Z" || state === "X" || state === "x";

function fields(stat: string) {
  // external: in /proc/<pid>/stat comm may hold spaces and ')'; fields 3, 5 and 22 follow its last ')'.
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  const rest = stat.slice(close + 2).trim().split(/\s+/);
  const state = rest[0];
  const group = Number(rest[2]);
  const start = rest[19];
  if (!state || !/^[A-Za-z]$/.test(state) || !Number.isSafeInteger(group) || group < 0 || !start || !/^\d+$/.test(start)) return undefined;
  return { state, group, start };
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((member, i) => member === b[i]);

function exitedTasks(pid: number, row: NonNullable<ReturnType<typeof fields>>, on: ProcessSystem): string[] | undefined {
  const members = [`${pid}:${row.start}`];
  let tasks: readonly number[];
  try { tasks = on.tasks(pid); }
  catch { return undefined; }
  for (const task of tasks) {
    if (task === pid) continue;
    let worker: ReturnType<typeof fields>;
    try { worker = fields(on.stat(task)); }
    catch { return undefined; }
    if (!worker || worker.group !== row.group || !dead(worker.state)) return undefined;
    members.push(`${task}:${worker.start}`);
  }
  return members.toSorted();
}

/** An exited zombie cannot execute or hold an updater lock. Unreadable state stays conservatively live. */
export function processAlive(pid: number, on: ProcessSystem = system): boolean {
  if (!valid(pid) || !on.exists(pid)) return false;
  if (on.platform !== "linux") return true;
  try {
    const row = fields(on.stat(pid));
    if (row === undefined || !dead(row.state)) return true;
    const first = exitedTasks(pid, row, on);
    if (first === undefined) return true;
    const again = fields(on.stat(pid));
    if (!again || !dead(again.state) || again.start !== row.start || again.group !== row.group) return true;
    const second = exitedTasks(pid, again, on);
    return second === undefined || !same(first, second);
  } catch (error) { return !missing(error); }
}

/** Any live member counts, even after its leader exits. Only a stable all-dead group is cleared. */
export function groupAlive(pid: number, on: ProcessSystem = system): boolean {
  if (!valid(pid) || !on.exists(-pid)) return false;
  if (on.platform !== "linux") return true;
  const scan = (): string[] | undefined => {
    const members: string[] = [];
    for (const member of on.pids()) {
      let row: ReturnType<typeof fields>;
      try { row = fields(on.stat(member)); }
      catch (error) { if (missing(error)) continue; throw error; }
      if (row === undefined) return undefined;
      if (row.group !== pid) continue;
      if (!dead(row.state)) return undefined;
      const tasks = exitedTasks(member, row, on);
      if (tasks === undefined) return undefined;
      members.push(...tasks);
    }
    return members.toSorted();
  };
  try {
    const first = scan();
    if (first === undefined) return true;
    const second = scan();
    if (second === undefined) return true;
    if (first.length > 0 && same(first, second)) return false;
    return on.exists(-pid);
  } catch { return true; }
}
