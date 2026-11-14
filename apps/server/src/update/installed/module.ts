// Settings › General › Updates for an installed copy (AppImage or installer).
//
// The desktop app passes the packaged version in GATES_LOCAL_INSTALLED_VERSION;
// with it set, main.ts composes this module in place of the clone updater, so
// no git process ever starts for updates. Status is the version and the last
// check. A check reads the signed release list (check.ts) and says in plain
// words whether a newer version exists. When the list holds a file for this
// copy, it is downloaded into <data dir>/updates/<version>/ and checked
// (download.ts): by itself while the automatic switch is on (owner decision
// D1), on the Download click (update.download) while it is off.
//
// A Linux AppImage that can replace its own file (the desktop app says so in
// GATES_LOCAL_INSTALLED_RESTART) offers "Restart to update" once the download
// is checked: the status carries an approval pinned to the version and the
// SHA-512 of the signed list, and the click reserves and commits admission
// with that identity as its target (docs/design/installed-updates.md, 1).
// The desktop app does the rest (apps/desktop/src/installed-update/). A
// Windows install offers the same button (section 3, W-A): the desktop runs
// the checked installer silently, and the row says how to go back, naming
// the running version's kept installer, which no cleanup deletes. Any other
// copy says why it cannot and sends the person to the release page.
//
// Results: the watcher leaves one in update-result.json. A token launch
// (GATES_LOCAL_UPDATE_STARTUP_TOKEN) keeps admission closed until it reads a
// result carrying its token and never removes the file; an ordinary start
// takes the file, except a rollback-failed note, which stays until dismissed.
// The automatic timer (automatic.ts) and the updateAutomatic switch are shared
// with the clone updater unchanged; its hourly check is also the download's
// retry. Settings reads the switch itself for the bracketed sentences.
import type { UpdateCheck, UpdateCommitRequest, UpdateDownload, UpdatePreparation, UpdateResult, UpdateStatus } from "@gates-local/contracts";
import { randomUUID } from "node:crypto";
import { cannotReplace, type CannotReplace, earlierFailure, pinnedDataFolder, readyWindows } from "../../../../desktop/src/installed-update/words.ts";
import { createUpdateAdmission, FINISHING, UPDATE_PAUSED, type UpdateAdmission } from "../admission.ts";
import { REPO_URL } from "../cli.ts";
import type { UpdateModule } from "../module.ts";
import { readRecord, removeRecord, takeRecord, type UpdateRecord, writeRecord } from "../record.ts";
import { parseReleaseKey, type ReleaseArtifact, TRUSTED_RELEASE_KEYS } from "../release-manifest.ts";
import { checkInstalled, type InstalledOutcome } from "./check.ts";
import { type DownloadOutcome, downloadRelease, listHash, preparedRelease, removeVersions, type Space, verifyKept } from "./download.ts";
import { boundedGet, type Get, refusedAddress, type Stream, streamGet } from "./feed.ts";
import type { ModelLists } from "./models-list.ts";

export const INSTALLED_VERSION_ENV = "GATES_LOCAL_INSTALLED_VERSION";
export const FEED_ENV = "GATES_LOCAL_UPDATE_FEED";
export const TEST_KEYS_ENV = "GATES_LOCAL_UPDATE_TEST_KEYS";

/** B: the public repository's release pages, from the same address the clone updater uses. */
export const DEFAULT_FEED = new URL(`${REPO_URL.replace(/\.git$/, "")}/releases`);

export interface InstalledFeed {
  readonly base: URL;
  /** The page the words send a person to: B/latest. */
  readonly page: string;
  readonly keys: readonly string[];
  readonly allowLoopbackHttp: boolean;
}

/**
 * Where an installed copy checks and which keys it trusts. testBuild is true
 * only when the packaged copy holds resources/test-build.json: then, and only
 * then, GATES_LOCAL_UPDATE_TEST_KEYS is read and a loopback http feed is
 * accepted. GATES_LOCAL_UPDATE_FEED may name another https base in any copy.
 */
