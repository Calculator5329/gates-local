import type { UpdateCheck, UpdateCommitRequest, UpdatePreparation, UpdateResult, UpdateStatus } from "@gates-local/contracts";
import { randomUUID } from "node:crypto";
import { cannotReplace, earlierFailure, pinnedDataFolder } from "@gates-local/update/installed/words";
import { createUpdateAdmission, FINISHING, UPDATE_PAUSED, type UpdateAdmission } from "@gates-local/update/admission";
import type { UpdateModule } from "../module.ts";
import { publishStatus, type StatusListener } from "../published.ts";
import { readRecord, removeRecord, takeRecord, type UpdateRecord, writeRecord } from "@gates-local/update/record";
import type { ReleaseArtifact } from "@gates-local/update/release-manifest";
import { checkInstalled, type InstalledOutcome } from "./check.ts";
import { canRestart, downloadLines, type Fetch, type GoBack, INSTALL_REFUSAL, INSTALLED_VERSION_ENV, type InstalledFeed, installedTarget, type Restart, runningAppImage } from "@gates-local/update/installed/copy";
import { type DownloadOutcome, downloadRelease, inUpdatesFolder, listHash, noteStartedFrom, preparedRelease, removeVersions, type Space, type Verified, verifyKept } from "@gates-local/update/installed/download";
import { boundedGet, type Get, type Stream, streamGet } from "@gates-local/update/installed/feed";
import { INSTALLED_APPROVAL_MS } from "@gates-local/update/installed/transaction";
import type { ModelLists } from "./models-list.ts";

export function chooseUpdateModule(env: NodeJS.ProcessEnv, build: { readonly installed: (version: string) => UpdateModule; readonly clone: () => UpdateModule }): UpdateModule {
  const version = env[INSTALLED_VERSION_ENV] ?? "";
  return version === "" ? build.clone() : build.installed(version);
}

const blocked = (message: string) => ({ state: "blocked" as const, message });

function refusal(restart: Exclude<Restart, "yes" | "windows">, target: string): string {
  if (restart === "none") return INSTALL_REFUSAL;
  return restart === "pinned" ? pinnedDataFolder(target).text : cannotReplace(restart, target).text;
}

