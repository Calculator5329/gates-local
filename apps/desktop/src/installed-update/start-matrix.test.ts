// The start matrix of an installed copy: the update is cut off at every named
// stop point, and then the person starts the app. watch-matrix.test.ts
// resumes the watcher directly; here every start goes through what a real
// start reads and decides (launchFacts, decideLaunch) before anything runs.
//
// The rules:
//   - a start beside an update that is not finished never opens the app as
//     an ordinary one: it finishes the update or goes back first;
//   - when the app does open, the program file is all of the old version or
//     all of the new one, and the thread store is the one that version left;
//   - the old program is kept whole until the new one is accepted;
//   - a version folder that could be in use is never deleted;
//   - going back moves the store the new version left aside, whole;
//   - a ready note counts only for the launch it names.
//
// Each `rule` also runs with the guard it rests on switched off, and must
// fail there.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { identify, sameIdentity, type Identity } from "@gates-local/update/installed/files";
import { inUse, STARTED_FILE, type Look } from "@gates-local/update/installed/in-use";
import { rule } from "@gates-local/update/rules-testing";
import { readAck, waitForAck, writeAck } from "./ack.ts";
import { decideLaunch, type LaunchKind } from "./launch-kinds.ts";
import { holds } from "./linux.ts";
import { STORE_FILES } from "./restore.ts";
import { launchFacts } from "./routing.ts";
import { rowOf, STOP_POINTS, type Row, type StopPoint } from "./stop-points.ts";
import { contents } from "./store-fixture.ts";
import { attempt, BEFORE, checkInvariants, MIGRATED, newLog, removeWorlds, STORE_AFTER, STORE_BEFORE, World, type RunEnd } from "./watch-fixture.ts";
import { beginUpdate, resumeWatcher, retryCleanup, runWatcher } from "./watch.ts";

afterEach(removeWorlds);

const FORWARD_ROWS: readonly Row[] = ["H", "W1", "W2", "S1", "S2", "S3", "L1", "L2", "A", "C"];
const GO_BACK_ROWS: readonly Row[] = ["H", "W1", "W2", "S1", "S2", "S3", "L1", "L2", "B1", "B2a", "B2b", "B3", "B4", "C"];
const onPath = (rows: readonly Row[]) => STOP_POINTS.filter(p => rows.includes(rowOf(p)));

/** The person clicked and main quit; the update runs until it ends or is killed at `crashAt`. */
async function update(w: World, crashAt?: StopPoint): Promise<RunEnd> {
  const log = newLog();
  const fx = w.effects(log, crashAt);
  const end = await attempt(async () => {
    beginUpdate(w.approval, { spawnWatcher: () => undefined, stopAt: fx.stopAt, fs: fx.fs, earlierFailure: false });
    return runWatcher(w.file, fx);
  });
  checkInvariants(w, end, log);
  return end;
}

type Kind = LaunchKind["kind"];

/** What a start reads and decides, with no flag and no token: the person's own double-click. */
const decided = (w: World): LaunchKind => decideLaunch(launchFacts(w.approval.copy, [w.program], {}));

/**
 * The person starts the app, after whatever ran the update has died and its
 * own launches have closed. Returns what the start decided and whether the
 * app is open at the end of it.
 */
async function personStartsTheApp(w: World): Promise<{ readonly kind: Kind; readonly open: boolean }> {
  w.watcherDied();
  const launch = decided(w);
  switch (launch.kind) {
    case "ordinary":
    case "show-earlier-failure":
      expect(w.transaction(), "the app started as usual beside an update that was not finished").toBeNull();
      return { kind: launch.kind, open: true };
    case "ordinary-after-cleanup":
      // Only leftovers remain: they are removed once more, and the app starts whatever that did.
      retryCleanup(launch.transactionFile, w.effects(newLog()).fs);
      return { kind: launch.kind, open: true };
    case "become-watcher": {
      const log = newLog();
      const end = await attempt(() => resumeWatcher(launch.transactionFile, w.effects(log)));
      checkInvariants(w, end, log);
      if (end.outcome === "updated" || end.outcome === "rolled-back" || end.outcome === "stopped") return { kind: launch.kind, open: true };
      // A launch of the update that cannot be shown to have ended: nothing is changed until the computer restarts.
      if (end.outcome === "stuck") {
        w.reboot();
        return { kind: launch.kind, open: false };
      }
      throw new Error(`a start that took the update over ended ${end.outcome}`);
    }
    default:
      throw new Error(`a start with nothing else running was told ${launch.kind}`);
  }
}

/** The person starts the app until it is open: at most six starts. */
async function startsUntilOpen(w: World): Promise<Kind[]> {
  const kinds: Kind[] = [];
  for (let n = 0; n < 6; n++) {
    const start = await personStartsTheApp(w);
    kinds.push(start.kind);
    if (start.open) return kinds;
  }
  throw new Error(`the app was not open after six starts: ${kinds.join(", ")}`);
}

/** The app is open: one whole version at the program path, with the store that version left. */
function expectOpenOnOneVersion(w: World): "old" | "new" {
  const at = holds(w.program, w.old, w.new);
  if (at === "neither") throw new Error("the program file is neither the old version nor the new one");
  expect(contents(w.live), `the store does not belong to the ${at} version`).toEqual(at === "new" ? { version: STORE_AFTER, ids: MIGRATED } : { version: STORE_BEFORE, ids: BEFORE });
  return at;
}

