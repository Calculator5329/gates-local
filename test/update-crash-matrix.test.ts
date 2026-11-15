// A source checkout's update, killed at each command that changes the copy,
// and then every next thing: the person starts the app, runs the updater by
// hand, edits a file first, or the power goes again during the recovery.
//
// The rules, over the real updater and the real start (startCheckout):
//   - no server ever starts on a copy that is not whole (one commit, its
//     files, its install and its builds);
//   - a start ends with the app open on the old version or the new one with
//     nothing left saved, or it says what is in the way and starts nothing;
//   - the person's files (an edit to a tracked file the update does not
//     touch, an untracked file, an ignored one) are byte for byte as they were.
//
// git is real, in a temporary folder; pnpm is a stand-in that records what
// was installed and built for which commit.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BUILD_DESKTOP_ARGS, BUILD_WEB_ARGS, INSTALL_ARGS, runUpdate } from "@gates-local/update/apply";
import { checkoutStartFacts, decideCheckoutStart, DID_NOT_START } from "@gates-local/update/checkout-start";
import { runCli, type Relaunch } from "@gates-local/update/cli";
import { rule } from "@gates-local/update/rules-testing";
import type { Runner } from "@gates-local/update/run";
import { acknowledgeStartup, STARTUP_TOKEN_ENV, waitForStartup } from "@gates-local/update/startup";
import { type Repos, commit, fakePnpm, git, head, makeRepos, publish, removeRepos, testEnv } from "@gates-local/update/testing";
import { readTransaction } from "@gates-local/update/transaction";
import { type CheckoutStartActs, type CheckoutStartEnd, startCheckout } from "../apps/desktop/src/checkout-start.ts";

const STEPS = ["install", "build-web", "build-desktop"] as const;
type Built = (typeof STEPS)[number];
type Command = "merge" | "reset" | Built;

/** The commands that change the copy, in the order a run with nothing in its way makes them. */
const FORWARD: readonly Command[] = ["merge", "install", "build-web", "build-desktop"];
/** The same when the new version's install fails: the run goes back. */
const AND_BACK: readonly Command[] = ["merge", "install", "reset", "install", "build-web", "build-desktop"];

const MINE = "a file of my own, never added to git\n";
const KEPT = "a file git ignores\n";
const EDIT = "notes\nand a line I added while the update was cut off\n";
const HALF = "half of the new version\n";

class PowerCut extends Error {}

/** Where the power goes: before the command starts, after it has ended, or (the switch only) with some files written and the commit not moved. */
interface Kill { readonly at: number; readonly how: "before" | "after" | "part-way" }

interface Copy {
  readonly root: string;
  readonly data: string;
  /** The new version's install fails, every time. */
  readonly installFails: boolean;
  /** The commit each step last finished for. */
  readonly built: Record<Built, string>;
  edited: boolean;
  /** One entry per server start: the commit it started on. */
  readonly servers: string[];
  /** Server starts on a copy that was not whole. */
  readonly halfStarts: string[];
}

let r: Repos;
let old: string;
let target: string;
let copies = 0;

beforeAll(() => {
  r = makeRepos();
  for (const [k, v] of Object.entries(testEnv(r.base))) vi.stubEnv(k, v);
  // A second tracked file, which the update does not touch.
  writeFileSync(path.join(r.seed, "notes.txt"), "notes\n");
  git(r.seed, "add", "notes.txt");
  git(r.seed, "commit", "--quiet", "-m", "Notes");
  publish(r.seed);
  git(r.clone, "pull", "--quiet", "--ff-only");
  old = head(r.clone);
  target = commit(r.seed, "Newer");
  publish(r.seed);
  writeFileSync(path.join(r.clone, "mine.txt"), MINE);
  mkdirSync(path.join(r.clone, "ignored"));
  writeFileSync(path.join(r.clone, "ignored", "keep.txt"), KEPT);
});
afterAll(() => {
  vi.unstubAllEnvs();
  removeRepos(r);
});

/** A copy of the checkout on the old version, installed and built, with the person's two files in it. */
function fresh(installFails: boolean): Copy {
  const root = path.join(r.base, `copy-${++copies}`);
  cpSync(r.clone, root, { recursive: true });
  const data = `${root}-data`;
  mkdirSync(data);
  return { root, data, installFails, built: { install: old, "build-web": old, "build-desktop": old }, edited: false, servers: [], halfStarts: [] };
}

