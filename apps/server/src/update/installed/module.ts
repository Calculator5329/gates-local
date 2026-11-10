// Settings › General › Updates for an installed copy (AppImage or installer).
//
// The desktop app passes the packaged version in GATES_LOCAL_INSTALLED_VERSION;
// with it set, main.ts composes this module in place of the clone updater, so
// no git process ever starts for updates. Status is the version and the last
// check. A check reads the signed release list (check.ts) and says in plain
// words whether a newer version exists and where to get it. It downloads
// nothing, installs nothing and writes nothing under the data folder.
// The automatic timer (automatic.ts) and the updateAutomatic switch are shared
// with the clone updater unchanged; Settings reads the switch itself for the
// "will try again" sentence.
import type { UpdateCheck, UpdateStatus } from "@gates-local/contracts";
import { REPO_URL } from "../cli.ts";
import type { UpdateModule } from "../module.ts";
import { parseReleaseKey, TRUSTED_RELEASE_KEYS } from "../release-manifest.ts";
import { checkInstalled, type InstalledOutcome } from "./check.ts";
import { boundedGet, type Get, refusedAddress } from "./feed.ts";

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
      const forThisCopy = outcome.artifact !== undefined;
      const line = forThisCopy
        ? `Version ${outcome.target} is available. Download it from the release page.`
        : `Version ${outcome.target} is available, but this copy cannot install it by itself. Download it from the release page.`;
      return { state: "newer", checkedAt, current: o.version, target: outcome.target, forThisCopy, lines: [line], page };
    }
  }
}

export interface InstalledModuleDeps {
  /** app.getVersion() of the packaged copy. */
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  readonly feed: InstalledFeed;
  /** Tests pass a fake; the real one is boundedGet. */
  readonly get?: Get;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly changed?: (status: UpdateStatus) => void;
}

export function createInstalledUpdateModule(deps: InstalledModuleDeps): UpdateModule {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const get = deps.get ?? boundedGet({ allowLoopbackHttp: deps.feed.allowLoopbackHttp });
  const controller = new AbortController();
  let lastCheck: UpdateCheck | null = null;
  let running: Promise<UpdateCheck> | undefined;
  let closed = false;
  const status = (): UpdateStatus => ({ version: { kind: "installed", version: deps.version }, result: null, lastCheck, activity: [], installing: false });

  const runCheck = async (): Promise<UpdateCheck> => {
    const checkedAt = now();
    const outcome = await checkInstalled({ version: deps.version, platform: deps.platform, arch: deps.arch, keys: deps.feed.keys, base: deps.feed.base, get, signal: controller.signal })
      .catch((error: unknown): InstalledOutcome => ({ kind: "unreachable", detail: error instanceof Error ? error.message : String(error) }));
    if ("detail" in outcome) log(`update check: ${outcome.kind}: ${outcome.detail}`);
    return installedCheck(outcome, { version: deps.version, page: deps.feed.page, checkedAt });
  };

  return {
    status,
    // Two clicks (or two windows) share one read; a background failure stays silent, as for clones.
    check: async (background = false) => {
      // "error", not "unreachable": Settings promises a retry for an unreachable page, and a closing app will not retry.
      if (closed) return { state: "cannot-check", checkedAt: now(), reason: "error", lines: ["Gates Local is closing, so it did not check for updates."] };
      running ??= runCheck().finally(() => { running = undefined; });
      const c = await running;
      if (!closed && (!background || c.state !== "cannot-check")) {
        lastCheck = c;
        deps.changed?.(status());
      }
      return c;
    },
    close: async () => { closed = true; controller.abort(); await running; },
    // Nothing installs here yet: the next lanes add the download and the install.
    prepare: () => Promise.resolve({ state: "blocked", message: INSTALL_REFUSAL }),
    commit: () => ({ accepted: false }),
    cancel: () => ({ cancelled: false }),
    dismissResult: () => ({ dismissed: false }),
  };
}
