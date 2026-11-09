// Rare install interaction, loaded on click while the shell reserves the UI action.
import type { UpdateInstallRequest } from "@gates-local/contracts";
import type { ActionCall, ActionResult } from "./session/connection.ts";
import { getState, setState } from "./store.ts";

type StartUpdate = (request: UpdateInstallRequest) => Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;

export async function installUpdate(act: ActionCall, start: StartUpdate, priorCommit: string | undefined, applyServerEvent: typeof setState): Promise<ActionResult> {
  let error: string | null = null;
  let accepted = false;
  let reservation: string | undefined;
  try {
    const status = await act("update.status", {}, "check running work before updating");
    if (!status.ok) { error = status.message; return error; }
    let snapshot = status.value;
    if (snapshot.installing === true) { error = "Gates Local is already closing to update. Try again after it reopens."; return error; }
    if (snapshot.approval === undefined || snapshot.lastCheck?.state !== "available" || snapshot.lastCheck.targetCommit === undefined) {
      const checked = await act("update.check", {}, "check the update target");
      if (!checked.ok) { error = checked.message; return error; }
      const refreshed = await act("update.status", {}, "read the checked update target");
      if (!refreshed.ok) { error = refreshed.message; return error; }
      snapshot = refreshed.value;
    }
    let changed = priorCommit !== (snapshot.lastCheck?.state === "available" ? snapshot.lastCheck.targetCommit : undefined);
    for (;;) {
      applyServerEvent({ update: snapshot });
      const check = snapshot.lastCheck;
      if (snapshot.approval === undefined || check?.state !== "available" || check.targetCommit === undefined) {
        error = check?.state === "cannot-check" ? check.lines.join(" ") : "Check for updates and review the target before installing.";
        return error;
      }
      const work = [...snapshot.activity ?? [], ...(getState().queued.length ? ["queued messages in this window"] : []), ...(getState().draft.trim() ? ["the unsent draft in this window"] : [])];
      if ((changed || work.length > 0 || snapshot.activity === undefined) && !window.confirm(`Update to ${check.target} (${check.targetCommit}) and restart Gates Local?\n\n${check.notes ?? check.changes.slice(0, 3).join("\n")}\n\n${work.length ? `This interrupts:\n${work.join("\n")}` : "No running work was found."}\n\nReplies written so far are kept as interrupted. Downloaded model parts are kept; start the download again to resume. Image jobs stop. Save unsent drafts and queued messages before continuing.\n\nThe window closes during install and build, then opens again.`)) return null;
      const prepared = await act("update.prepare", { approval: snapshot.approval }, "reserve the approved update");
      if (!prepared.ok) { error = prepared.message; return error; }
      if (prepared.value.state === "blocked") { error = prepared.value.message; return error; }
      if (prepared.value.state === "changed") { snapshot = prepared.value.status; changed = true; continue; }
      reservation = prepared.value.reservation;
      if (prepared.value.targetCommit !== check.targetCommit) { error = "The approved update target changed. Check for updates again before installing."; return error; }
      const result = await start({ reservation, targetCommit: prepared.value.targetCommit });
      accepted = result.ok;
      error = result.ok ? null : result.message;
      return error;
    }
  } catch (cause) {
    error = `Couldn't start the update (${cause instanceof Error ? cause.message : String(cause)}). Run pnpm run app-update in the Gates Local folder instead.`;
    return error;
  } finally {
    if (!accepted) {
      if (reservation !== undefined) await act("update.cancel", { reservation }, "release the update reservation");
      applyServerEvent({ updateInstalling: false, updateError: error });
    }
  }
}
