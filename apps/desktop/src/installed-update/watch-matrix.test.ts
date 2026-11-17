// The crash matrix: for every named stop point, start a fresh update, kill
// the watcher there, then resume until it ends, checking the design's five
// invariants after every run. Forward path (ends `updated`) and go-back path
// (the new version never acknowledges; ends `rolled-back`), then a second
// crash during the recovery at each point of rows B1 to C (watch-recovery-*.test.ts).
import { afterEach, describe, expect, it } from "vitest";
import { rowOf, type Row, type StopPoint } from "./stop-points.ts";
import { newLog, removeWorlds, World } from "./watch-fixture.ts";
import { beginUpdate, runWatcher } from "./watch.ts";
import { expectForwardEnd, expectGoBackEnd, firstRun, FORWARD, GO_BACK, resumeToEnd } from "./watch-matrix-run.ts";

afterEach(removeWorlds);

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

describe("what a stop point means", () => {
  // B4's own action records the old version's ack as `went-back`; C's own action removes the record.
  const OWN_WRITE: Partial<Record<Row, string | null>> = { B4: "went-back", C: null };
  it.each([["forward", {}], ["go-back", { newAcks: false }]] as const)("on the %s path no row has written the next row's intent by its .after point", async (_path, options) => {
    const w = new World(options);
    const fx = w.effects(newLog());
    const intents = new Map<StopPoint, string | null>();
    const stopAt = (point: StopPoint) => { intents.set(point, w.transaction()?.intent ?? null); fx.stopAt?.(point); };
    beginUpdate(w.approval, { spawnWatcher: () => {}, stopAt, fs: fx.fs, earlierFailure: false });
    await runWatcher(w.file, { ...fx, stopAt });
    const rows = [...intents.keys()].filter(point => point.endsWith(".before")).map(rowOf);
    expect(rows.length).toBeGreaterThan(8);
    const moved = rows.filter(row => intents.get(`${row}.after`) !== (row in OWN_WRITE ? OWN_WRITE[row] : intents.get(`${row}.before`)));
    expect(moved).toEqual([]);
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
