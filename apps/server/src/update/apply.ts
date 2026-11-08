// The update itself: preconditions, the target (check.ts), then fast-forward,
// pnpm install and the two builds `pnpm start` runs. A failed install or
// build goes back to the old commit and installs and builds that again, so
// the person keeps a working app; only when going back fails too does the
// result carry the exact commands to run.
//
// Nothing here merges, rebases or resets over someone's work: a copy with
// tracked changes or commits of its own is refused before anything changes,
// and the one reset (going back) is `git reset --keep` on a tree this run
// found clean.
import { type Blocked, type Channel, type ChannelChoice, type Commit, type Inspection, gitIn, inspect } from "./check.ts";
import { lastLines, type RunResult, type Runner } from "./run.ts";

export type Step = "switch" | "install" | "build-web" | "build-desktop";

export const STEP_WORDS: Record<Step, string> = {
  switch: "switching to the new version",
  install: "installing packages",
  "build-web": "building the app window",
  "build-desktop": "building the desktop app",
};

const INSTALL_MS = 20 * 60_000;
const BUILD_MS = 10 * 60_000;

/** How to run pnpm: a command plus arguments that come before pnpm's own (node <pnpm.cjs>). */
export interface Pnpm {
  readonly command: string;
  readonly prefix: readonly string[];
  /** pnpm.cmd on Windows only runs through the shell. */
  readonly shell: boolean;
}

/** The pnpm commands of one update, in order. A non-TTY install must not stop to ask about node_modules. */
export const INSTALL_ARGS = ["install", "--frozen-lockfile", "--config.confirmModulesPurge=false"] as const;
export const BUILD_WEB_ARGS = ["--filter", "@gates-local/web", "build"] as const;
export const BUILD_DESKTOP_ARGS = ["--filter", "@gates-local/desktop", "build"] as const;

export type Refusal = Blocked | { readonly reason: "app-running"; readonly pid: number; readonly file: string } | { readonly reason: "no-pnpm" };

export type UpdateRun =
  | { readonly outcome: "refused"; readonly refusal: Refusal }
  | { readonly outcome: "up-to-date"; readonly inspection: Extract<Inspection, { state: "up-to-date" }> }
  | { readonly outcome: "available"; readonly inspection: Extract<Inspection, { state: "available" }> }
  | { readonly outcome: "updated"; readonly channel: Channel; readonly from: Commit; readonly to: Commit; readonly changes: number }
  | {
      readonly outcome: "stopped" | "rollback-failed";
      readonly channel: Channel;
      readonly from: Commit;
      readonly to: Commit;
      readonly step: Step;
      readonly reason: string;
      /** rollback-failed: what to run by hand, one command a line, from the clone. */
      readonly commands?: readonly string[];
    };

export interface UpdateOptions {
  readonly root: string;
  readonly runner: Runner;
  readonly choice: ChannelChoice;
  readonly pnpm: Pnpm;
  /** The running app, from its pid file; null when it is not running. */
  readonly appRunning: () => { readonly pid: number; readonly file: string } | null;
  /** Report only: change nothing. */
  readonly checkOnly: boolean;
  /** Plain-language progress, one line each. */
  readonly say: (line: string) => void;
  /** Every command and its output, for the log file. */
  readonly log: (chunk: string) => void;
}

const ok = (r: RunResult) => r.code === 0;

function reasonOf(r: RunResult, what: string): string {
  if (r.failure === "not-found") return `${what} was not found`;
  if (r.failure === "timeout") return `${what} took too long and was stopped`;
  return lastLines(r) || `${what} exited with code ${String(r.code)}`;
}

export function pnpmLine(args: readonly string[]): string {
  return `pnpm ${args.join(" ")}`;
}

const refused = (refusal: Refusal): UpdateRun => ({ outcome: "refused", refusal });

