// The handoff of an approved update, one function per step, over the real
// modules: the server's update module and its admission, main's
// launchApprovedUpdate, and the program that makes the change (the checkout's
// updater, or an installed copy's watcher). A test calls the steps in the
// order it wants and asks, between any two, whether new work would be let in.
//
// One clock is shared, as os.uptime() is in the app. The server's waits run
// on fake timers. The step where the old app is gone ends them: the old
// server goes with the old app, and the updater that runs next starts real
// git, which needs real timers.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import { createUpdateAdmission, type UpdateAdmission } from "@gates-local/update/admission";
import { runCli } from "@gates-local/update/cli";
import { realRunner } from "@gates-local/update/run";
import { type Repos, fakePnpm } from "@gates-local/update/testing";
import type { UpdateAndRestartResult } from "../apps/desktop/src/bridge.ts";
import { holds } from "../apps/desktop/src/installed-update/linux.ts";
import { attempt, FROM, newLog, TO, type World } from "../apps/desktop/src/installed-update/watch-fixture.ts";
import { beginUpdate, runWatcher } from "../apps/desktop/src/installed-update/watch.ts";
import { APPROVAL_DEADLINE_ENV, approvedHandoffEnv, launchApprovedUpdate } from "../apps/desktop/src/update-launch.ts";
import { createInstalledUpdateModule } from "../apps/server/src/update/installed/module.ts";
import { createUpdateModule, type UpdateModule } from "../apps/server/src/update/module.ts";

/** The uptime, in seconds, at which the person clicks. */
const CLICKED_AT = 1_000;
const OLD_APP_PID = 4_242;
/** Longer than any wait the server has. */
const LONGEST_WAIT_MS = 120_000;

export type Copy =
  /** A source checkout with a newer commit published: `target` is that commit. */
  | { readonly kind: "checkout"; readonly repos: Repos; readonly target: string }
  /** An installed copy with a checked download of the next version. */
  | { readonly kind: "installed"; readonly world: World };

export interface Handoff {
  readonly admission: UpdateAdmission;
  /** Seconds since the person clicked. */
  seconds(): number;
  /** The window's click, after the server's checks: new work is reserved against. */
  personApproves(): void;
  /** Main asks the server to commit the reservation to it. Settles once the server has answered. */
  mainCommits(): Promise<void>;
  /** Main starts the program that makes the change, or fails to. Settles with what main tells the window. */
  mainStartsTheUpdater(started?: boolean): Promise<UpdateAndRestartResult>;
  /** Main's connection to its server ends while main itself stays open. */
  mainLetsGo(): void;
  timePasses(ms: number): Promise<void>;
  /** Time passes until the server stops waiting for the handoff. */
  graceRunsOut(): Promise<void>;
  /** The window asks, late, to call the update off with the key it was given. True when that reopened the app to work. */
  windowCancels(): boolean;
  /** A reply, an image job, a download or an import asks to start. True when it was let in. */
  workStarts(): boolean;
  /**
   * The old app is gone, and the program that makes the change looks.
   * `afterMs`: it finds the old app gone only that long into its wait. True
   * when it went ahead and changed the copy.
   */
  updaterSeesTheOldAppGone(o?: { readonly afterMs?: number }): Promise<boolean>;
  end(): Promise<void>;
}

const settled = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function serverFor(copy: Copy, admission: UpdateAdmission): UpdateModule {
  const base = copy.kind === "checkout" ? copy.repos.base : copy.world.root;
  const dataDir = path.join(base, "server-data");
  mkdirSync(dataDir, { recursive: true });
  if (copy.kind === "checkout") return createUpdateModule({ root: copy.repos.clone, dataDir, runner: realRunner, everyChange: () => false, admission });
  return createInstalledUpdateModule({
    version: FROM, platform: "linux", arch: "x64", program: null, dataDir, admission, keep: () => [],
    feed: { base: new URL("https://updates.invalid/releases"), page: "https://updates.invalid/releases/latest", keys: [], allowLoopbackHttp: false },
    automatic: { enabled: () => false, onChange: () => () => undefined },
  });
}

