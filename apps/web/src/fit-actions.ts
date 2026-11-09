import { cancelPendingSettings, openSettings } from "./session.ts";
import { getState, setState } from "./store.ts";
import { anchorOf, closeTip, isPhone } from "./ui.tsx";

/** The composer can open memory controls without loading the panel's UI. */
export function openFit(model?: string): void {
  const s = getState();
  closeTip();
  setState({ pop: null, fitPanel: { open: s.fitPanel.open, model: model !== undefined && model !== s.model ? model : null } });
  openSettings("advanced");
}

export function openGpuPanel(): void {
  cancelPendingSettings();
  closeTip();
  setState({ pop: null, fitPanel: { open: true, model: null } });
  requestAnimationFrame(() => document.querySelector<HTMLElement>("#fitPanel .fpn-x")?.focus());
}

export function closeGpuPanel(refocus: boolean): void {
  if (!getState().fitPanel.open) return;
  cancelPendingSettings();
  closeTip();
  setState({ fitPanel: { open: false, model: null } });
  if (!refocus) return;
  if (isPhone()) requestAnimationFrame(focusAfterClose);
  else focusAfterClose();
}

function focusAfterClose(): void {
  (anchorOf("more") ?? document.getElementById("ta"))?.focus();
}
