// Rare install interaction, loaded on click while the shell reserves the UI action.
//
// A clone installs a checked commit; an installed copy restarts into the
// version it downloaded and checked. Both reserve the server's approval and
// hand the desktop app the exact target the server pinned: the commit, or
// `<version>:<SHA-512 of the signed list>`.
import type { UpdateCheck, UpdateInstallRequest, UpdateStatus } from "@gates-local/contracts";
import type { ActionCall, ActionResult } from "./session/connection.ts";
import type { setState } from "./store.ts";
import { updateWork, workLines } from "./update-work.ts";

type StartUpdate = (request: UpdateInstallRequest) => Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;

/** What the click would install, and whether the server's target matches it. */
interface Offer {
  /** The version or commit the person saw. */
  readonly seen: string;
  readonly ask: string;
  readonly matches: (target: string) => boolean;
}

function offerOf(status: UpdateStatus): Offer | undefined {
  const check = status.lastCheck;
  if (status.approval === undefined) return undefined;
  if (check?.state === "available" && check.targetCommit !== undefined) {
    const commit = check.targetCommit;
    return {
      seen: commit,
      ask: `Update to ${check.target} (${commit}) and restart Gates Local?\n\n${check.notes ?? check.changes.slice(0, 3).join("\n")}`,
      matches: (target) => target === commit,
    };
  }
  if (check?.state === "newer" && check.restart === true) {
    const version = check.target;
    return { seen: version, ask: `Restart Gates Local to update to version ${version}?\n\nGates Local will close, update and reopen.`, matches: (target) => target.startsWith(`${version}:`) };
  }
  return undefined;
}

/** Why there is nothing to install: the server's own words when it has some. */
function nothing(check: UpdateCheck | null): string {
  if (check?.state === "cannot-check" || (check?.state === "newer" && check.lines.length > 0)) return check.lines.join(" ");
  return "Check for updates and review the target before installing.";
}

export async function installUpdate(act: ActionCall, start: StartUpdate, prior: string | undefined, applyServerEvent: typeof setState, approved?: string): Promise<ActionResult> {
  let error: string | null = null;
  let accepted = false;
  let reservation: string | undefined;
  let installed = false;
  try {
    const status = await act("update.status", {}, "check running work before updating");
    if (!status.ok) { error = status.message; return error; }
    let snapshot = status.value;
    if (snapshot.installing === true) { error = "Gates Local is already closing to update. Try again after it reopens."; return error; }
    installed = snapshot.version.kind === "installed";
    // A clone checks first; an installed copy's approval comes only with its checked download.
    if (!installed && offerOf(snapshot) === undefined) {
      const checked = await act("update.check", {}, "check the update target");
      if (!checked.ok) { error = checked.message; return error; }
      const refreshed = await act("update.status", {}, "read the checked update target");
      if (!refreshed.ok) { error = refreshed.message; return error; }
      snapshot = refreshed.value;
    }
    let changed = prior !== offerOf(snapshot)?.seen;
    for (;;) {
      applyServerEvent({ update: snapshot });
      const offer = offerOf(snapshot);
      if (offer === undefined || snapshot.approval === undefined) {
        error = nothing(snapshot.lastCheck);
        return error;
      }
      // The footer asked once, for this approval: if the server's moved on, nothing installs and its ask shows the new words.
      if (approved !== undefined && snapshot.approval !== approved) return null;
      const work = updateWork(snapshot.activity);
      // the footer's ask's lines (update-work.ts), so both say the same once; it asks only when something
      // running would stop, or the target changed since the person saw it (decision 23)
      const stops = (snapshot.activity?.length ?? 1) > 0;
      if (approved === undefined && (changed || stops) && !window.confirm([offer.ask, ...(work?.length === 0 ? [] : ["", ...workLines(work)])].join("\n"))) return null;
      const prepared = await act("update.prepare", { approval: snapshot.approval }, "reserve the approved update");
      if (!prepared.ok) { error = prepared.message; return error; }
      if (prepared.value.state === "blocked") { error = prepared.value.message; return error; }
      if (prepared.value.state === "changed") { snapshot = prepared.value.status; changed = true; continue; }
      reservation = prepared.value.reservation;
      if (!offer.matches(prepared.value.target)) { error = "The approved update target changed. Check for updates again before installing."; return error; }
      const result = await start({ reservation, target: prepared.value.target });
      accepted = result.ok;
      error = result.ok ? null : result.message;
      return error;
    }
  } catch (cause) {
    const instead = installed ? "Try Restart to update again." : "Run pnpm run app-update in the Gates Local folder instead.";
    error = `Couldn't start the update (${cause instanceof Error ? cause.message : String(cause)}). ${instead}`;
    return error;
  } finally {
    if (!accepted) {
      if (reservation !== undefined) await act("update.cancel", { reservation }, "release the update reservation");
      applyServerEvent({ updateInstalling: false, updateError: error });
    }
  }
}