const same = (a: readonly string[], b: readonly string[]) => a.join(" ") === b.join(" ");

function commandOf(command: string, args: readonly string[]): Command | null {
  if (command === "git") return args[0] === "merge" ? "merge" : args[0] === "reset" ? "reset" : null;
  if (same(args, INSTALL_ARGS)) return "install";
  if (same(args, BUILD_WEB_ARGS)) return "build-web";
  return same(args, BUILD_DESKTOP_ARGS) ? "build-desktop" : null;
}

/** The updater's git and pnpm for one run: real git, a pnpm that records, and the power cut. `ran` lists the commands that changed the copy. */
function commands(w: Copy, kill: Kill | undefined): { pnpm: ReturnType<typeof fakePnpm>["pnpm"]; runner: Runner; ran: Command[] } {
  const fake = fakePnpm((args) => w.installFails && same(args, INSTALL_ARGS) && head(w.root) === target);
  const ran: Command[] = [];
  const runner: Runner = async (command, args, options) => {
    const which = commandOf(command, args);
    if (which === null) return fake.runner(command, args, options);
    const how = kill?.at === ran.length ? kill.how : null;
    ran.push(which);
    if (how === "before") throw new PowerCut();
    if (how === "part-way") {
      writeFileSync(path.join(w.root, "app.txt"), HALF);
      throw new PowerCut();
    }
    const result = await fake.runner(command, args, options);
    if (which !== "merge" && which !== "reset") w.built[which] = result.code === 0 ? head(w.root) : `nothing (it failed on ${head(w.root)})`;
    if (how === "after") throw new PowerCut();
    return result;
  };
  return { pnpm: fake.pnpm, runner, ran };
}

/** The commit this copy is whole at, or null: some file differs from its commit, git was cut off, or a step was not finished for that commit. */
function wholeAt(w: Copy): string | null {
  const at = head(w.root);
  const differ = git(w.root, "diff", "--name-only", "HEAD").split("\n").filter((name) => name !== "");
  if (differ.some((name) => !(w.edited && name === "notes.txt"))) return null;
  if (existsSync(path.join(w.root, ".git", "MERGE_HEAD")) || existsSync(path.join(w.root, ".git", "index.lock"))) return null;
  return STEPS.every((step) => w.built[step] === at) ? at : null;
}

/** The app's server starts and becomes ready, and main says so, as it does on every start. */
function serverStarts(w: Copy, token: string | undefined): void {
  const at = wholeAt(w);
  w.servers.push(head(w.root));
  if (at === null) w.halfStarts.push(`on ${head(w.root) === target ? "the new commit" : "the old commit"}, with ${STEPS.map((step) => `${step} done for ${w.built[step] === target ? "new" : w.built[step] === old ? "old" : w.built[step]}`).join(", ")}`);
  acknowledgeStartup(w.root, w.data, token);
}

/** The updater opens the version it built: that launch carries its token, looks as every start does, and starts its server. */
const launch = (w: Copy) => (spec: Relaunch) => {
  if (spec.startup === undefined) return undefined;
  const decided = decideCheckoutStart(checkoutStartFacts(w.root, { env: { [STARTUP_TOKEN_ENV]: spec.startup.token }, tried: false }));
  if (decided.kind === "start") serverStarts(w, spec.startup.token);
  return { pid: process.pid, stop: async () => true };
};

/**
 * One run of the updater: by hand (`pnpm run app-update`) or the finishing
 * run a start asks for. A run that is not killed goes through the real
 * command line. A killed one calls what the command line calls, so that
 * nothing of it runs after the power cut: a dead process writes no note.
 */
async function updater(w: Copy, how: "by-hand" | "finish", kill?: Kill): Promise<{ readonly killed: boolean; readonly ran: readonly Command[] }> {
  const { pnpm, runner, ran } = commands(w, kill);
  if (kill === undefined) {
    await runCli({
      root: w.root, argv: ["--data-dir", w.data, ...(how === "finish" ? ["--finish"] : [])], defaultDataDir: w.data,
      pnpm, runner, appRunning: () => null, relaunch: launch(w), print: () => undefined, platform: "linux", startupTimeoutMs: 300,
    });
    return { killed: false, ran };
  }
  try {
    await runUpdate({
      root: w.root, runner, choice: "auto", pnpm, appRunning: () => null, checkOnly: false, ...(how === "finish" ? { finishOnly: true } : {}),
      say: () => undefined, log: () => undefined,
      startApp: async (startup) => {
        const app = launch(w)({ cwd: w.root, args: [], startup });
        if (app === undefined) return { code: 1, stdout: "", stderr: "no app" };
        return waitForStartup({ root: w.root, dataDir: w.data, ...startup, app, timeoutMs: 300 });
      },
    });
  } catch (e) {
    if (e instanceof PowerCut) return { killed: true, ran };
    throw e;
  }
  return { killed: false, ran };
}

