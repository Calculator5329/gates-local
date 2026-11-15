// The rules of an update's handoff, from the person's click to the program
// that makes the change, kept over the real modules (update-rules-harness.ts).
// The rule that matters most: no new work starts after the person approved
// and the update still goes ahead under it. Each `rule` also runs with the
// guard it rests on switched off, and must fail there.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli, type Relaunch } from "@gates-local/update/cli";
import { rule } from "@gates-local/update/rules-testing";
import { acknowledgeStartup } from "@gates-local/update/startup";
import { type Repos, commit, fakePnpm, head, makeRepos, publish, removeRepos, testEnv } from "@gates-local/update/testing";
import { readTransaction } from "@gates-local/update/transaction";
import { removeWorlds, World } from "../apps/desktop/src/installed-update/watch-fixture.ts";
import { type Copy, type Handoff, handoff } from "./update-rules-harness.ts";

let r: Repos;
let target: string;
let open: Handoff | undefined;

beforeEach(() => {
  r = makeRepos();
  for (const [k, v] of Object.entries(testEnv(r.base))) vi.stubEnv(k, v);
  target = commit(r.seed, "Newer");
  publish(r.seed);
});
afterEach(async () => {
  await open?.end();
  open = undefined;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  removeRepos(r);
  removeWorlds();
});

const KINDS = ["checkout", "installed"] as const;
type Kind = (typeof KINDS)[number];

function begin(kind: Kind): Handoff {
  const copy: Copy = kind === "checkout" ? { kind, repos: r, target } : { kind, world: new World() };
  open = handoff(copy);
  return open;
}

/** The person clicked, main took the reservation over and started the program that makes the change. */
async function handedOver(kind: Kind): Promise<Handoff> {
  const h = begin(kind);
  h.personApproves();
  await h.mainCommits();
  expect(await h.mainStartsTheUpdater()).toEqual({ ok: true });
  return h;
}

describe.each(KINDS)("the handoff of an approved update, %s", (kind) => {
  rule("from the click on, no new work is let in at any step", { without: "reservation-lets-work-in", fails: /work was let in after the person approved/ }, async () => {
    const h = begin(kind);
    h.personApproves();
    expect(h.workStarts(), "work was let in after the person approved").toBe(false);
    await h.mainCommits();
    expect(h.workStarts(), "work was let in after main committed").toBe(false);
    await h.mainStartsTheUpdater();
    expect(h.workStarts(), "work was let in after main started the updater").toBe(false);
    h.mainLetsGo();
    expect(h.workStarts(), "work was let in the moment main let go").toBe(false);
    await h.timePasses(1_000);
    expect(h.workStarts(), "work was let in a second after main let go").toBe(false);
  });

  rule("the window's key cannot call the update off once main holds it", { without: "commit-leaves-the-window-its-key", fails: /the window's late cancel was taken/ }, async () => {
    const h = await handedOver(kind);
    expect(h.windowCancels(), "the window's late cancel was taken").toBe(false);
    expect(h.workStarts(), "work was let in after the window's late cancel").toBe(false);
  });

  rule("main calls the update off only when the updater did not start", { without: "cancel-after-a-good-start", fails: /work was let in after main started the updater/ }, async () => {
    const h = await handedOver(kind);
    expect(h.workStarts(), "work was let in after main started the updater").toBe(false);
  });

  it("an updater that could not be started gives the app back to work at once", async () => {
    const h = begin(kind);
    h.personApproves();
    await h.mainCommits();
    expect(await h.mainStartsTheUpdater(false)).toEqual({ ok: false, message: "The updater could not be started." });
    expect(h.workStarts()).toBe(true);
  });

  it("with the old app gone in time and no work let in, the update goes ahead", async () => {
    const h = await handedOver(kind);
    h.mainLetsGo();
    await h.timePasses(kind === "checkout" ? 3_000 : 25_000);
    expect(h.workStarts()).toBe(false);
    expect(await h.updaterSeesTheOldAppGone()).toBe(true);
  });

  // Main let go and never quit. The server gives up waiting and lets work in. From then on the update must not go ahead:
  // an installed copy's server waits as long as its watcher does, and a checkout's updater reads its deadline again.
  rule("once work is let back in, the update no longer goes ahead", { without: kind === "installed" ? "grace-is-the-short-one" : "deadline-read-once", fails: /the update went ahead after work had started/ }, async () => {
    const h = await handedOver(kind);
    h.mainLetsGo();
    await h.graceRunsOut();
    expect(h.workStarts(), "the server never gave the app back to work").toBe(true);
    expect(await h.updaterSeesTheOldAppGone(), "the update went ahead after work had started").toBe(false);
  });
});

describe("the approval's deadline", () => {
  rule("a checkout's updater reads the deadline again once the old app has closed", { without: "deadline-read-once", fails: /the update went ahead after the deadline/ }, async () => {
    const old = head(r.clone);
    const h = await handedOver("checkout");
    expect(await h.updaterSeesTheOldAppGone({ afterMs: 6_000 }), "the update went ahead after the deadline").toBe(false);
    expect(head(r.clone)).toBe(old);
    expect(readTransaction(r.clone)).toBeNull();
  });

  it("an installed copy's watcher stops when the old app is gone only after the deadline", async () => {
    const h = await handedOver("installed");
    expect(await h.updaterSeesTheOldAppGone({ afterMs: 31_000 })).toBe(false);
  });
});

describe("the word \"updated\"", () => {
  rule("a checkout says it only when the launch its updater made reached a ready server", { without: "any-ready-note-counts", fails: /another launch's ready server was taken for the update's own/ }, async () => {
    const old = head(r.clone);
    const fake = fakePnpm();
    const said: string[] = [];
    const taken: boolean[] = [];
    const relaunch = (spec: Relaunch) => {
      if (spec.startup === undefined) return undefined;
      // Two other launches reach a ready server while the updater waits for its own: one carrying another update's token, one started by hand.
      taken.push(acknowledgeStartup(r.clone, r.data, "another-launch"), acknowledgeStartup(r.clone, r.data, undefined));
      return { pid: process.pid, stop: async () => true };
    };
    const code = await runCli({
      root: r.clone, argv: ["--data-dir", r.data], defaultDataDir: r.data, pnpm: fake.pnpm, runner: fake.runner,
      appRunning: () => null, relaunch, print: (line) => said.push(line), platform: "linux", startupTimeoutMs: 300,
    });
    expect(taken, "another launch's ready server was taken for the update's own").toEqual([false, false]);
    expect(said.join("\n")).not.toMatch(/Updated to/);
    expect(code).toBe(1);
    // Its own launch never said ready, so the update went back.
    expect(head(r.clone)).toBe(old);
  });
});
