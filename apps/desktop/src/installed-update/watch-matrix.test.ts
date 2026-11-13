// The crash matrix: for every named stop point, start a fresh update, kill
// the watcher there, then resume until it ends, checking the design's five
// invariants after every run. Forward path (ends `updated`) and go-back path
// (the new version never acknowledges; ends `rolled-back`), then a second
// crash during the recovery at each point of rows B1 to C.
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { holds } from "./linux.ts";
import { rowOf, STOP_POINTS, type Row, type StopPoint } from "./stop-points.ts";
import { attempt, BEFORE, checkInvariants, MIGRATED, newLog, removeWorlds, STORE_AFTER, STORE_BEFORE, World, type RunEnd } from "./watch-fixture.ts";
import { contents } from "./store-fixture.ts";
import { beginUpdate, resumeWatcher, runWatcher } from "./watch.ts";

afterEach(removeWorlds);

const FORWARD_ROWS: readonly Row[] = ["H", "W1", "W2", "S1", "S2", "S3", "L1", "L2", "A", "C"];
const GO_BACK_ROWS: readonly Row[] = ["H", "W1", "W2", "S1", "S2", "S3", "L1", "L2", "B1", "B2a", "B2b", "B3", "B4", "C"];
const SECOND_CRASH_ROWS: readonly Row[] = ["B1", "B2a", "B2b", "B3", "B4", "C"];

const onPath = (rows: readonly Row[]) => STOP_POINTS.filter(p => rows.includes(rowOf(p)));

const FORWARD = onPath(FORWARD_ROWS);
const GO_BACK = onPath(GO_BACK_ROWS);

/** Row H in the old main, then the watcher it spawned; `crashAt` kills whichever reaches the point first. */
async function firstRun(w: World, crashAt?: StopPoint): Promise<{ end: RunEnd; points: StopPoint[] }> {
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

/**
 * Later ordinary launches, each becoming the watcher, until the transaction
 * ends. A stuck unconfirmed stop needs a restart. `outcome` is how the
 * transaction ended: a kill at `C.after` leaves nothing to resume, and only
 * then is "no transaction" read as the result on disk.
 */
async function resumeToEnd(w: World, firstCrash: StopPoint, crashAt?: StopPoint): Promise<{ end: RunEnd; outcome: string; points: StopPoint[]; crashes: StopPoint[] }> {
  const points: StopPoint[] = [], crashes: StopPoint[] = [];
  let crash = crashAt, last = firstCrash;
  for (let launch = 0; launch < 6; launch++) {
    w.watcherDied();
    const log = newLog();
    const end = await attempt(() => resumeWatcher(w.file, w.effects(log, crash)));
    points.push(...log.points);
    checkInvariants(w, end, log);
    if (end.outcome === "crashed") { crashes.push(end.point); last = end.point; crash = undefined; continue; }
    if (end.outcome === "stuck" && (end.intent === "launch-new" || end.intent === "launch-old" || end.intent === "stop-new")) { w.reboot(); continue; }
    const ended = end.outcome === "no-transaction" && last === "C.after" ? [...w.results.values()].at(-1)?.outcome : undefined;
    return { end, outcome: ended ?? end.outcome, points, crashes };
  }
  throw new Error("the transaction did not end in six launches");
}

function expectForwardEnd(w: World, outcome: string): void {
  expect(outcome).toBe("updated");
  expect(holds(w.program, w.old, w.new)).toBe("new");
  expect(contents(w.live)).toEqual({ version: STORE_AFTER, ids: MIGRATED });
  expect([...w.results.values()].map(r => r.outcome)).toEqual(["updated"]);
  expectCleanedUp(w);
}

function expectGoBackEnd(w: World, outcome: string): void {
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

describe("without a crash", () => {
  it("the forward path passes every forward stop point once and ends updated", async () => {
    const w = new World();
    const { end, points } = await firstRun(w);
    expectForwardEnd(w, end.outcome);
    expect(points.toSorted()).toEqual(FORWARD.toSorted());
  });

  it("the go-back path passes every go-back stop point once and ends rolled-back", async () => {
    const w = new World({ newAcks: false });
    const { end, points } = await firstRun(w);
    expectGoBackEnd(w, end.outcome);
    expect(points.toSorted()).toEqual(GO_BACK.toSorted());
  });
});

describe("forward path, killed at each point, then resumed", () => {
  it.each(FORWARD)("%s", async point => {
    const w = new World();
    const first = await firstRun(w, point);
    expect(first.end).toEqual({ outcome: "crashed", point });
    expectForwardEnd(w, (await resumeToEnd(w, point)).outcome);
  });
});

describe("go-back path, killed at each point, then resumed", () => {
  it.each(GO_BACK)("%s", async point => {
    const w = new World({ newAcks: false });
    const first = await firstRun(w, point);
    expect(first.end).toEqual({ outcome: "crashed", point });
    expectGoBackEnd(w, (await resumeToEnd(w, point)).outcome);
  });
});

const second = (path: readonly StopPoint[]) => path.filter(p => SECOND_CRASH_ROWS.includes(rowOf(p)));

describe("killed again during the recovery, at each point of rows B1 to C", () => {
  const hit = { forward: new Set<StopPoint>(), "go-back": new Set<StopPoint>() };
  const cases = [
    ...FORWARD.map(p => ({ path: "forward" as const, first: p, seconds: second(FORWARD) })),
    ...GO_BACK.map(p => ({ path: "go-back" as const, first: p, seconds: second(GO_BACK) })),
  ];
  it.each(cases)("$path, first at $first", async ({ path, first, seconds }) => {
    for (const point of seconds) {
      removeWorlds();
      const w = new World({ newAcks: path === "forward" });
      await firstRun(w, first);
      const recovery = await resumeToEnd(w, first, point);
      if (recovery.crashes.includes(point)) hit[path].add(point);
      if (path === "forward") expectForwardEnd(w, recovery.outcome);
      else expectGoBackEnd(w, recovery.outcome);
    }
    // One case walks every second crash point, so its time is the whole loop's, not one recovery's.
  }, 120_000);

  it("every point of rows B1 to C on each path was reached by some second crash", () => {
    expect([...hit.forward].toSorted()).toEqual(second(FORWARD).toSorted());
    expect([...hit["go-back"]].toSorted()).toEqual(second(GO_BACK).toSorted());
  });
});