export async function runUpdate(o: UpdateOptions): Promise<UpdateRun> {
  const git = gitIn(o.root, o.runner, o.log);
  const pnpm = (args: readonly string[], timeoutMs: number) => {
    o.log(`$ ${pnpmLine(args)}\n`);
    return o.runner(o.pnpm.command, [...o.pnpm.prefix, ...args], { cwd: o.root, shell: o.pnpm.shell, timeoutMs, onOutput: o.log });
  };

  if (!o.checkOnly) {
    // On Windows a running app holds electron.exe and the install would stop half way.
    const running = o.appRunning();
    if (running !== null) return refused({ reason: "app-running", ...running });
    if (!ok(await pnpm(["--version"], 60_000))) return refused({ reason: "no-pnpm" });
  }

  o.say("Checking for updates…");
  const found = await inspect({ root: o.root, runner: o.runner, choice: o.choice, log: o.log });
  if (found.state === "blocked") return refused(found.blocked);
  if (found.state === "up-to-date") return { outcome: "up-to-date", inspection: found };
  if (o.checkOnly) return { outcome: "available", inspection: found };

  const { channel, head: from, target: to, total } = found;
  // Recorded before anything moves: every way back starts here.
  const switched = await git(["merge", "--ff-only", "--quiet", to.commit]);
  if (!ok(switched)) {
    const now = await git(["rev-parse", "HEAD"]);
    // merge --ff-only changes nothing when it fails; if HEAD moved anyway, go back like any other failure.
    if (ok(now) && now.stdout.trim() === from.commit) {
      return { outcome: "stopped", channel, from, to, step: "switch", reason: reasonOf(switched, "git merge") };
    }
    return goBack(o, git, pnpm, { channel, from, to, step: "switch", reason: reasonOf(switched, "git merge") });
  }
  o.say(`Switched to ${to.label}.`);

  const steps: Array<[Step, readonly string[], number]> = [
    ["install", INSTALL_ARGS, INSTALL_MS],
    ["build-web", BUILD_WEB_ARGS, BUILD_MS],
    ["build-desktop", BUILD_DESKTOP_ARGS, BUILD_MS],
  ];
  for (const [step, args, ms] of steps) {
    o.say(`${capital(STEP_WORDS[step])}…${step === "install" ? " (this can take a few minutes)" : ""}`);
    const r = await pnpm(args, ms);
    if (!ok(r)) return goBack(o, git, pnpm, { channel, from, to, step, reason: reasonOf(r, "pnpm") });
  }
  return { outcome: "updated", channel, from, to, changes: total };
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

interface Failed {
  readonly channel: Channel;
  readonly from: Commit;
  readonly to: Commit;
  readonly step: Step;
  readonly reason: string;
}

async function goBack(
  o: UpdateOptions,
  git: ReturnType<typeof gitIn>,
  pnpm: (args: readonly string[], ms: number) => Promise<RunResult>,
  f: Failed,
): Promise<UpdateRun> {
  o.say(`The update to ${f.to.label} stopped at ${STEP_WORDS[f.step]}. Going back to ${f.from.label}…`);
  const commands = [
    `git reset --keep ${f.from.commit}`,
    pnpmLine(INSTALL_ARGS),
    pnpmLine(BUILD_WEB_ARGS),
    pnpmLine(BUILD_DESKTOP_ARGS),
  ];
  const failedBack = (): UpdateRun => ({ outcome: "rollback-failed", ...f, commands });
  // --keep is safe: the tree was clean when this run started, and it refuses to drop a change.
  if (!ok(await git(["reset", "--keep", f.from.commit]))) return failedBack();
  if (!ok(await pnpm(INSTALL_ARGS, INSTALL_MS))) return failedBack();
  if (!ok(await pnpm(BUILD_WEB_ARGS, BUILD_MS))) return failedBack();
  if (!ok(await pnpm(BUILD_DESKTOP_ARGS, BUILD_MS))) return failedBack();
  return { outcome: "stopped", ...f };
}
