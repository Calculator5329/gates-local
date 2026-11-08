// Settings › General › Updates on the server: update.status, update.check
// and update.dismissResult.
//
// Nothing here runs on its own. The server takes the last update's result
// file when it starts (a local file), and status reads the version from the
// .git folder; neither starts a git process or touches the network. Only
// update.check runs git (fetch and ls-remote), and only when a client asks,
// which the web does on a click. Installing is never done from here: the
// desktop app starts `pnpm run app-update` and quits (apps/desktop).
import type { UpdateCheck, UpdateResult, UpdateStatus, UpdateVersion } from "@gates-local/contracts";
import type { Handlers } from "../ws/server.ts";
import type { Blocked, Inspection } from "./check.ts";
import { inspect } from "./check.ts";
import { refusalLines, stoppedLine } from "./cli.ts";
import { STEP_WORDS } from "./apply.ts";
import { type UpdateRecord, takeRecord } from "./record.ts";
import type { Runner } from "./run.ts";
import { readVersion, type VersionInfo } from "./version.ts";

export interface UpdateModuleDeps {
  /** The clone the server runs from. */
  readonly root: string;
  readonly dataDir: string;
  readonly runner: Runner;
  /** Settings' "Get every change, not only releases". */
  readonly everyChange: () => boolean;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly version?: (root: string) => VersionInfo;
}

export interface UpdateModule {
  status(): UpdateStatus;
  check(): Promise<UpdateCheck>;
  dismissResult(): { dismissed: boolean };
}

const changesWord = (n: number) => (n === 1 ? "1 change" : `${n} changes`);

/** The one line the app shows for the last run, from the record the updater left. */
export function resultLine(r: UpdateRecord): string {
  const to = r.to?.label ?? "the new version";
  const from = r.from?.label ?? "the version it was on";
  switch (r.outcome) {
    case "updated":
      return r.changes === undefined ? `Updated to ${to}.` : `Updated to ${to}, ${changesWord(r.changes)}.`;
    case "stopped":
      return r.step === undefined ? `The update to ${to} stopped: ${r.reason ?? "no reason was given"}. Gates Local is still on ${from}.` : stoppedLine(to, r.step, r.reason ?? "no reason was given", from);
    case "rollback-failed":
      return `The update to ${to} stopped at ${r.step === undefined ? "a step" : STEP_WORDS[r.step]}: ${r.reason ?? "no reason was given"}, and going back to ${from} did not finish. Run the commands below in the Gates Local folder.`;
    case "refused":
      return `The update did not start: ${r.reason ?? "no reason was given"}`;
  }
}

function toResult(r: UpdateRecord): UpdateResult {
  return {
    at: r.at,
    outcome: r.outcome,
    line: resultLine(r),
    ...(r.logPath === undefined ? {} : { logPath: r.logPath }),
    ...(r.commands === undefined ? {} : { commands: r.commands }),
  };
}

/** The words Settings shows when a check cannot answer; the remedies name the app's own controls. */
export function blockedLines(b: Blocked): string[] {
  switch (b.reason) {
    case "diverged":
      return [`The newest release (${b.target}) is not on this copy's branch, so updating to it would go backwards.`, 'Turn on "Get every change, not only releases" to follow the main branch instead.'];
    case "no-releases":
      return ['There are no releases yet. Turn on "Get every change, not only releases" to get the newest changes.'];
    default:
      return refusalLines(b);
  }
}

function toCheck(i: Inspection, checkedAt: number): UpdateCheck {
  if (i.state === "blocked") return { state: "cannot-check", checkedAt, reason: i.blocked.reason, lines: blockedLines(i.blocked) };
  if (i.state === "up-to-date") return { state: "up-to-date", checkedAt, channel: i.channel, current: i.head.label };
  return {
    state: "available",
    checkedAt,
    channel: i.channel,
    current: i.head.label,
    target: i.target.label,
    total: i.total,
    changes: i.changes,
    ...(i.notes === undefined ? {} : { notes: i.notes }),
  };
}

export function createUpdateModule(deps: UpdateModuleDeps): UpdateModule {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  // Taken once: shown for this launch, gone from disk.
  let record: UpdateRecord | undefined;
  try {
    record = takeRecord(deps.dataDir);
  } catch (e) {
    log(`could not read the last update result: ${(e as Error).message}`);
  }
  let result: UpdateResult | null = record === undefined ? null : toResult(record);
  let lastCheck: UpdateCheck | null = null;
  let running: Promise<UpdateCheck> | undefined;
  const version = (): UpdateVersion => (deps.version ?? readVersion)(deps.root);

  const runCheck = async (): Promise<UpdateCheck> => {
    const checkedAt = now();
    try {
      return toCheck(await inspect({ root: deps.root, runner: deps.runner, choice: deps.everyChange() ? "main" : "auto" }), checkedAt);
    } catch (e) {
      log(`update check failed: ${(e as Error).message}`);
      return { state: "cannot-check", checkedAt, reason: "error", lines: [`The check stopped on an error: ${(e as Error).message}`, "Try again, or run pnpm run app-update --check in the Gates Local folder to see more."] };
    }
  };

  return {
    status: () => ({ version: version(), result, lastCheck }),
    // Two clicks (or two windows) share one fetch.
    check: () => {
      running ??= runCheck().then((c) => {
        lastCheck = c;
        running = undefined;
        return c;
      });
      return running;
    },
    dismissResult: () => {
      const dismissed = result !== null;
      result = null;
      return { dismissed };
    },
  };
}

export function createUpdateHandlers(update: UpdateModule) {
  return {
    "update.status": () => update.status(),
    "update.check": () => update.check(),
    "update.dismissResult": () => update.dismissResult(),
  } satisfies Partial<Handlers>;
}
