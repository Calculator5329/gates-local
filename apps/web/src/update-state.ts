import type { UpdateBlocked, UpdateCheck, UpdateStatus } from "@gates-local/contracts";
import { esc } from "./ui.tsx";

/**
 * The sidebar's update icon, one state per row of the footer table:
 * idle (up to date or nothing known), checking, available, downloading,
 * ready, updating, failed and external (this copy cannot update itself).
 */
export type UpdateIconState = "idle" | "checking" | "available" | "downloading" | "ready" | "updating" | "failed" | "external";

/** What a click does: check now, update (after a confirm), download, restart into a downloaded version, open the release page or the version row. */
export type UpdateClick = "check" | "update" | "download" | "restart" | "page" | "settings";

export interface UpdateIcon {
  readonly state: UpdateIconState;
  /** aria-label: plain words. */
  readonly label: string;
  /** data-tip: HTML, every server value escaped. */
  readonly tip: string;
  /** null while busy: the button stays focusable and keeps its tooltip, and a click does nothing. */
  readonly click: UpdateClick | null;
  readonly busy: boolean;
  readonly dot: "amber" | "green" | null;
  /** downloading: 0 to 1, or null when the status carries no numbers (a turning arc). */
  readonly progress?: number | null;
  readonly page?: string;
  /** The click also dismisses the shown result (a stopped or refused update) as it acts on it. */
  readonly dismiss?: boolean;
}

export interface ClickError {
  readonly click: "check" | "download";
  readonly message: string;
  readonly since: number | null;
}

/** Good news since a footer click failed: a check that answered anywhere after it, or, for a download, the server saying it runs or is done. */
export function outdated(e: ClickError, check: UpdateCheck | null | undefined): boolean {
  if (check == null) return false;
  if (e.since === null || check.checkedAt > e.since) return true;
  return e.click === "download" && check.state === "newer" && (check.download === "downloading" || check.download === "ready");
}

export interface UpdateInput {
  readonly status: UpdateStatus | null;
  /** The desktop app (canUpdateHere): the icon exists only there. */
  readonly desktop: boolean;
  readonly checking?: boolean;
  readonly installing?: boolean;
  /** This window's last update click failed before the app closed. */
  readonly error?: string | null;
  /** This footer's last check or download click failed: which, the words Settings shows for it, and the check it saw then (its checkedAt, or null). */
  readonly clickError?: ClickError | null;
  /** A download was just clicked and the server has not said where it is yet. */
  readonly downloading?: boolean;
  /**
   * An installed copy that can restart into a downloaded version (canRestart
   * below): a Linux AppImage that can replace its own file. Elsewhere the
   * server's lines say why not, and a downloaded version shows as external.
   */
  readonly canRestart?: boolean;
  readonly clock?: (ms: number) => string;
}

const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const lines = (...l: (string | false | undefined)[]) => l.filter((x): x is string => typeof x === "string" && x !== "").join("<br>");
const changes = (n: number) => (n === 1 ? "1 change" : `${n} changes`);
const CHECK = "Check for updates";
const ITSELF = "Can't update itself";
const FAILED = "Update failed";
const NOT_CHECKED = "Could not check for updates";
const AGAIN = "Click to check again.";
const PAGE = "Click to open the release page.";
const SETTINGS = "Click to open Settings › General.";

/** What an update brings: its release notes, or else its change titles, five at most. */
function notes(text: string | undefined, titles: readonly string[]): string[] {
  const all = text === undefined ? titles : text.split("\n").filter((l) => l.trim() !== "");
  return [...all.slice(0, 5).map(esc), ...(all.length > 5 ? [`and ${all.length - 5} more`] : [])];
}

/** The first server line in bold, the rest plain, all escaped. */
function said(ls: readonly string[]): string {
  const [first, ...rest] = ls;
  return lines(first !== undefined && `<b>${esc(first)}</b>`, ...rest.map(esc));
}

function icon(state: UpdateIconState, label: string, tip: string, click: UpdateClick | null, more: Partial<UpdateIcon> = {}): UpdateIcon {
  return { state, label, tip, click, busy: click === null, dot: null, ...more };
}

/** A clone's target this window can install now: a checked commit and the server's approval for it. Without one, a click checks first. */
const fresh = (status: UpdateStatus | null) => status?.approval !== undefined && status.lastCheck?.state === "available" && status.lastCheck.targetCommit !== undefined;

/** An installed copy this window can restart into its downloaded version: the desktop app, the server's restart flag and its approval. */
export function restartable(status: UpdateStatus | null, desktop: boolean): boolean {
  const check = status?.lastCheck;
  return desktop && status?.approval !== undefined && check?.state === "newer" && check.download === "ready" && check.restart === true;
}

/** Whether a new check can change why a check could not say. Exhaustive, so a new reason fails the build until it is placed. */
function retryable(reason: UpdateBlocked): boolean {
  switch (reason) {
    case "remote":
    case "error":
    case "unfinished":
    case "unreachable":
    case "no-list":
    case "bad-signature":
      return true;
    case "no-git":
    case "not-a-clone":
    case "no-upstream":
    case "local-changes":
    case "local-commits":
    case "no-releases":
    case "diverged":
    case "development":
    case "no-key":
      return false;
  }
}

