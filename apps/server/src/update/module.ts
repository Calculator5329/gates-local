// Settings › General › Updates on the server: update.status, update.check
// and update.dismissResult.
//
// Status reads local files only. The desktop server's one automatic timer
// and manual update.check share a fetch and the checkout's install lock.
// Background failures stay silent. Installing is never done from here: the
// desktop app starts `pnpm run app-update` and quits (apps/desktop).
import type { UpdateCheck, UpdateCommitRequest, UpdateCommitResult, UpdatePreparation, UpdateResult, UpdateStatus, UpdateVersion } from "@gates-local/contracts";
import { randomUUID } from "node:crypto";
import type { HandlerContext, Handlers } from "../ws/server.ts";
import type { Blocked, Inspection } from "./check.ts";
import { inspect } from "./check.ts";
import { refusalLines, stoppedLine } from "./cli.ts";
import { STEP_WORDS } from "./apply.ts";
import { type UpdateRecord, takeRecord } from "./record.ts";
import type { Runner } from "./run.ts";
import { readVersion, type VersionInfo } from "./version.ts";
import { acquireLock } from "./lock.ts";
import { createUpdateAdmission, UPDATE_PAUSED, type UpdateAdmission } from "./admission.ts";

export interface UpdateModuleDeps {
  /** The clone the server runs from. */
  readonly root: string;
  readonly dataDir: string;
  readonly runner: Runner;
  /** Settings' "Get every change, not only releases". */
  readonly everyChange: () => boolean;
  /** Calls the listener when that switch flips; returns the unsubscribe. The last check answered for the other choice, so it is dropped. */
  readonly onEveryChange?: (listener: () => void) => () => void;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly version?: (root: string) => VersionInfo;
  readonly activity?: () => readonly string[];
  /** Work that must finish, rather than being interrupted by an install. */
  readonly uninterruptible?: () => readonly string[];
  readonly changed?: (status: UpdateStatus) => void;
  readonly admission?: UpdateAdmission;
}

export interface UpdateModule {
  status(): UpdateStatus;
  check(background?: boolean): Promise<UpdateCheck>;
  close(): Promise<void>;
  prepare(approval: string): Promise<UpdatePreparation>;
  commit(request: UpdateCommitRequest, disconnected?: AbortSignal): UpdateCommitResult;
  cancel(reservation: string): { cancelled: boolean };
  dismissResult(): { dismissed: boolean };
  /** An installed copy only (installed/module.ts): the Download click. */
  download?(): Promise<UpdateCheck>;
}

const changesWord = (n: number) => (n === 1 ? "1 change" : `${n} changes`);