interface Start {
  readonly end: CheckoutStartEnd | "killed";
  readonly lines: readonly string[];
  /** The commands the finishing run made, when the start asked for one. */
  readonly ran: readonly Command[];
  /** Servers started by this start or by the run it asked for. */
  readonly servers: number;
}

/** The person starts the app: main's own start of a checkout, with the real look and the real finishing run. */
async function personStartsTheApp(w: Copy, kill?: Kill): Promise<Start> {
  const lines: string[] = [];
  const ran: Command[] = [];
  const before = w.servers.length;
  let cut = kill;
  const acts: CheckoutStartActs = {
    look: (tried) => decideCheckoutStart(checkoutStartFacts(w.root, { env: {}, tried })),
    claim: () => true,
    unclaim: () => undefined,
    start: () => serverStarts(w, undefined),
    pagesOnly: () => undefined,
    show: () => undefined,
    say: (said) => { lines.push(...said); },
    finish: async () => {
      const run = await updater(w, "finish", cut);
      cut = undefined;
      ran.push(...run.ran);
      // The power cut ends the start that was waiting, too.
      if (run.killed) throw new PowerCut();
      return { ok: true };
    },
    handOver: async () => ({ ok: false, message: "This start stays while the updater runs." }),
    again: () => undefined,
    sleep: async () => undefined,
  };
  try {
    let end = await startCheckout(acts, { tried: false, quitsToFinish: false });
    // A start that waited opens the app as a new process, which starts from the top.
    if (end === "started-again") end = await startCheckout(acts, { tried: false, quitsToFinish: false });
    return { end, lines, ran, servers: w.servers.length - before };
  } catch (e) {
    if (e instanceof PowerCut) return { end: "killed", lines, ran, servers: w.servers.length - before };
    throw e;
  }
}

function personEdits(w: Copy): void {
  writeFileSync(path.join(w.root, "notes.txt"), EDIT);
  w.edited = true;
}

function expectNoHalfStart(w: Copy): void {
  expect(w.halfStarts, "a server started on a copy that is not whole").toEqual([]);
}

function expectOwnFilesKept(w: Copy): void {
  expect(readFileSync(path.join(w.root, "mine.txt"), "utf8"), "the person's untracked file changed").toBe(MINE);
  expect(readFileSync(path.join(w.root, "ignored", "keep.txt"), "utf8"), "the person's ignored file changed").toBe(KEPT);
  if (w.edited) expect(readFileSync(path.join(w.root, "notes.txt"), "utf8"), "the person's edit to a tracked file was lost").toBe(EDIT);
}

/** What must hold after the last start of a scenario. `must`: how it has to end, when only one way is right. */
function expectSettled(w: Copy, last: Start, must?: "started" | "said"): void {
  expectNoHalfStart(w);
  expectOwnFilesKept(w);
  if (must !== undefined) expect(last.end).toBe(must);
  if (last.end === "started") {
    // Open on one whole version, with nothing of the update left saved.
    expect([old, target]).toContain(wholeAt(w));
    expect(readTransaction(w.root)).toBeNull();
    return;
  }
  // It said what is in the way, and started nothing.
  expect(last.end).toBe("said");
  expect(last.lines[0]).toBe(DID_NOT_START);
  expect(last.lines.length).toBeGreaterThan(1);
  expect(last.servers).toBe(0);
}

/** Every place the power can go in a run that makes these commands. */
const killsIn = (run: readonly Command[]): Kill[] => [
  { at: 0, how: "before" },
  { at: 0, how: "part-way" },
  ...run.map((_command, at): Kill => ({ at, how: "after" })),
];

const named = (run: readonly Command[], kill: Kill) =>
  kill.how === "part-way" ? "part way through the switch" : `${kill.how} ${run[kill.at] ?? "?"} (command ${kill.at + 1} of ${run.length})`;

