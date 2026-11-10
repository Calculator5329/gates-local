// Update status, receipt ordering and the desktop action. The installer stays
// deferred until approval; server-derived state uses the shared projection.
import type { UpdateStatus } from "@gates-local/contracts";
import { newestOnly } from "../pick.ts";
import { getState, NA, setState } from "../store.ts";
import type { ActionCall, ActionResult } from "./connection.ts";

export function createUpdates({ applyServerEvent, act }: { readonly applyServerEvent: typeof setState; readonly act: ActionCall }) {
  const updateOrder = newestOnly();

  function receiveUpdate(update: UpdateStatus): void {
    applyServerEvent(s => ({ update: s.update !== undefined && s.update !== NA && s.update.canControl === false ? { ...update, canControl: false } : update }));
  }

  /** Manual checks share the desktop server's checked target and activity. */
  async function checkForUpdates(): Promise<ActionResult> {
    if (getState().updateChecking || getState().updateInstalling) return null;
    setState({ updateChecking: true });
    const r = await act("update.check", {}, "check for updates");
    applyServerEvent((s) => {
      if (r.ok && s.update !== undefined && s.update !== NA) {
        updateOrder.next();
        return { updateChecking: false, update: { ...s.update, lastCheck: r.value } };
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

  /** Reserve once locally, then load the existing checked-commit installer. */
  async function updateAndRestart(): Promise<ActionResult> {
    const bridge = window.gatesLocal;
    if (bridge?.updateAndRestart === undefined) return "Updating from here needs the desktop app. Run pnpm run app-update in the Gates Local folder instead.";
    if (bridge.updateApprovalVersion !== 1) return "Close and reopen Gates Local before using this update button, or run pnpm run app-update in its folder.";
    if (getState().updateInstalling) return null;
    const before = getState().update;
    const priorCommit = before !== NA && before?.lastCheck?.state === "available" ? before.lastCheck.targetCommit : undefined;
    setState({ updateInstalling: true, updateError: null });
    try {
      const { installUpdate } = await import("../update-install.ts");
      return await installUpdate(act, bridge.updateAndRestart, priorCommit, applyServerEvent);
    } catch (error) {
      const message = `Couldn't load the update action (${error instanceof Error ? error.message : String(error)}). Reload Gates Local and try again.`;
      applyServerEvent({ updateInstalling: false, updateError: message });
      return message;
    }
  }

  return { updateOrder, receiveUpdate, checkForUpdates, downloadUpdate, dismissUpdateResult, updateAndRestart };
}