export function installedFeed(env: NodeJS.ProcessEnv, o: { readonly testBuild: boolean; readonly trusted?: readonly string[]; readonly log?: (line: string) => void }): InstalledFeed {
  const log = o.log ?? (() => undefined);
  let base = DEFAULT_FEED;
  const override = env[FEED_ENV] ?? "";
  if (override !== "") {
    let url: URL | undefined;
    try { url = new URL(override); } catch { log(`${FEED_ENV} is not an address; using the release page`); }
    if (url !== undefined) {
      const refused = url.search !== "" || url.hash !== "" ? "an address with a query or fragment" : refusedAddress(url, o.testBuild);
      if (refused === null) base = url;
      else log(`${FEED_ENV} names ${refused}; using the release page`);
    }
  }
  const keys = [...(o.trusted ?? TRUSTED_RELEASE_KEYS)];
  if (o.testBuild) {
    for (const key of (env[TEST_KEYS_ENV] ?? "").split(",").map((k) => k.trim()).filter((k) => k !== "")) {
      try { parseReleaseKey(key); keys.push(key); }
      catch { log(`${TEST_KEYS_ENV} holds an entry that is not a release key; it is ignored`); }
    }
  }
  return { base, page: `${base.href.replace(/\/+$/, "")}/latest`, keys, allowLoopbackHttp: o.testBuild };
}

/** The installed module when the desktop app said this is an installed copy, else the clone updater. */
export function chooseUpdateModule(env: NodeJS.ProcessEnv, build: { readonly installed: (version: string) => UpdateModule; readonly clone: () => UpdateModule }): UpdateModule {
  const version = env[INSTALLED_VERSION_ENV] ?? "";
  return version === "" ? build.clone() : build.installed(version);
}

export const INSTALL_REFUSAL = "This installed copy of Gates Local cannot update itself yet. Download the new version from the release page.";

export const RESTART_ENV = "GATES_LOCAL_INSTALLED_RESTART";
/**
 * Whether this copy can replace its own file, as the desktop app found it at
 * startup (section 2, "Who may update"): yes, one of the refusal cases,
 * windows for an install made by the Windows installer (section 3, W-A: the
 * checked installer runs silently), or none, for a copy with no installer
 * step, which keeps the old words.
 */
export type Restart = "yes" | "windows" | "none" | "pinned" | CannotReplace;
const RESTARTS: readonly Restart[] = ["yes", "windows", "none", "pinned", "read-only", "no-permission", "not-appimage"];
export const parseRestart = (value: string | undefined): Restart => RESTARTS.find((r) => r === value) ?? "none";
/** Restart to update is offered: an AppImage that can replace its file, or a Windows install. */
export const canRestart = (restart: Restart): restart is "yes" | "windows" => restart === "yes" || restart === "windows";

/** Where a Windows copy goes back to (section 3, W-A step 2): its own version's kept installer, else that version's release page. */
export type GoBack = { readonly installer: string } | { readonly current: string; readonly releasePage: string };

/** The admission target of an installed copy: the version and the SHA-512 of the exact signed list bytes. */
export const installedTarget = (version: string, listDigest: string) => `${version}:${listDigest}`;

const blocked = (message: string) => ({ state: "blocked" as const, message });

/** Why the click is refused, for a copy that cannot replace its file. */
function refusal(restart: Exclude<Restart, "yes" | "windows">, target: string): string {
  if (restart === "none") return INSTALL_REFUSAL;
  return restart === "pinned" ? pinnedDataFolder(target).text : cannotReplace(restart, target).text;
}

/** The words Settings shows for each outcome; page is where they send the person.
 *  "Gates Local will try again in an hour." is not here: Settings adds it to
 *  unreachable and no-list from the live switch, so it stays true after a toggle. */
export function installedCheck(outcome: InstalledOutcome, o: { readonly version: string; readonly page: string; readonly checkedAt: number }): UpdateCheck {
  const { checkedAt, page } = o;
  switch (outcome.kind) {
    case "development":
      return { state: "cannot-check", checkedAt, reason: "development", lines: ["This is a development build, so it does not check for updates."] };
    case "no-key":
      return { state: "cannot-check", checkedAt, reason: "no-key", lines: ["This build has no release key, so it cannot check for updates. Download the latest version from the release page."], page };
    case "unreachable":
      return { state: "cannot-check", checkedAt, reason: "unreachable", lines: ["Could not reach the update server. Check your connection."] };
    case "no-list":
      return { state: "cannot-check", checkedAt, reason: "no-list", lines: ["No release list was found on the release page."] };
    case "bad-signature":
      return { state: "cannot-check", checkedAt, reason: "bad-signature", lines: ["The release list did not pass its signature check, so Gates Local ignored it. Nothing was downloaded. If this keeps happening, download the latest version from the release page."], page };
    case "none-found":
      return { state: "up-to-date", checkedAt, channel: "release", current: o.version };
    case "newer": {
      const forThisCopy = "artifact" in outcome;
      // For this copy, the download's own words replace this line (downloadLines).
      const line = forThisCopy
        ? `Version ${outcome.target} is available.`
        : `Version ${outcome.target} is available, but this copy cannot install it by itself. Download it from the release page.`;
      return { state: "newer", checkedAt, current: o.version, target: outcome.target, forThisCopy, lines: [line], page };
    }
  }
}