export function handoff(copy: Copy): Handoff {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const admission = createUpdateAdmission();
  const server = serverFor(copy, admission);
  const target = copy.kind === "checkout" ? copy.target : `${TO}:${"a".repeat(128)}`;
  const connection = new AbortController();
  let ms = 0;
  let serverRuns = true;
  let reservation = "";
  let askedAt: number | undefined;
  let begin: ((result: UpdateAndRestartResult) => void) | undefined;
  let launch: Promise<UpdateAndRestartResult> | undefined;
  const uptime = () => CLICKED_AT + ms / 1000;

  const timePasses = async (more: number) => {
    if (!serverRuns) throw new Error("the old server is gone: no step of its clock is left");
    await vi.advanceTimersByTimeAsync(more);
    ms += more;
  };

  const checkoutUpdater = async (repos: Repos, at: number, afterMs: number): Promise<boolean> => {
    const fake = fakePnpm();
    let looked = false;
    await runCli({
      root: repos.clone, argv: ["--data-dir", repos.data, "--wait-pid", String(OLD_APP_PID), "--restart", "--target-commit", target],
      defaultDataDir: repos.data, pnpm: fake.pnpm, runner: fake.runner, appRunning: () => null, relaunch: () => undefined, print: () => undefined, platform: "linux",
      // The deadline main gave it, and the clock both read.
      approvalBeforeUptime: Number(approvedHandoffEnv({}, at)[APPROVAL_DEADLINE_ENV]), uptime,
      // The updater has read the deadline once when it first asks whether the old app is there.
      alive: () => {
        if (!looked) ms += afterMs;
        looked = true;
        return false;
      },
    });
    return fake.commands.some((command) => command.startsWith("git merge"));
  };

  const installedWatcher = async (world: World): Promise<boolean> => {
    world.uptime = uptime();
    const log = newLog();
    await attempt(() => runWatcher(world.file, world.effects(log)));
    return holds(world.program, world.old, world.new) !== "old" || log.spawns.length > 0;
  };

  return {
    admission,
    seconds: () => ms / 1000,
    personApproves() { reservation = admission.reserve(target); },
    async mainCommits() {
      let answered: (() => void) | undefined;
      const answer = new Promise<void>((resolve) => { answered = resolve; });
      launch = launchApprovedUpdate({ reservation, target }, {
        commit: async (request) => { try { return server.commit(request, connection.signal); } finally { answered?.(); } },
        cancel: async (key) => server.cancel(key),
      }, (_approved, at) => {
        askedAt = at;
        return new Promise<UpdateAndRestartResult>((resolve) => { begin = resolve; });
      }, uptime);
      await answer;
      await settled();
    },
    async mainStartsTheUpdater(started = true) {
      if (launch === undefined) throw new Error("main has not committed");
      if (started && copy.kind === "installed" && askedAt !== undefined) {
        // Row H, in main: the approval is written with the clock main read before it asked the server.
        const world = copy.world;
        world.approval = { ...world.approval, uptime: askedAt };
        const fx = world.effects(newLog());
        beginUpdate(world.approval, { spawnWatcher: () => undefined, stopAt: fx.stopAt, fs: fx.fs, earlierFailure: false });
      }
      begin?.(started ? { ok: true } : { ok: false, message: "The updater could not be started." });
      const result = await launch;
      await settled();
      return result;
    },
    mainLetsGo() { connection.abort(); },
    timePasses,
    async graceRunsOut() {
      for (let waited = 0; admission.installing() && waited < LONGEST_WAIT_MS; waited += 100) await timePasses(100);
    },
    windowCancels: () => server.cancel(reservation).cancelled,
    workStarts() {
      try {
        admission.admit();
        return true;
      } catch {
        return false;
      }
    },
    async updaterSeesTheOldAppGone(o = {}) {
      if (askedAt === undefined) throw new Error("main has not started the updater");
      serverRuns = false;
      admission.close();
      vi.useRealTimers();
      if (copy.kind === "checkout") return checkoutUpdater(copy.repos, askedAt, o.afterMs ?? 0);
      ms += o.afterMs ?? 0;
      return installedWatcher(copy.world);
    },
    async end() {
      vi.useRealTimers();
      await server.close();
    },
  };
}
