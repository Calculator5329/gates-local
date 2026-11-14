import type { UpdateBlocked, UpdateCheck, UpdateStatus } from "@gates-local/contracts";

/**
 * The sidebar's update icon, one state per row of the footer table:
 * idle (up to date or nothing known), checking, available, downloading,
 * ready, updating, failed and external (this copy cannot update itself).
 */
export type UpdateIconState = "idle" | "checking" | "available" | "downloading" | "ready" | "updating" | "failed" | "external";

/** What a click does: check now, update (after a confirm), download, restart into a downloaded version, open the release page, the download's folder, or the version row. */
export type UpdateClick = "check" | "update" | "download" | "restart" | "page" | "folder" | "settings";

/**
 * The icon says the state; its name (aria-label and tooltip) is a few words
 * and nothing more (audit of 0.2.4, the tooltip rule). Settings › Updates
 * says the rest.
 */
export interface UpdateIcon {
  readonly state: UpdateIconState;
  /** aria-label and the tooltip: plain words, one to three. */
  readonly label: string;
  /** null while busy: the button stays focusable and keeps its tooltip, and a click does nothing. */
  readonly click: UpdateClick | null;
  readonly busy: boolean;
  readonly dot: "amber" | "green" | null;
  /** downloading: 0 to 1, or null when the status carries no numbers (a turning arc). */
  readonly progress?: number | null;
  readonly page?: string;
  /** folder: the downloaded version whose folder the click opens. */
  readonly target?: string;
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
  /** The desktop app can open a downloaded version's folder (canShowUpdate); without it the click opens the release page. */
  readonly canShow?: boolean;
}

/** The one clock time every update surface shows ("9:05 AM"). */
export const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
/** The one version form every update surface shows: "0.2.5", never "v0.2.5". A commit hash passes through. */
export const ver = (v: string) => v.replace(/^v(?=\d)/, "");
/** The one button name for closing into a newer version, on a clone and on an installed copy. */
export const RESTART = "Restart to update";

const CHECK = "Check for updates";
export const ITSELF = "Can't update itself";
const FAILED = "Update failed";
const NOT_CHECKED = "Couldn't check";

function icon(state: UpdateIconState, label: string, click: UpdateClick | null, more: Partial<UpdateIcon> = {}): UpdateIcon {
  return { state, label, click, busy: click === null, dot: null, ...more };
}

/** A clone's target this window can install now: a checked commit and the server's approval for it. Without one, a click checks first. */
const fresh = (status: UpdateStatus | null) => status?.approval !== undefined && status.lastCheck?.state === "available" && status.lastCheck.targetCommit !== undefined;

/** An installed copy this window can restart into its downloaded version: the desktop app, the server's restart flag and its approval. */
export function restartable(status: UpdateStatus | null, desktop: boolean): boolean {
  const check = status?.lastCheck;
  return desktop && status?.approval !== undefined && check?.state === "newer" && check.download === "ready" && check.restart === true;
}

/**
 * Whether a new check can change why a check could not say ("Couldn't check"); otherwise the check
 * ran and this copy cannot update itself until the person acts ("Can't update itself"). Exhaustive,
 * so a new reason fails the build until it is placed.
 */
export function retryable(reason: UpdateBlocked): boolean {
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

function blockedIcon(check: Extract<UpdateCheck, { state: "cannot-check" }>): UpdateIcon {
  if (retryable(check.reason)) return icon("failed", NOT_CHECKED, "check");
  if (check.reason === "no-key" && check.page !== undefined) return icon("external", ITSELF, "page", { page: check.page });
  return icon("external", ITSELF, "settings");
}

function installedIcon(check: Extract<UpdateCheck, { state: "newer" }>, canRestart: boolean, canShow: boolean, downloading: boolean): UpdateIcon {
  const target = ver(check.target);
  if (!check.forThisCopy) return icon("external", ITSELF, "page", { dot: "amber", page: check.page });
  switch (check.download) {
    case undefined:
      if (downloading) return icon("downloading", `Downloading ${target}`, null, { progress: null });
      return icon("available", `Download ${target}`, "download", { dot: "amber" });
    case "downloading":
      return icon("downloading", `Downloading ${target}`, null, { progress: null });
    case "ready":
      // Ready is the green up-arrow alone, no dot (audit of 0.2.4, decision 22). A copy that cannot install it opens the checked file's folder.
      if (canRestart) return icon("ready", RESTART, "restart");
      return canShow
        ? icon("external", ITSELF, "folder", { dot: "amber", target: check.target })
        : icon("external", ITSELF, "page", { dot: "amber", page: check.page });
    case "bad":
    case "failed":
    case "disk":
      return icon("failed", FAILED, "check");
  }
}

/** The icon for a status, or null where the icon is not shown (a browser tab, a phone). */
export function updateIcon({ status, desktop, checking = false, installing = false, error = null, clickError = null, downloading = false, canRestart = false, canShow = false }: UpdateInput): UpdateIcon | null {
  if (!desktop) return null;
  if (installing || status?.installing === true) return icon("updating", "Closing to update…", null);
  if (checking) return icon("checking", "Checking for updates…", null);
  if (clickError !== null && !outdated(clickError, status?.lastCheck)) return icon("failed", clickError.click === "check" ? NOT_CHECKED : "Download failed", "check");
  // A retry installs only a fresh target; without one the click checks first.
  const retry: UpdateClick = fresh(status)
    ? "update"
    : canRestart && status?.lastCheck?.state === "newer" && status.lastCheck.restart === true
      ? "restart"
      : "check";
  if (error !== null) return icon("failed", FAILED, retry);
  const result = status?.result;
  if (result && result.outcome !== "updated") {
    // A failed rollback leaves commands to run: Settings › General shows them and keeps the note.
    if (result.outcome === "rollback-failed") return icon("failed", FAILED, "settings");
    return icon("failed", FAILED, retry, { dismiss: true });
  }
  const version = status?.version;
  if (version?.kind === "not-a-clone" || version?.kind === "unreadable") return icon("external", ITSELF, "settings");
  const check = status?.lastCheck ?? null;
  if (check === null) return icon("idle", CHECK, "check");
  switch (check.state) {
    case "up-to-date":
      return icon("idle", CHECK, "check");
    case "available":
      return icon("available", `Update to ${ver(check.target)}`, retry, { dot: "amber" });
    case "newer":
      return installedIcon(check, canRestart, canShow, downloading);
    case "cannot-check":
      return blockedIcon(check);
  }
}