/** Where the download of version target stands, with what its words need. */
export type Fetch =
  | { readonly state: "downloading"; readonly received: number; readonly total: number }
  | { readonly state: "disk"; readonly volume: string; readonly needed: number; readonly free: number }
  | { readonly state: Exclude<UpdateDownload, "downloading" | "disk"> };

const MB = 1_000_000;
/** Megabytes for the words: one decimal under 10 MB, whole above. */
function mb(bytes: number, round: (n: number) => number = Math.round): string {
  const value = bytes / MB;
  return value < 10 ? (round(value * 10) / 10).toFixed(1) : String(round(value));
}

/** The download's words, in place of "Version <new> is available.". Settings adds the bracketed sentence while the switch is on.
 *  Ready: a copy that can restart into it says so beside its Restart button (a Windows copy also says how to go back); any other says why not. */
export function downloadLines(target: string, fetch: Fetch, restart: Restart = "none", goBack?: GoBack): string[] {
  switch (fetch.state) {
    case "downloading":
      return [`Downloading version ${target} (${mb(fetch.received, Math.floor)} of ${mb(fetch.total)} MB). You can keep chatting.`];
    case "bad":
      return [`The download of version ${target} did not match the signed release list, so it was deleted.`];
    case "failed":
      return [`Could not download version ${target}. Check your connection.`];
    case "disk":
      // Needed rounds up and free rounds down, so the two never read equal when the space is short.
      return [`Not enough free space on ${fetch.volume} for version ${target} (needs ${mb(fetch.needed, Math.ceil)} MB, ${mb(fetch.free, Math.floor)} MB free). Free some space, then use Check for updates.`];
    case "ready":
      if (restart === "yes") return [`Version ${target} is downloaded and checked.`];
      if (restart === "windows") {
        const detail = goBack === undefined ? undefined : readyWindows(target, goBack).detail;
        return [`Version ${target} is downloaded and checked.`, ...(detail === undefined ? [] : [detail])];
      }
      if (restart !== "none") return [refusal(restart, target)];
      return [`Version ${target} is downloaded and checked. This copy cannot install it by itself yet. To update now, download it from the release page.`];
  }
}

function fetchOf(outcome: Exclude<DownloadOutcome, { readonly kind: "cancelled" }>): Fetch {
  switch (outcome.kind) {
    case "ready": return { state: "ready" };
    case "bad-download": return { state: "bad" };
    case "could-not-download": return { state: "failed" };
    case "disk": return { state: "disk", volume: outcome.volume, needed: outcome.needed, free: outcome.free };
  }
}

export interface InstalledModuleDeps {
  /** app.getVersion() of the packaged copy. */
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  readonly feed: InstalledFeed;
  /** The server's --data-dir; downloads go in its updates/ folder. */
  readonly dataDir: string;
  /** Settings' "Check for updates automatically": on, a newer version downloads by itself; turned off, downloads stop and are deleted. */
  readonly automatic: { readonly enabled: () => boolean; readonly onChange: (listener: () => void) => () => void };
  /**
   * Versions whose folders cleanup and the switch never delete: main.ts
   * returns the one an unfinished update names. The module adds the one an
   * undismissed rollback-failed note names, and the one being installed.
   */
  readonly keep: () => readonly string[];
  /** Whether this copy can replace its own file; default none. */
  readonly restart?: Restart;
  /** Shared with every producer of work, as for the clone updater. */
  readonly admission?: UpdateAdmission;
  readonly activity?: () => readonly string[];
  /** Work that must finish, rather than being interrupted by an install. */
  readonly uninterruptible?: () => readonly string[];
  /** A token launch: the result carrying this token opens admission. */
  readonly startupToken?: string;
  /** How often a token launch looks for its result; default 200 ms. */
  readonly resultPollMs?: number;
  /** Tests pass a fake; the real one is boundedGet. */
  readonly get?: Get;
  /**
   * The chat model list from the release page (models-list.ts): the kept one
   * is read when the module starts, a newer one after each check whose
   * release.json verified. Absent, the copy uses its built-in list only.
   */
  readonly models?: ModelLists;
  /** The artifact's read; the real one is streamGet with the feed's rules. */
  readonly stream?: Stream;
  /** Tests pretend a full disk. */
  readonly freeSpace?: (folder: string) => Promise<Space>;
  /** Least time between two progress pushes; default a second. */
  readonly progressMs?: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly changed?: (status: UpdateStatus) => void;
}