// why: Settings adds the hourly retry line from the live switch, so it stays true after a toggle
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
      const line = forThisCopy
        ? `Version ${outcome.target} is available.`
        : `Version ${outcome.target} is available, but this copy cannot install it by itself. Download it from the release page.`;
      return { state: "newer", checkedAt, current: o.version, target: outcome.target, forThisCopy, lines: [line], page };
    }
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
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  readonly feed: InstalledFeed;
  readonly dataDir: string;
  readonly automatic: { readonly enabled: () => boolean; readonly onChange: (listener: () => void) => () => void };
  readonly keep: () => readonly string[];
  readonly restart?: Restart;
  readonly program?: string | null;
  readonly admission?: UpdateAdmission;
  readonly activity?: () => readonly string[];
  readonly uninterruptible?: () => readonly string[];
  readonly startupToken?: string;
  readonly resultPollMs?: number;
  readonly get?: Get;
  readonly models?: ModelLists;
  readonly stream?: Stream;
  readonly freeSpace?: (folder: string) => Promise<Space>;
  readonly keptInstaller?: (version: string) => Promise<Verified>;
  readonly progressMs?: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly changed?: StatusListener;
}

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
  const program = deps.program === undefined ? (deps.platform === "linux" ? runningAppImage(process.env) : null) : deps.program;
  const programs = [...(program === null ? [] : [program]), process.execPath];
  const identity = { dataDir: deps.dataDir, running: deps.version, keys: deps.feed.keys, platform: deps.platform, arch: deps.arch, programs };
  const controller = new AbortController();
  let lastCheck: UpdateCheck | null = null;
  let running: Promise<UpdateCheck> | undefined;
  let closed = false;
  let found: Found | undefined;
  let fetch: { readonly target: string; readonly fetch: Fetch } | undefined;
  let active: { readonly target: string; readonly list: string; readonly controller: AbortController; readonly done: Promise<void> } | undefined;
  let refused: string | undefined;
  // why: checks, clicks and the switch each change the updates folder, so one at a time
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work);
    queue = next.catch(() => undefined);
    return next;
  };

  try { deps.models?.loadStored(); }
  catch (error) { log(`chat model list: ${error instanceof Error ? error.message : String(error)}`); }

  const restart = deps.restart === "yes" && program !== null && inUpdatesFolder(deps.dataDir, program) ? "download-folder" : deps.restart ?? "none";
  if (program !== null) {
    try { noteStartedFrom(deps.dataDir, program); }
    catch (error) { log(`could not note that this copy was started from its download folder: ${error instanceof Error ? error.message : String(error)}`); }
  }
  let goBack: GoBack | undefined;
  const admission =deps.admission ?? createUpdateAdmission({ finishing: deps.startupToken !== undefined });

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
    else if (r.installed.shown !== true) {
      try { writeRecord(deps.dataDir, { ...r, installed: { ...r.installed, shown: true } }); } catch (error) { log(`could not mark the update result shown: ${(error as Error).message}`); }
    }
    // why: opening notifies, and that pushes the status with the result
    admission.open();
  };
  try {
    if (deps.startupToken === undefined) {
      const left = readRecord(deps.dataDir);
      if (left?.outcome === "rollback-failed" && left.installed !== undefined) { failed = left; result = toResult(left); }
      else {
        const taken = takeRecord(deps.dataDir);
        const otherVersion = taken?.outcome === "updated" && taken.installed !== undefined && taken.installed.to !== deps.version;
        if (otherVersion) log(`dropped the result "updated to ${taken.installed?.to ?? ""}": version ${deps.version} runs`);
        else if (taken !== undefined && taken.installed?.shown !== true) result = toResult(taken);
      }
    }
  } catch (error) {
    log(`could not read the last update result: ${(error as Error).message}`);
  }

  const shown = (c: UpdateCheck | null): UpdateCheck | null => {
    if (c?.state !== "newer" || !c.forThisCopy || fetch?.target !== c.target) return c;
    const checked = fetch.fetch.state === "ready" && canRestart(restart);
    const ready = checked && failed === undefined && (restart !== "windows" || goBack !== undefined);
    const coming = checked && failed === undefined && !ready;
    const lines = checked && failed !== undefined ? [earlierFailure().text] : downloadLines(c.target, fetch.fetch, restart, goBack, deps.platform, program);
    return { ...c, lines, download: fetch.fetch.state, ...(ready ? { restart: true } : coming ? { restart: false } : {}) };
  };
  let offer: { readonly token: string; readonly fingerprint: string } | undefined;
  const readyTarget = (c: UpdateCheck | null): string | undefined => {
    if (!canRestart(restart) || found === undefined || failed !== undefined || c?.state !== "newer" || c.target !== found.target || c.download !== "ready" || c.restart !== true) return undefined;
    return installedTarget(found.target, listHash(found.list));
  };
  const work = (): UpdateStatus => {
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
  const published = publishStatus(work, deps.changed);
  const status = published.read;
  const push = () => { if (!closed) published.changed(); };
  const offAdmission = admission.onChange(push);
  if (restart === "windows") {
    const releasePage = `${deps.feed.base.href.replace(/\/+$/, "")}/tag/v${deps.version}`;
    void (deps.keptInstaller ?? ((version: string) => verifyKept({ ...identity, version })))(deps.version)
      .catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }))
      .then((kept) => {
        if (!kept.ok) log(`no kept installer for ${deps.version}: ${kept.reason}`);
        goBack = kept.ok ? { installer: kept.prepared.file } : { current: deps.version, releasePage };
        push();
      });
  }
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
        if (outcome.kind === "bad-download") refused = list;
        else if (outcome.kind !== "cancelled") refused = undefined;
        fetch = outcome.kind === "cancelled" ? undefined : { target: f.target, fetch: fetchOf(outcome) };
        push();
      });
    active = { target: f.target, list, controller: own, done };
    pushedAt = now();
    push();
  };

  const settle = (outcome: InstalledOutcome) => serial(async () => {
    if (closed) return;
    if (outcome.kind !== "newer" && outcome.kind !== "none-found") return;
    if (outcome.kind === "none-found" || !("artifact" in outcome)) {
      found = undefined;
      await cancelActive("the release list no longer offers a version for this copy");
      // why: a download the cancel ended can still finish as "did not match"
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
    await removeVersions(deps.dataDir, [f.target, ...kept()], programs).catch((error: unknown) => log(`update cleanup: ${error instanceof Error ? error.message : String(error)}`));
    if (active !== undefined) return;
    const prepared = await preparedRelease({ ...identity, version: f.target, list: f.list }).catch(() => null);
    if (prepared?.ok === true) { fetch = { target: f.target, fetch: { state: "ready" } }; return; }
    if (prepared !== null) log(`update download ${f.target}: its folder did not check out: ${prepared.reason}`);
    if (!deps.automatic.enabled()) { fetch = undefined; return; }
    if (refused === list) { fetch = { target: f.target, fetch: { state: "bad" } }; return; }
    start(f);
  });

  const retryRefused = () => serial(async () => {
    if (closed || found === undefined || active !== undefined || !deps.automatic.enabled() || refused !== listHash(found.list)) return;
    start(found);
  });

  const switchedOff = () => serial(async () => {
    await cancelActive("automatic checks were turned off");
    const ready = fetch?.fetch.state === "ready" ? [fetch.target] : [];
    await removeVersions(deps.dataDir, [...kept(), ...ready], programs).catch((error: unknown) => log(`update cleanup: ${error instanceof Error ? error.message : String(error)}`));
    if (ready.length === 0) fetch = undefined;
    push();
  });
  const offSwitch = deps.automatic.onChange(() => { if (!deps.automatic.enabled()) void switchedOff(); });

  const runCheck = async (): Promise<UpdateCheck> => {
    const checkedAt = now();
    const outcome = await checkInstalled({ version: deps.version, platform: deps.platform, arch: deps.arch, keys: deps.feed.keys, base: deps.feed.base, get, signal: controller.signal })
      .catch((error: unknown): InstalledOutcome => ({ kind: "unreachable", detail: error instanceof Error ? error.message : String(error) }));
    if ("detail" in outcome) log(`update check: ${outcome.kind}: ${outcome.detail}`);
    await settle(outcome);
    if (deps.models !== undefined && (outcome.kind === "none-found" || outcome.kind === "newer") && !closed) {
      await deps.models.refresh(controller.signal).catch((error: unknown) => log(`chat model list: ${error instanceof Error ? error.message : String(error)}`));
    }
    return installedCheck(outcome, { version: deps.version, page: deps.feed.page, checkedAt });
  };

  const check = async (background = false): Promise<UpdateCheck> => {
    if (closed) return closingCheck();
    if (admission.installing()) return { state: "cannot-check", checkedAt: now(), reason: "error", lines: [UPDATE_PAUSED] };
    running ??= runCheck().finally(() => { running = undefined; });
    const c = await running;
    if (!background) await retryRefused();
    if (!closed && (!background || c.state !== "cannot-check")) {
      lastCheck = c;
      push();
    }
    return shown(c) ?? c;
  };

  const update: UpdateModule = {
    status,
    stamp: published.stamp,
    check,
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
      const release = admission.commit(reservation, target, requested, disconnected, INSTALLED_APPROVAL_MS);
      return release === null ? { accepted: false } : { accepted: true, release };
    },
    cancel: (reservation: string) => ({ cancelled: admission.cancel(reservation) }),
    dismissResult: () => {
      const dismissed = result !== null;
      if (dismissed) {
        try { removeRecord(deps.dataDir); } catch (error) { log(`could not remove the update result: ${(error as Error).message}`); }
      }
      result = null;
      failed = undefined;
      push();
      return { dismissed };
    },
  };

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
    const prepared = await serial(() => preparedRelease({ ...identity, version: f.target, list: f.list }).catch(() => null));
    if (prepared?.ok !== true) {
      if (fetch?.target === f.target) fetch = undefined;
      push();
      return changed();
    }
    const still = deps.uninterruptible?.() ?? [];
    if (still.length > 0) return blocked(`Wait for ${still.join(", ")} to finish before updating.`);
    if (closed || found !== f || status().approval !== approval) return changed();
    const target = installedTarget(f.target, listHash(f.list));
    return { state: "ready", reservation: admission.reserve(target), target };
  }
  return update;
}
