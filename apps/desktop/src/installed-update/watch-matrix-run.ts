import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { holds } from "./linux.ts";
import { rowOf, STOP_POINTS, type Row, type StopPoint } from "./stop-points.ts";
import { attempt, BEFORE, checkInvariants, MIGRATED, newLog, removeWorlds, STORE_AFTER, STORE_BEFORE, World, type RunEnd } from "./watch-fixture.ts";
import { contents } from "./store-fixture.ts";
import { beginUpdate, resumeWatcher, runWatcher } from "./watch.ts";

const FORWARD_ROWS: readonly Row[] = ["H", "W1", "W2", "S1", "S2", "S3", "L1", "L2", "A", "C"];
const GO_BACK_ROWS: readonly Row[] = ["H", "W1", "W2", "S1", "S2", "S3", "L1", "L2", "B1", "B2a", "B2b", "B3", "B4", "C"];
const SECOND_CRASH_ROWS: readonly Row[] = ["B1", "B2a", "B2b", "B3", "B4", "C"];

const onPath = (rows: readonly Row[]) => STOP_POINTS.filter(p => rows.includes(rowOf(p)));

export const FORWARD = onPath(FORWARD_ROWS);
export const GO_BACK = onPath(GO_BACK_ROWS);

export async function firstRun(w: World, crashAt?: StopPoint): Promise<{ end: RunEnd; points: StopPoint[] }> {
  const log = newLog();
  const fx = w.effects(log, crashAt);
  let spawned = false;
  const end = await attempt(async () => {
    beginUpdate(w.approval, { spawnWatcher: () => { spawned = true; }, stopAt: fx.stopAt, fs: fx.fs, earlierFailure: false });
    if (!spawned) throw new Error("row H did not spawn the watcher");
    return runWatcher(w.file, fx);
  });
  checkInvariants(w, end, log);
  return { end, points: log.points };
}

export async function resumeToEnd(w: World, firstCrash: StopPoint, crashAt?: StopPoint): Promise<{ end: RunEnd; outcome: string; points: StopPoint[]; crashes: StopPoint[] }> {
  const points: StopPoint[] = [], crashes: StopPoint[] = [];
  let crash = crashAt, last = firstCrash;
  for (let launch = 0; launch < 6; launch++) {
    w.watcherDied();
    const log = newLog();
    const end = await attempt(() => resumeWatcher(w.file, w.effects(log, crash)));
    points.push(...log.points);
    checkInvariants(w, end, log);
    if (end.outcome === "crashed") { crashes.push(end.point); last = end.point; crash = undefined; continue; }
    // why: a stuck unconfirmed stop needs a restart before the next launch can resume it
    if (end.outcome === "stuck" && (end.intent === "launch-new" || end.intent === "launch-old" || end.intent === "stop-new")) { w.reboot(); continue; }
    // why: a kill at C.after leaves nothing to resume; only then is "no transaction" the result
    const ended = end.outcome === "no-transaction" && last === "C.after" ? [...w.results.values()].at(-1)?.outcome : undefined;
    return { end, outcome: ended ?? end.outcome, points, crashes };
  }
  throw new Error("the transaction did not end in six launches");
}

export function expectForwardEnd(w: World, outcome: string): void {
  expect(outcome).toBe("updated");
  expect(holds(w.program, w.old, w.new)).toBe("new");
  expect(contents(w.live)).toEqual({ version: STORE_AFTER, ids: MIGRATED });
  expect([...w.results.values()].map(r => r.outcome)).toEqual(["updated"]);
  expectCleanedUp(w);
}

export function expectGoBackEnd(w: World, outcome: string): void {
  expect(outcome).toBe("rolled-back");
  expect(holds(w.program, w.old, w.new)).toBe("old");
  expect(contents(w.live)).toEqual({ version: STORE_BEFORE, ids: BEFORE });
  expect([...w.results.values()].map(r => r.outcome)).toEqual(["rolled-back"]);
  expectCleanedUp(w);
}

function expectCleanedUp(w: World): void {
  expect(w.transaction()).toBeNull();
  expect([existsSync(w.paths.previous), existsSync(w.paths.incoming), existsSync(w.download)]).toEqual([false, false, false]);
}

const second = (path: readonly StopPoint[]) => path.filter(p => SECOND_CRASH_ROWS.includes(rowOf(p)));

export function secondCrashSuite(path: "forward" | "go-back", part = 0, parts = 1): void {
  afterEach(removeWorlds);
  const all = path === "forward" ? FORWARD : GO_BACK;
  const seconds = second(all);
  // why: every parts-th first point from part, so one path's cases split evenly across files
  const firsts = all.filter((_, i) => i % parts === part);
  const hit = new Set<StopPoint>();
  const title = `killed again during the recovery on the ${path} path, at each point of rows B1 to C${parts > 1 ? ` (part ${part + 1} of ${parts})` : ""}`;
  // why: the last test reads what the cases above it reached, so this suite keeps its written order
  describe(title, { shuffle: false }, () => {
    // why: one case walks every second crash point, so its limit covers the whole loop
    it.each(firsts)("first at %s", async first => {
      for (const point of seconds) {
        removeWorlds();
        const w = new World({ newAcks: path === "forward" });
        await firstRun(w, first);
        const recovery = await resumeToEnd(w, first, point);
        if (recovery.crashes.includes(point)) hit.add(point);
        if (path === "forward") expectForwardEnd(w, recovery.outcome);
        else expectGoBackEnd(w, recovery.outcome);
      }
    }, 120_000);

    it("every point of rows B1 to C was reached by some second crash", () => {
      expect([...hit].toSorted()).toEqual(seconds.toSorted());
    });
  });
}
