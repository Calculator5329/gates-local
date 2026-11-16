import type { SyncMetadata, UpdateStatus } from "@gates-local/contracts";
import { getState, NA, setState } from "../lib/store/store.ts";
import type { ActionCall, ActionResult } from "../lib/session/connection.ts";

interface UpdatesDeps {
  readonly applyServerEvent: typeof setState;
  readonly act: ActionCall;
  readonly newer: (sync: SyncMetadata | undefined) => boolean;
}

export function createUpdates({ applyServerEvent, act, newer }: UpdatesDeps) {
  function receiveUpdate(update: UpdateStatus): void {
    applyServerEvent(s => {
      const known = s.update === undefined || s.update === NA ? undefined : s.update;
      const before = known?.lastCheck?.checkedAt;
      const answered = update.lastCheck != null && (before === undefined || update.lastCheck.checkedAt > before);
      const clear = answered && !s.updateInstalling && update.installing !== true && s.updateError !== null;
      return { update: known?.canControl === false ? { ...update, canControl: false } : update, ...(clear ? { updateError: null } : {}) };
    });
  }
  const answered = { onResult: (update: UpdateStatus, sync: SyncMetadata | undefined) => { if (newer(sync)) receiveUpdate(update); } };

  async function checkForUpdates(): Promise<ActionResult> {
    if (getState().updateChecking || getState().updateInstalling) return null;
    setState({ updateChecking: true });
    const r = await act("update.check", {}, "check for updates", "try again", answered);
    applyServerEvent(r.ok ? { updateChecking: false, updateError: null } : { updateChecking: false });
    return r.ok ? null : r.message;
  }

  async function downloadUpdate(): Promise<ActionResult> {
    const r = await act("update.download", {}, "download the update", "try again", answered);
    return r.ok ? null : r.message;
  }

  async function dismissUpdateResult(): Promise<void> {
    const current = getState().update;
    if (current !== undefined && current !== NA && current.canControl === false) {
      applyServerEvent({ update: { ...current, result: null } });
      return;
    }
    await act("update.dismissResult", {}, "hide the update note", "try again", answered);
  }

  async function readUpdateStatus(): Promise<ActionResult> {
    const r = await act("update.status", {}, "read what an update would stop", "try again", answered);
    return r.ok ? null : r.message;
  }

  async function updateAndRestart(approved?: string): Promise<ActionResult> {
    const bridge = window.gatesLocal;
    if (bridge?.updateAndRestart === undefined) return "Updating from here needs the desktop app. Run pnpm run app-update in the Gates Local folder instead.";
    if (bridge.updateApprovalVersion !== 2) return "Close and reopen Gates Local before using this update button, or run pnpm run app-update in its folder.";
    if (getState().updateInstalling) return null;
    const before = getState().update;
    const check = before === NA ? undefined : before?.lastCheck;
    const prior = check?.state === "available" ? check.targetCommit : check?.state === "newer" ? check.target : undefined;
    setState({ updateInstalling: true, updateError: null });
    try {
      const { installUpdate } = await import("./update-install.ts");
      return await installUpdate(act, bridge.updateAndRestart, prior, applyServerEvent, approved);
    } catch (error) {
      const message = `Couldn't load the update action (${error instanceof Error ? error.message : String(error)}). Reload Gates Local and try again.`;
      applyServerEvent({ updateInstalling: false, updateError: message });
      return message;
    }
  }

  return { receiveUpdate, checkForUpdates, downloadUpdate, dismissUpdateResult, readUpdateStatus, updateAndRestart };
}
