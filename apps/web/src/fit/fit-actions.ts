import { openSettings } from "../lib/session/index.ts";
import { getState, setState } from "../lib/store/store.ts";
import { closeTip } from "../lib/ui/ui.tsx";

/** The composer can open memory controls without loading the panel's UI. */
export function openFit(model?: string): void {
  const s = getState();
  closeTip();
  setState({ pop: null, fitPanel: { model: model !== undefined && model !== s.model ? model : null } });
  openSettings("advanced");
}
