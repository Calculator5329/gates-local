import type { UpdateDownload } from "@gates-local/contracts";
import fs from "node:fs";
import { REPO_URL } from "../cli.ts";
import { parseReleaseKey, TRUSTED_RELEASE_KEYS } from "../release-manifest.ts";
import { refusedAddress } from "./feed.ts";
import { type CannotReplace, downloaded, keptDownload, readyWindows } from "./words.ts";

export const INSTALLED_VERSION_ENV = "GATES_LOCAL_INSTALLED_VERSION";
export const FEED_ENV = "GATES_LOCAL_UPDATE_FEED";
export const TEST_KEYS_ENV = "GATES_LOCAL_UPDATE_TEST_KEYS";

/** B: the public repository's release pages, from the same address the clone updater uses. */
export const DEFAULT_FEED = new URL(`${REPO_URL.replace(/\.git$/, "")}/releases`);

/** `page` is where the words send a person: B/latest. */
export interface InstalledFeed {
  readonly base: URL;
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
const RESTARTS: readonly Restart[] = ["yes", "windows", "none", "pinned", "read-only", "no-permission", "not-appimage", "download-folder"];
export const parseRestart = (value: string | undefined): Restart => RESTARTS.find((r) => r === value) ?? "none";
/** Restart to update is offered: an AppImage that can replace its file, or a Windows install. */
export const canRestart = (restart: Restart): restart is "yes" | "windows" => restart === "yes" || restart === "windows";

/** Where a Windows copy goes back to (section 3, W-A step 2): its own version's kept installer, else that version's release page. */
export type GoBack = { readonly installer: string } | { readonly current: string; readonly releasePage: string };

/** The admission target of an installed copy: the version and the SHA-512 of the exact signed list bytes. */
export const installedTarget = (version: string, listDigest: string) => `${version}:${listDigest}`;

/** Where the download of version target stands, with what its words need. */
export type Fetch =
  | { readonly state: "downloading"; readonly received: number; readonly total: number }
  | { readonly state: "disk"; readonly volume: string; readonly needed: number; readonly free: number }
  | { readonly state: Exclude<UpdateDownload, "downloading" | "disk"> };

const MB = 1_000_000;
function mb(bytes: number, round: (n: number) => number = Math.round): string {
  const value = bytes / MB;
  return value < 10 ? (round(value * 10) / 10).toFixed(1) : String(round(value));
}

/** The download's words, in place of "Version <new> is available.".
 *  Ready: a copy that can restart into it says so beside its Restart button (a Windows copy also says how to go back). Any other
 *  keeps the checked file and says, in one line that fits the card, what to do with it; Settings opens its folder. */
export function downloadLines(target: string, fetch: Fetch, restart: Restart = "none", goBack?: GoBack, platform: string = process.platform, program: string | null = null): string[] {
  switch (fetch.state) {
    case "downloading":
      return [`Downloading version ${target} (${mb(fetch.received, Math.floor)} of ${mb(fetch.total)} MB). You can keep chatting.`];
    case "bad":
      return [`The download of version ${target} did not match the signed release list, so it was deleted.`];
    case "failed":
      return [`Could not download version ${target}. Check your connection.`];
    case "disk":
      return [`Not enough free space on ${fetch.volume} for version ${target} (needs ${mb(fetch.needed, Math.ceil)} MB, ${mb(fetch.free, Math.floor)} MB free). Free some space, then use Check for updates.`];
    case "ready":
      if (restart === "yes") return [downloaded(target).text];
      if (restart === "windows") {
        const detail = goBack === undefined ? undefined : readyWindows(target, goBack).detail;
        return [downloaded(target).text, ...(detail === undefined ? [] : [detail])];
      }
      return [keptDownload(target, restart, { platform, program }).text];
  }
}

/** The real path of the file the AppImage runtime says it started (APPIMAGE), when it is a file; else null. */
export function runningAppImage(env: NodeJS.ProcessEnv): string | null {
  const value = env["APPIMAGE"];
  if (value === undefined || value === "") return null;
  try {
    const real = fs.realpathSync(value);
    return fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}