describe.each([
  { title: "the new version starts", newAcks: true, points: onPath(FORWARD_ROWS), ends: "new" as const },
  { title: "the new version never becomes ready", newAcks: false, points: onPath(GO_BACK_ROWS), ends: "old" as const },
])("an installed copy's update where $title, cut off at each point, then the person starts the app", ({ newAcks, points, ends }) => {
  it.each(points)("%s", async point => {
    const w = new World({ newAcks });
    expect(await update(w, point)).toEqual({ outcome: "crashed", point });
    const kinds = await startsUntilOpen(w);
    expect(expectOpenOnOneVersion(w)).toBe(ends);
    // Nothing of the update is left saved, and the next start is an ordinary one.
    expect(w.transaction()).toBeNull();
    expect((await personStartsTheApp(w)).kind).toBe("ordinary");
    // Only a cut after the last delete leaves a first start with nothing to do.
    if (point !== "C.after") expect(kinds[0]).not.toBe("ordinary");
  });
});

describe("the guards these rules rest on", () => {
  rule("a start beside an update that is not finished never opens the app as usual", { without: "installed-start-skips-the-look", fails: /the app started as usual beside an update that was not finished/ }, async () => {
    // Cut off between the store going aside and the old one coming back: the data folder has no store, and a server started here would make an empty one.
    const w = new World({ newAcks: false });
    expect(await update(w, "B2a.after")).toEqual({ outcome: "crashed", point: "B2a.after" });
    expect(existsSync(w.live)).toBe(false);
    expect((await personStartsTheApp(w)).kind).toBe("become-watcher");
    expect(expectOpenOnOneVersion(w)).toBe("old");
  });

  rule("the old program is kept whole until the new one is accepted", { without: "program-written-in-place", fails: /the kept old program no longer holds the old version/ }, async () => {
    const w = new World({ newAcks: false });
    expect(await update(w, "S3.rename")).toEqual({ outcome: "crashed", point: "S3.rename" });
    expect(holds(w.program, w.old, w.new)).toBe("new");
    expect(sameIdentity(identify(w.paths.previous), w.old), "the kept old program no longer holds the old version").toBe(true);
    // And so the go-back that follows puts the old version back.
    await startsUntilOpen(w);
    expect(expectOpenOnOneVersion(w)).toBe("old");
  });

  rule("a version folder the app was started from is not deleted by the update's cleanup", { without: "delete-a-folder-in-use", fails: /a version folder the person starts the app from was deleted/ }, async () => {
    const w = new World();
    // The note a copy leaves in its version folder when it finds itself started from there.
    writeFileSync(path.join(w.download, STARTED_FILE), "2026-01-01T00:00:00.000Z\n");
    expect((await update(w)).outcome).toBe("updated");
    expect(existsSync(w.artifactFile), "a version folder the person starts the app from was deleted").toBe(true);
    expect(readFileSync(w.artifactFile)).toEqual(readFileSync(w.program));
    expect(w.transaction()).toBeNull();
  });

  const nothing: Look = { running: () => [], launchers: () => [] };
  const reasons: ReadonlyArray<readonly [string, (w: World) => { readonly programs?: readonly string[]; readonly look?: Look }]> = [
    ["this app's own program is in it", w => ({ programs: [w.artifactFile] })],
    ["a running program is in it", w => ({ look: { ...nothing, running: () => [w.artifactFile] } })],
    ["a launcher starts a file in it", w => ({ look: { ...nothing, launchers: () => [`[Desktop Entry]\nExec=${w.artifactFile} %U\n`] } })],
    ["the running programs cannot be read", () => ({ look: { ...nothing, running: () => null } })],
    ["the launchers cannot be read", () => ({ look: { ...nothing, launchers: () => null } })],
  ];
  for (const [reason, facts] of reasons) {
    rule(`a version folder counts as in use, and is left, when ${reason}`, { without: "delete-a-folder-in-use", fails: /a version folder that could be in use was called free/ }, () => {
      const w = new World();
      const { programs = [], look = nothing } = facts(w);
      expect(inUse(w.download, [], nothing)).toBeNull();
      expect(inUse(w.download, programs, look), "a version folder that could be in use was called free").not.toBeNull();
    });
  }

  rule("going back moves the store the new version left aside, whole", { without: "go-back-drops-the-store", fails: /the store the new version left was not kept/ }, async () => {
    const w = new World({ newAcks: false });
    expect(await update(w, "B2a.before")).toEqual({ outcome: "crashed", point: "B2a.before" });
    const left = new Map<string, Identity>();
    for (const name of STORE_FILES) {
      const found = identify(path.join(w.dataDir, name));
      if (found !== null) left.set(name, found);
    }
    expect([...left.keys()]).toContain(STORE_FILES[0]);
    await startsUntilOpen(w);
    expect(expectOpenOnOneVersion(w)).toBe("old");
    for (const [name, was] of left) expect(sameIdentity(identify(path.join(w.aside, name)), was), `the store the new version left was not kept: ${name}`).toBe(true);
  });

  rule("a ready note counts only for the launch it names", { without: "any-ready-note-counts", fails: /another launch's ready note was taken for this one's/ }, async () => {
    const w = new World();
    writeAck(w.dataDir, "T-earlier");
    expect(readAck(w.dataDir, "T-earlier")).toBe(true);
    expect(readAck(w.dataDir, "T-now"), "another launch's ready note was taken for this one's").toBe(false);
    const record = { pid: 1, start: "start-1", uptime: 1 };
    expect(await waitForAck({ dataDir: w.dataDir, token: "T-now", record, timeoutMs: 0, treeGone: () => false, now: () => 0, sleep: async () => undefined })).toBe("timeout");
  });
});
