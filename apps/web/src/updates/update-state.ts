import type { UpdateBlocked, UpdateCheck, UpdateStatus } from "@gates-local/contracts";

export type UpdateIconState = "idle" | "checking" | "available" | "downloading" | "ready" | "waiting" | "updating" | "failed" | "external";

export type UpdateClick = "check" | "update" | "download" | "restart" | "page" | "settings";

export interface UpdateIcon {
  readonly state: UpdateIconState;
  readonly label: string;
  readonly click: UpdateClick | null;
  readonly busy: boolean;
  readonly dot: "amber" | "green" | null;
  readonly progress?: number | null;
  readonly page?: string;
  readonly dismiss?: boolean;
}

export interface ClickError {
  readonly click: "check" | "download";
  readonly message: string;
  readonly since: number | null;
}

export function outdated(e: ClickError, check: UpdateCheck | null | undefined): boolean {
  if (check == null) return false;
  if (e.since === null || check.checkedAt > e.since) return true;
  return e.click === "download" && check.state === "newer" && (check.download === "downloading" || check.download === "ready");
}

export interface UpdateInput {
  readonly status: UpdateStatus | null;
  readonly desktop: boolean;
  readonly checking?: boolean;
  readonly installing?: boolean;
  readonly error?: string | null;
  readonly clickError?: ClickError | null;
  readonly downloading?: boolean;
  readonly canRestart?: boolean;
}

export const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
export const ver = (v: string) => v.replace(/^v(?=\d)/, "");
export const RESTART = "Restart to update";

const CHECK = "Check for updates";
export const ITSELF = "Can't update itself";
const FAILED = "Update failed";
const NOT_CHECKED = "Couldn't check";

function icon(state: UpdateIconState, label: string, click: UpdateClick | null, more: Partial<UpdateIcon> = {}): UpdateIcon {
  return { state, label, click, busy: click === null, dot: null, ...more };
}

const fresh = (status: UpdateStatus | null) => status?.approval !== undefined && status.lastCheck?.state === "available" && status.lastCheck.targetCommit !== undefined;

export function restartable(status: UpdateStatus | null, desktop: boolean): boolean {
  const check = status?.lastCheck;
  return desktop && status?.approval !== undefined && check?.state === "newer" && check.download === "ready" && check.restart === true;
}

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

function installedIcon(check: Extract<UpdateCheck, { state: "newer" }>, canRestart: boolean, downloading: boolean): UpdateIcon {
  const target = ver(check.target);
  if (!check.forThisCopy) return icon("external", ITSELF, "page", { dot: "amber", page: check.page });
  switch (check.download) {
    case undefined:
      if (downloading) return icon("downloading", `Downloading ${target}`, null, { progress: null });
      return icon("available", `Download ${target}`, "download", { dot: "amber" });
    case "downloading":
      return icon("downloading", `Downloading ${target}`, null, { progress: null });
    case "ready":
      if (check.restart === false) return icon("checking", "Checking for updates…", null);
      if (canRestart) return icon("ready", RESTART, "restart");
      return icon("waiting", `Update ${target} waiting`, "settings", { dot: "amber" });
    case "bad":
    case "failed":
    case "disk":
      return icon("failed", FAILED, "check");
  }
}

export function updateIcon({ status, desktop, checking = false, installing = false, error = null, clickError = null, downloading = false, canRestart = false }: UpdateInput): UpdateIcon | null {
  if (!desktop) return null;
  if (installing || status?.installing === true) return icon("updating", "Closing to update…", null);
  if (checking) return icon("checking", "Checking for updates…", null);
  if (clickError !== null && !outdated(clickError, status?.lastCheck)) return icon("failed", clickError.click === "check" ? NOT_CHECKED : "Download failed", "check");
  const retry: UpdateClick = fresh(status)
    ? "update"
    : canRestart && status?.lastCheck?.state === "newer" && status.lastCheck.restart === true
      ? "restart"
      : "check";
  if (error !== null) return icon("failed", FAILED, retry);
  const result = status?.result;
  if (result && result.outcome !== "updated") {
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
      return installedIcon(check, canRestart, downloading);
    case "cannot-check":
      return blockedIcon(check);
  }
}
