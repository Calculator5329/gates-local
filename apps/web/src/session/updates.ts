// Update status, receipt ordering and the desktop action. The installer stays
// deferred until approval; server-derived state uses the shared projection.
import type { UpdateStatus } from "@gates-local/contracts";
import { newestOnly } from "../pick.ts";
import { getState, NA, setState } from "../store.ts";
import type { ActionCall, ActionResult } from "./connection.ts";

export function createUpdates({ applyServerEvent, act }: { readonly applyServerEvent: typeof setState; readonly act: ActionCall }) {
  const updateOrder = newestOnly();

  function receiveUpdate(update: UpdateStatus): void {
    applyServerEvent(s => {
      const known = s.update === undefined || s.update === NA ? undefined : s.update;
      // a check that answered anywhere since (hourly, Settings, another window) clears a failed install's words, unless an install runs
      const before = known?.lastCheck?.checkedAt;
      const answered = update.lastCheck != null && (before === undefined || update.lastCheck.checkedAt > before);
      const clear = answered && !s.updateInstalling && update.installing !== true && s.updateError !== null;
      return { update: known?.canControl === false ? { ...update, canControl: false } : update, ...(clear ? { updateError: null } : {}) };
    });
  }

  /** Manual checks share the desktop server's checked target and activity. */
  async function checkForUpdates(): Promise<ActionResult> {
    if (getState().updateChecking || getState().updateInstalling) return null;
    setState({ updateChecking: true });
    const r = await act("update.check", {}, "check for updates");
    applyServerEvent((s) => {
      if (r.ok && s.update !== undefined && s.update !== NA) {
        updateOrder.next();
        // a check that answered clears a failed install click's stale words
        return { updateChecking: false, updateError: null, update: { ...s.update, lastCheck: r.value } };
      }
      return { updateChecking: false };
    });
    return r.ok ? null : r.message;
  }

  /** An installed copy's Download click: the server answers with the check, now downloading; progress follows as update.changed. */
  async function downloadUpdate(): Promise<ActionResult> {
    const r = await act("update.download", {}, "download the update");
    if (!r.ok) return r.message;
    applyServerEvent((s) => {
      if (s.update === undefined || s.update === NA) return {};
      updateOrder.next();
      return { update: { ...s.update, lastCheck: r.value } };
    });
    return null;
  }

  /** A phone dismisses its own note without writing through the desktop listener. */
  async function dismissUpdateResult(): Promise<void> {
    const current = getState().update;
    applyServerEvent((s) => {
      if (s.update === undefined || s.update === NA) return {};
      updateOrder.next();
      return { update: { ...s.update, result: null } };
    });
    if (current !== undefined && current !== NA && current.canControl === false) return;
    await act("update.dismissResult", {}, "hide the update note");
  }

  /** Re-read the status (target, approval and running work) for an ask that is about to show it. */
  async function readUpdateStatus(): Promise<ActionResult> {
    const r = await act("update.status", {}, "read what an update would stop");
    if (!r.ok) return r.message;
    updateOrder.next();
    receiveUpdate(r.value);
    return null;
  }

  /**
   * Reserve once locally, then load the existing checked-commit installer.
   * approved: the server approval the footer's ask showed; that ask was the
   * only one, and if the approval moved on nothing installs (the ask shows the
   * new words). Without it, the installer asks natively as before.
   */
  async function updateAndRestart(approved?: string): Promise<ActionResult> {
    const bridge = window.gatesLocal;
    if (bridge?.updateAndRestart === undefined) return "Updating from here needs the desktop app. Run pnpm run app-update in the Gates Local folder instead.";
    if (bridge.updateApprovalVersion !== 2) return "Close and reopen Gates Local before using this update button, or run pnpm run app-update in its folder.";
    if (getState().updateInstalling) return null;
    const before = getState().update;
    const check = before === NA ? undefined : before?.lastCheck;
    // What the person last saw: a clone's commit, or an installed copy's version.
    const prior = check?.state === "available" ? check.targetCommit : check?.state === "newer" ? check.target : undefined;
    setState({ updateInstalling: true, updateError: null });
    try {
      const { installUpdate } = await import("../update-install.ts");
      return await installUpdate(act, bridge.updateAndRestart, prior, applyServerEvent, approved);
    } catch (error) {
      const message = `Couldn't load the update action (${error instanceof Error ? error.message : String(error)}). Reload Gates Local and try again.`;
      applyServerEvent({ updateInstalling: false, updateError: message });
      return message;
    }
  }

  return { updateOrder, receiveUpdate, checkForUpdates, downloadUpdate, dismissUpdateResult, readUpdateStatus, updateAndRestart };
}