function blockedIcon(check: Extract<UpdateCheck, { state: "cannot-check" }>, when: string): UpdateIcon {
  if (retryable(check.reason)) return icon("failed", NOT_CHECKED, lines(said(check.lines), `Tried at ${when}.`, AGAIN), "check");
  if (check.reason === "no-key" && check.page !== undefined) return icon("external", ITSELF, lines(said(check.lines), PAGE), "page", { page: check.page });
  return icon("external", ITSELF, lines(said(check.lines), SETTINGS), "settings");
}

function installedIcon(check: Extract<UpdateCheck, { state: "newer" }>, canRestart: boolean, downloading: boolean, when: string): UpdateIcon {
  const tried = `Checked at ${when}.`;
  if (!check.forThisCopy) return icon("external", ITSELF, lines(said(check.lines), tried, PAGE), "page", { dot: "amber", page: check.page });
  switch (check.download) {
    case undefined:
      if (downloading) return icon("downloading", `Downloading version ${check.target}`, `<b>Starting the download of version ${esc(check.target)}…</b>`, null, { progress: null });
      return icon("available", `Download version ${check.target}`, lines(said(check.lines), tried, "Click to download it. You can keep chatting."), "download", { dot: "amber" });
    case "downloading":
      return icon("downloading", `Downloading version ${check.target}`, said(check.lines), null, { progress: null });
    case "ready":
      return canRestart
        ? icon("ready", "Restart to update", lines(`<b>Restart to update.</b> Version ${esc(check.target)} is downloaded.`, "Gates Local will close, update and reopen."), "restart", { dot: "green" })
        : icon("external", ITSELF, lines(said(check.lines), PAGE), "page", { dot: "amber", page: check.page });
    case "bad":
    case "failed":
    case "disk":
      return icon("failed", FAILED, lines(said(check.lines), AGAIN), "check");
  }
}

/** The icon for a status, or null where the icon is not shown (a browser tab, a phone). */
export function updateIcon({ status, desktop, checking = false, installing = false, error = null, clickError = null, downloading = false, canRestart = false, clock = time }: UpdateInput): UpdateIcon | null {
  if (!desktop) return null;
  if (installing || status?.installing === true) {
    const how = status?.version.kind === "installed" ? "Gates Local will close, update and reopen." : "Gates Local closes while dependencies install and the app builds, then opens again.";
    return icon("updating", "Closing to update…", lines("<b>Closing to update…</b>", how), null);
  }
  if (checking) return icon("checking", "Checking for updates…", "<b>Checking for updates…</b>", null);
  if (clickError !== null && !outdated(clickError, status?.lastCheck)) return icon("failed", clickError.click === "check" ? NOT_CHECKED : "Download failed", lines(`<b>${esc(clickError.message)}</b>`, AGAIN), "check");
  // A retry installs only a fresh target; without one the click checks first.
  const retry = fresh(status)
    ? { click: "update" as const, words: "Click to try again." }
    : canRestart && status?.lastCheck?.state === "newer" && status.lastCheck.restart === true
      ? { click: "restart" as const, words: "Click to try again." }
      : { click: "check" as const, words: AGAIN };
  if (error !== null) return icon("failed", FAILED, lines(`<b>${esc(error)}</b>`, retry.words), retry.click);
  const result = status?.result;
  if (result && result.outcome !== "updated") {
    const told = [`<b>${esc(result.line)}</b>`, result.logPath && `Full log: ${esc(result.logPath)}`, ...(result.commands ?? []).map(esc)];
    // A failed rollback leaves commands to run: Settings › General shows them and keeps the note.
    if (result.outcome === "rollback-failed") return icon("failed", FAILED, lines(...told, SETTINGS), "settings");
    return icon("failed", FAILED, lines(...told, retry.words), retry.click, { dismiss: true });
  }
  const version = status?.version;
  if (version?.kind === "not-a-clone") return icon("external", ITSELF, lines("<b>This copy cannot update itself.</b>", "It was not downloaded with git clone, so it cannot check for updates.", "Click to see the version in Settings."), "settings");
  if (version?.kind === "unreadable") return icon("external", ITSELF, lines("<b>This copy cannot update itself.</b>", `Could not read the version: ${esc(version.detail)}.`, "Click to see the version in Settings."), "settings");
  const check = status?.lastCheck ?? null;
  if (check === null) return icon("idle", CHECK, lines(`<b>${CHECK}</b>`, "Not checked since Gates Local started."), "check");
  const when = clock(check.checkedAt);
  switch (check.state) {
    case "up-to-date":
      return icon("idle", CHECK, lines(`<b>${CHECK}</b>`, version?.kind === "installed" ? `No newer version was found. Checked at ${when}.` : `Up to date (${esc(check.current)}). Checked at ${when}.`), "check");
    case "available":
      return icon("available", `Update to ${check.target}`, lines(
        `<b>Update to ${esc(check.target)}</b>`,
        `${changes(check.total)} from ${esc(check.current)} to ${esc(check.target)}. Checked at ${when}.`,
        ...notes(check.notes, check.changes),
        retry.click === "update" ? "Click to update. Gates Local asks first, then closes while it updates and opens again." : "Click to check it again before updating.",
      ), retry.click, { dot: "amber" });
    case "newer":
      return installedIcon(check, canRestart, downloading, when);
    case "cannot-check":
      return blockedIcon(check, when);
  }
}