describe.each([
  { title: "the new version installs", installFails: false, run: FORWARD },
  { title: "the new version's install fails", installFails: true, run: AND_BACK },
])("a checkout's update where $title", ({ installFails, run }) => {
  /** A fresh copy whose first update was killed at `kill`. */
  async function cutOff(kill: Kill): Promise<Copy> {
    const w = fresh(installFails);
    const first = await updater(w, "by-hand", kill);
    expect(first.killed).toBe(true);
    return w;
  }

  it("makes exactly these commands when nothing cuts it off", async () => {
    const w = fresh(installFails);
    expect((await updater(w, "by-hand")).ran).toEqual(run);
    expectSettled(w, await personStartsTheApp(w), "started");
    expect(wholeAt(w)).toBe(installFails ? old : target);
  });

  describe.each(killsIn(run).map((kill) => ({ kill, where: named(run, kill) })))("killed $where", ({ kill }) => {
    const partWay = kill.how === "part-way";

    it("then the person starts the app", async () => {
      const w = await cutOff(kill);
      const start = await personStartsTheApp(w);
      expectSettled(w, start, partWay ? "said" : "started");
      if (partWay) expect(start.lines.join("\n")).toMatch(/part way between two versions/);
      // A second start finds the same.
      expectSettled(w, await personStartsTheApp(w), partWay ? "said" : "started");
    });

    it("then the person runs the updater by hand, then starts the app", async () => {
      const w = await cutOff(kill);
      await updater(w, "by-hand");
      expectSettled(w, await personStartsTheApp(w), partWay ? "said" : "started");
    });

    it("then the person edits a tracked file and starts the app", async () => {
      const w = await cutOff(kill);
      personEdits(w);
      // Whether it finishes or says the edit is in the way depends on where it was cut off: never a half, never the edit lost.
      expectSettled(w, await personStartsTheApp(w));
    });

    it("then the power goes again at each command of the recovery, and the person starts the app once more", async () => {
      const recovery = (await personStartsTheApp(await cutOff(kill))).ran;
      for (let at = 0; at < recovery.length; at++) {
        const w = await cutOff(kill);
        const killed = await personStartsTheApp(w, { at, how: "after" });
        expect(killed.end, `the recovery was not killed at its command ${at + 1}`).toBe("killed");
        expectNoHalfStart(w);
        expectSettled(w, await personStartsTheApp(w), "started");
      }
    });
  });
});

describe("the guards these rules rest on", () => {
  rule("a start reads the saved update before it starts anything", { without: "checkout-start-skips-the-look", fails: /a server started on a copy that is not whole/ }, async () => {
    const w = fresh(false);
    expect((await updater(w, "by-hand", { at: 0, how: "after" })).killed).toBe(true);
    expectSettled(w, await personStartsTheApp(w), "started");
    expect(wholeAt(w)).toBe(target);
  });

  rule("the update is saved before the command that changes the copy", { without: "update-saved-after-the-change", fails: /nothing was saved about the update that was cut off/ }, async () => {
    const w = fresh(false);
    expect((await updater(w, "by-hand", { at: 0, how: "after" })).killed).toBe(true);
    expect(head(w.root)).toBe(target);
    expect(readTransaction(w.root), "nothing was saved about the update that was cut off").toMatchObject({ phase: "forward" });
    expectSettled(w, await personStartsTheApp(w), "started");
  });

  rule("a copy part way between two versions is never started, and nothing in it is changed", { without: "part-way-copy-not-refused", fails: /a server started on a copy that is not whole/ }, async () => {
    const w = fresh(false);
    expect((await updater(w, "by-hand", { at: 0, how: "part-way" })).killed).toBe(true);
    const start = await personStartsTheApp(w);
    expectSettled(w, start, "said");
    expect(start.lines.join("\n")).toMatch(/part way between two versions/);
    expect(readFileSync(path.join(w.root, "app.txt"), "utf8")).toBe(HALF);
    expect(readTransaction(w.root)).toMatchObject({ phase: "forward" });
  });

  rule("going back never writes over the person's edits", { without: "go-back-over-edits", fails: /the person's edit to a tracked file was lost/ }, async () => {
    const w = fresh(true);
    expect((await updater(w, "by-hand", { at: 0, how: "after" })).killed).toBe(true);
    personEdits(w);
    const start = await personStartsTheApp(w);
    expectOwnFilesKept(w);
    expectSettled(w, start, "said");
    expect(start.lines.join("\n")).toMatch(/your work is exactly as you left it/);
  });
});