/** The one line the app shows for the last run, from the record the updater left. */
export function resultLine(r: UpdateRecord): string {
  const to = r.to?.label ?? "the new version";
  const from = r.from?.label ?? "the version it was on";
  const repair = r.from !== undefined && r.to !== undefined && r.from.commit === r.to.commit;
  switch (r.outcome) {
    case "updated":
      if (repair) return `Repaired ${to}.`;
      return r.changes === undefined ? `Updated to ${to}.` : `Updated to ${to}, ${changesWord(r.changes)}.`;
    case "stopped":
      return r.step === undefined ? `${repair ? "The repair of" : "The update to"} ${to} stopped: ${r.reason ?? "no reason was given"}. Gates Local is still on ${from}.` : stoppedLine(to, r.step, r.reason ?? "no reason was given", from, repair);
    case "rollback-failed":
      return repair
        ? `Repairing ${to} stopped at ${r.step === undefined ? "a step" : STEP_WORDS[r.step]}: ${r.reason ?? "no reason was given"}. Retrying the repair did not finish either. Run the commands below in the Gates Local folder.`
        : `The update to ${to} stopped at ${r.step === undefined ? "a step" : STEP_WORDS[r.step]}: ${r.reason ?? "no reason was given"}, and going back to ${from} did not finish. Run the commands below in the Gates Local folder.`;
    case "refused":
      return `The update stopped: ${r.reason ?? "no reason was given"}`;
    case "rolled-back":
      // Written only by an installed copy's watcher, whose own words the installed module shows.
      return `The update to ${to} did not start, so Gates Local went back to ${from}.`;
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
    targetCommit: i.target.commit,
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
  let closed = false;
  const controller = new AbortController();
  const admission = deps.admission ?? createUpdateAdmission();
  let offer: { token: string; fingerprint: string } | undefined;
  const version = (): UpdateVersion => (deps.version ?? readVersion)(deps.root);
  const status = (): UpdateStatus => {
    // Main may acknowledge first startup after this server constructed its
    // modules. Pick up that success note before serving the new client.
    try { const ready = takeRecord(deps.dataDir); if (ready !== undefined) result = toResult(ready); }
    catch (error) { log(`could not read the startup result: ${(error as Error).message}`); }
    const activity = deps.activity?.() ?? [];
    const installing = admission.installing();
    if (!installing && lastCheck?.state === "available" && lastCheck.targetCommit !== undefined) {
      const fingerprint = JSON.stringify([lastCheck.targetCommit, lastCheck.target, lastCheck.notes, lastCheck.changes, admission.revision(), activity]);
      if (offer?.fingerprint !== fingerprint) offer = { token: randomUUID(), fingerprint };
    } else offer = undefined;
    return { version: version(), result, lastCheck, activity, installing, ...(offer ? { approval: offer.token } : {}) };
  };
  const offAdmission = admission.onChange(() => deps.changed?.(status()));
  // A flip of the switch makes the last check about the other choice: drop it and say so, and a check
  // already running for the old choice is run again for the new one (choice counts the flips).
  let choice = 0;
  const offEveryChange = deps.onEveryChange?.(() => {
    choice += 1;
    if (lastCheck === null) return;
    lastCheck = null;
    deps.changed?.(status());
  }) ?? (() => undefined);

  const runCheck = async (): Promise<UpdateCheck> => {
    const checkedAt = now();
    try {
      const acquired = acquireLock(deps.root);
      if (!acquired.ok) return { state: "cannot-check", checkedAt, reason: "error", lines: ["An update is already running. Wait for Gates Local to open again."] };
      try {
        return toCheck(await inspect({ root: deps.root, runner: deps.runner, choice: deps.everyChange() ? "main" : "auto", signal: controller.signal }), checkedAt);
      } finally {
        acquired.lock.release();
      }
    } catch (e) {
      if (closed) return { state: "cannot-check", checkedAt, reason: "error", lines: [UPDATE_PAUSED] };
      log(`update check failed: ${(e as Error).message}`);
      return { state: "cannot-check", checkedAt, reason: "error", lines: [`The check stopped on an error: ${(e as Error).message}`, "Try again, or run pnpm run app-update --check in the Gates Local folder to see more."] };
    }
  };

  const busy = () => deps.uninterruptible?.() ?? [];
  const waiting = () => ({ state: "blocked" as const, message: `Wait for ${busy().join(", ")} to finish before updating.` });
  const update: UpdateModule = {
    status,
    // Two clicks (or two windows) share one fetch.
    check: async (background = false) => {
      if (closed || admission.installing()) return { state: "cannot-check", checkedAt: now(), reason: "error", lines: [UPDATE_PAUSED] };
      const asked = choice;
      running ??= runCheck().finally(() => { running = undefined; });
      const c = await running;
      if (!closed && choice !== asked) return update.check(background);
      if (!closed && (!background || c.state !== "cannot-check")) {
        lastCheck = c;
        deps.changed?.(status());
      }
      return c;
    },
    close: async () => { closed = true; offAdmission(); offEveryChange(); controller.abort(); await running; },
    prepare: async (approval) => {
      if (closed || admission.installing()) return { state: "blocked", message: UPDATE_PAUSED };
      if (busy().length > 0) return waiting();
      if (status().approval !== approval) return { state: "changed", status: status() };
      // Re-fetch, then compare activity and reserve in this same synchronous
      // continuation. Every producer calls admission before registering work.
      await update.check();
      const latest = status();
      if (busy().length > 0) return waiting();
      if (latest.approval !== approval || latest.lastCheck?.state !== "available" || latest.lastCheck.targetCommit === undefined) return { state: "changed", status: latest };
      const target = latest.lastCheck.targetCommit;
      const reservation = admission.reserve(target);
      return { state: "ready", reservation, target };
    },
    commit: ({ reservation, target, release: requestedRelease }, disconnected) => {
      const release = admission.commit(reservation, target, requestedRelease, disconnected);
      return release === null ? { accepted: false } : { accepted: true, release };
    },
    cancel: (reservation) => ({ cancelled: admission.cancel(reservation) }),
    dismissResult: () => {
      const dismissed = result !== null;
      result = null;
      deps.changed?.(status());
      return { dismissed };
    },
  };
  return update;
}

export function createUpdateHandlers(update: UpdateModule) {
  return {
    "update.status": (_params?: object, context?: HandlerContext) => ({ ...update.status(), canControl: context?.listener !== "phone" }),
    "update.check": () => update.check(),
    "update.prepare": ({ approval }) => update.prepare(approval),
    "update.commit": (request, context) => update.commit(request, context.signal),
    "update.cancel": ({ reservation }) => update.cancel(reservation),
    "update.dismissResult": () => update.dismissResult(),
    "update.download": () => update.download?.() ?? Promise.resolve<UpdateCheck>({ state: "cannot-check", checkedAt: Date.now(), reason: "error", lines: ["This copy updates from its git clone, so there is nothing to download here."] }),
  } satisfies Partial<Handlers>;
}