/** A verified newer version with a file for this copy: what a download needs. */
interface Found {
  readonly target: string;
  readonly artifact: ReleaseArtifact;
  readonly list: Buffer;
  readonly signature: Buffer;
}

export function createInstalledUpdateModule(deps: InstalledModuleDeps): UpdateModule {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const get = deps.get ?? boundedGet({ allowLoopbackHttp: deps.feed.allowLoopbackHttp });
  const stream = deps.stream ?? streamGet({ allowLoopbackHttp: deps.feed.allowLoopbackHttp });
  const progressMs = deps.progressMs ?? 1_000;
  const identity = { dataDir: deps.dataDir, running: deps.version, keys: deps.feed.keys, platform: deps.platform, arch: deps.arch };
  const controller = new AbortController();
  let lastCheck: UpdateCheck | null = null;
  let running: Promise<UpdateCheck> | undefined;
  let closed = false;
  let found: Found | undefined;
  let fetch: { readonly target: string; readonly fetch: Fetch } | undefined;
  // list: the SHA-512 of the signed list this download is for.
  let active: { readonly target: string; readonly list: string; readonly controller: AbortController; readonly done: Promise<void> } | undefined;
  // SHA-512 of the signed list whose last finished download did not match. A
  // background check does not fetch that list again; a click or a check that
  // verifies any other list (or none) forgets it. Kept in memory only: a
  // restart forgets it, which costs one more try.
  let refused: string | undefined;
  // Checks, clicks and the switch change the folder one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work);
    queue = next.catch(() => undefined);
    return next;
  };

  // The kept chat model list, checked again before use: it survives a restart with no network.
  try { deps.models?.loadStored(); }
  catch (error) { log(`chat model list: ${error instanceof Error ? error.message : String(error)}`); }

  const restart = deps.restart ?? "none";
  // Windows: set once the running version's kept installer has been looked for.
  let goBack: GoBack | undefined;
  const admission =deps.admission ?? createUpdateAdmission({ finishing: deps.startupToken !== undefined });

  // The last run's note. failed: an undismissed rollback-failed note, which
  // stays on disk, keeps the folders it names and refuses a new update.
  const toResult = (r: UpdateRecord): UpdateResult | null => {
    const own = r.installed;
    if (own === undefined) return null;
    return { at: r.at, outcome: r.outcome, line: own.detail === undefined ? own.text : `${own.text} ${own.detail}`, ...(own.link === true ? { page: deps.feed.page } : {}) };
  };
  let result: UpdateResult | null = null;
  let failed: UpdateRecord | undefined;
  let looking: ReturnType<typeof setInterval> | undefined;
  const lookForOwn = (token: string) => {
    let r: UpdateRecord | undefined;
    try { r = readRecord(deps.dataDir); } catch (error) { log(`could not read the update result: ${(error as Error).message}`); }
    if (r?.installed?.token !== token) return;
    clearInterval(looking);
    looking = undefined;
    result = toResult(r);
    if (r.outcome === "rollback-failed") failed = r;
    // This launch says it; the next ordinary start does not say it again.
    else if (r.installed.shown !== true) {
      try { writeRecord(deps.dataDir, { ...r, installed: { ...r.installed, shown: true } }); } catch (error) { log(`could not mark the update result shown: ${(error as Error).message}`); }
    }
    // Opening notifies, which pushes the status with the result.
    admission.open();
  };
  try {
    if (deps.startupToken === undefined) {
      const left = readRecord(deps.dataDir);
      if (left?.outcome === "rollback-failed" && left.installed !== undefined) { failed = left; result = toResult(left); }
      else {
        const taken = takeRecord(deps.dataDir);
        // "Updated to version N+1" taken by N: N+1 never reached its server and N was put back (Windows, IU-W2).
        const otherVersion = taken?.outcome === "updated" && taken.installed !== undefined && taken.installed.to !== deps.version;
        if (otherVersion) log(`dropped the result "updated to ${taken.installed?.to ?? ""}": version ${deps.version} runs`);
        else if (taken !== undefined && taken.installed?.shown !== true) result = toResult(taken);
      }
    }
  } catch (error) {
    log(`could not read the last update result: ${(error as Error).message}`);
  }

  /** The last check, with the download's words in place of "is available." for this copy. */
  const shown = (c: UpdateCheck | null): UpdateCheck | null => {
    if (c?.state !== "newer" || !c.forThisCopy || fetch?.target !== c.target) return c;
    const checked = fetch.fetch.state === "ready" && canRestart(restart);
    // An undismissed rollback-failed note refuses the update: no button, and the row says why.
    // Windows: the button turns on once the kept installer has been looked for (section 3, W-A step 2).
    const ready = checked && failed === undefined && (restart !== "windows" || goBack !== undefined);
    const lines = checked && failed !== undefined ? [earlierFailure().text] : downloadLines(c.target, fetch.fetch, restart, goBack);
    return { ...c, lines, download: fetch.fetch.state, ...(ready ? { restart: true } : {}) };
  };
  let offer: { readonly token: string; readonly fingerprint: string } | undefined;
  /** The admission target of the found version, when it is the checked, ready one Restart would install. */
  const readyTarget = (c: UpdateCheck | null): string | undefined => {
    if (!canRestart(restart) || found === undefined || failed !== undefined || c?.state !== "newer" || c.target !== found.target || c.download !== "ready" || c.restart !== true) return undefined;
    return installedTarget(found.target, listHash(found.list));
  };
  const status = (): UpdateStatus => {
    const activity = deps.activity?.() ?? [];
    const installing = admission.installing();
    const c = shown(lastCheck);
    const target = installing || admission.finishing() ? undefined : readyTarget(c);
    if (target === undefined) offer = undefined;
    else {
      const fingerprint = JSON.stringify([target, admission.revision(), activity]);
      if (offer?.fingerprint !== fingerprint) offer = { token: randomUUID(), fingerprint };
    }
    return { version: { kind: "installed", version: deps.version }, result, lastCheck: c, activity, installing, ...(offer ? { approval: offer.token } : {}) };
  };
  const push = () => { if (!closed) deps.changed?.(status()); };
  const offAdmission = admission.onChange(push);
  if (restart === "windows") {
    // Looked for once: cleanup never deletes it while this version runs.
    const releasePage = `${deps.feed.base.href.replace(/\/+$/, "")}/tag/v${deps.version}`;
    void verifyKept({ ...identity, version: deps.version })
      .catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }))
      .then((kept) => {
        if (!kept.ok) log(`no kept installer for ${deps.version}: ${kept.reason}`);
        goBack = kept.ok ? { installer: kept.prepared.file } : { current: deps.version, releasePage };
        push();
      });
  }
  /** Folders no cleanup deletes: the caller's, an undismissed failure's, the one being installed, and on Windows the running version's installer. */
  const kept = (): string[] => [
    ...deps.keep(),
    ...(restart === "windows" ? [deps.version] : []),
    ...(failed?.installed === undefined ? [] : [failed.installed.to]),
    ...(admission.installing() && found !== undefined ? [found.target] : []),
  ];
  if (deps.startupToken !== undefined) {
    const token = deps.startupToken;
    looking = setInterval(() => lookForOwn(token), deps.resultPollMs ?? 200);
    looking.unref?.();
    lookForOwn(token);
  }
  const closingCheck = (): UpdateCheck => ({ state: "cannot-check", checkedAt: now(), reason: "error", lines: ["Gates Local is closing, so it did not check for updates."] });

  const cancelActive = async (why: string) => {
    const current = active;
    if (current === undefined) return;
    current.controller.abort(new Error(why));
    await current.done;
  };

  const start = (f: Found) => {
    const own = new AbortController();
    const list = listHash(f.list);
    let pushedAt = -Infinity;
    fetch = { target: f.target, fetch: { state: "downloading", received: 0, total: f.artifact.size } };
    const done = downloadRelease({
      ...identity, base: deps.feed.base, version: f.target, list: f.list, signature: f.signature, stream,
      signal: AbortSignal.any([controller.signal, own.signal]),
      ...(deps.freeSpace === undefined ? {} : { freeSpace: deps.freeSpace }),
      progress: (received, total) => {
        fetch = { target: f.target, fetch: { state: "downloading", received, total } };
        const t = now();
        if (t - pushedAt >= progressMs) { pushedAt = t; push(); }
      },
    })
      .catch((error: unknown): DownloadOutcome => ({ kind: "could-not-download", detail: error instanceof Error ? error.message : String(error) }))
      .then((outcome) => {
        if (active?.controller === own) active = undefined;
        if ("detail" in outcome) log(`update download ${f.target}: ${outcome.kind}: ${outcome.detail}`);
        // The last finished attempt decides: any other end (a network failure, a full disk) keeps its own retry.
        if (outcome.kind === "bad-download") refused = list;
        else if (outcome.kind !== "cancelled") refused = undefined;
        // Cancelled: the switch or closing ended it; the version is offered again as not downloaded.
        fetch = outcome.kind === "cancelled" ? undefined : { target: f.target, fetch: fetchOf(outcome) };
        push();
      });
    active = { target: f.target, list, controller: own, done };
    pushedAt = now();
    push();
  };

  /** After a verified list: drop other versions, then reuse, start or offer this one. */
  const settle = (outcome: InstalledOutcome) => serial(async () => {
    if (closed) return;
    if (outcome.kind !== "newer" && outcome.kind !== "none-found") return;
    if (outcome.kind === "none-found" || !("artifact" in outcome)) {
      found = undefined;
      await cancelActive("the release list no longer offers a version for this copy");
      // After the cancel: a download ended by it can still finish as "did not match".
      refused = undefined;
      fetch = undefined;
      return;
    }
    const f: Found = { target: outcome.target, artifact: outcome.artifact, list: outcome.signed.list, signature: outcome.signed.signature };
    found = f;
    const list = listHash(f.list);
    if (active !== undefined && active.target !== f.target) await cancelActive(`version ${f.target} replaced version ${active.target}`);
    else if (active !== undefined && active.list !== list) await cancelActive(`a new signed list for version ${f.target} replaced the one being downloaded`);
    if (refused !== list) refused = undefined;
    await removeVersions(deps.dataDir, [f.target, ...kept()]).catch((error: unknown) => log(`update cleanup: ${error instanceof Error ? error.message : String(error)}`));
    if (active !== undefined) return;
    // A folder left by an earlier start is ready only after it checks out again, holding this very list.
    const prepared = await preparedRelease({ ...identity, version: f.target, list: f.list }).catch(() => null);
    if (prepared?.ok === true) { fetch = { target: f.target, fetch: { state: "ready" } }; return; }
    if (prepared !== null) log(`update download ${f.target}: deleted a folder that did not check out: ${prepared.reason}`);
    // Off: a failure is not retried by itself; "Check for updates" offers Download again.
    if (!deps.automatic.enabled()) { fetch = undefined; return; }
    // A list whose file did not match stays "did not match" until a click or new list bytes.
    if (refused === list) { fetch = { target: f.target, fetch: { state: "bad" } }; return; }
    start(f);
  });

  /** A click after a bad download: fetch the refused list again (settle left it alone). */
  const retryRefused = () => serial(async () => {
    if (closed || found === undefined || active !== undefined || !deps.automatic.enabled() || refused !== listHash(found.list)) return;
    start(found);
  });

  const switchedOff = () => serial(async () => {
    await cancelActive("automatic checks were turned off");
    await removeVersions(deps.dataDir, kept()).catch((error: unknown) => log(`update cleanup: ${error instanceof Error ? error.message : String(error)}`));
    fetch = undefined;
    push();
  });
  const offSwitch = deps.automatic.onChange(() => { if (!deps.automatic.enabled()) void switchedOff(); });

  const runCheck = async (): Promise<UpdateCheck> => {
    const checkedAt = now();
    const outcome = await checkInstalled({ version: deps.version, platform: deps.platform, arch: deps.arch, keys: deps.feed.keys, base: deps.feed.base, get, signal: controller.signal })
      .catch((error: unknown): InstalledOutcome => ({ kind: "unreachable", detail: error instanceof Error ? error.message : String(error) }));
    if ("detail" in outcome) log(`update check: ${outcome.kind}: ${outcome.detail}`);
    await settle(outcome);
    // The chat model list rides on a release.json that verified; whatever it does, the verdict below is the check's own.
    if (deps.models !== undefined && (outcome.kind === "none-found" || outcome.kind === "newer") && !closed) {
      await deps.models.refresh(controller.signal).catch((error: unknown) => log(`chat model list: ${error instanceof Error ? error.message : String(error)}`));
    }
    return installedCheck(outcome, { version: deps.version, page: deps.feed.page, checkedAt });
  };

  const check = async (background = false): Promise<UpdateCheck> => {
    // "error", not "unreachable": Settings promises a retry for an unreachable page, and a closing app will not retry.
    if (closed) return closingCheck();
    // Closing to update: nothing is read or deleted, as for clones.
    if (admission.installing()) return { state: "cannot-check", checkedAt: now(), reason: "error", lines: [UPDATE_PAUSED] };
    running ??= runCheck().finally(() => { running = undefined; });
    const c = await running;
    // Also when this click joined a background check already in flight.
    if (!background) await retryRefused();
    if (!closed && (!background || c.state !== "cannot-check")) {
      lastCheck = c;
      push();
    }
    return shown(c) ?? c;
  };

  const update: UpdateModule = {
    status,
    // Two clicks (or two windows) share one read; a background failure stays silent, as for clones.
    check,
    // The Download click: with no verified list in hand, check first.
    download: async () => {
      if (closed) return closingCheck();
      if (found === undefined) await check();
      await serial(async () => {
        if (closed || found === undefined || active !== undefined || (fetch?.target === found.target && fetch.fetch.state === "ready")) return;
        start(found);
      });
      return shown(lastCheck) ?? closingCheck();
    },
    close: async () => {
      closed = true;
      offSwitch();
      offAdmission();
      clearInterval(looking);
      controller.abort(new Error("Gates Local is closing"));
      await running;
      await active?.done;
      await queue;
    },
    prepare,
    commit: ({ reservation, target, release: requested }: UpdateCommitRequest, disconnected?: AbortSignal) => {
      const release = admission.commit(reservation, target, requested, disconnected);
      return release === null ? { accepted: false } : { accepted: true, release };
    },
    cancel: (reservation: string) => ({ cancelled: admission.cancel(reservation) }),
    dismissResult: () => {
      const dismissed = result !== null;
      // The note on disk goes with it: a rollback-failed note stays only until now, and any other was already shown.
      if (dismissed) {
        try { removeRecord(deps.dataDir); } catch (error) { log(`could not remove the update result: ${(error as Error).message}`); }
      }
      result = null;
      failed = undefined;
      push();
      return { dismissed };
    },
  };

  /** The click, after the person confirmed: re-check the prepared folder, then reserve admission for its identity. */
  async function prepare(approval: string): Promise<UpdatePreparation> {
    if (closed || admission.installing()) return blocked(UPDATE_PAUSED);
    if (admission.finishing()) return blocked(FINISHING);
    if (!canRestart(restart)) return blocked(refusal(restart, found?.target ?? ""));
    if (failed !== undefined) return blocked(earlierFailure().text);
    const busy = deps.uninterruptible?.() ?? [];
    if (busy.length > 0) return blocked(`Wait for ${busy.join(", ")} to finish before updating.`);
    const changed = () => ({ state: "changed" as const, status: status() });
    const f = found;
    if (f === undefined || status().approval !== approval) return changed();
    // The folder is checked again as it is now: its list, signature and file.
    const prepared = await serial(() => preparedRelease({ ...identity, version: f.target, list: f.list }).catch(() => null));
    if (prepared?.ok !== true) {
      if (fetch?.target === f.target) fetch = undefined;
      push();
      return changed();
    }
    // Compare and reserve in this same synchronous continuation, as for clones.
    const still = deps.uninterruptible?.() ?? [];
    if (still.length > 0) return blocked(`Wait for ${still.join(", ")} to finish before updating.`);
    if (closed || found !== f || status().approval !== approval) return changed();
    const target = installedTarget(f.target, listHash(f.list));
    return { state: "ready", reservation: admission.reserve(target), target };
  }
  return update;
}
