import { isTouch } from "../lib/ui/ui.tsx";
import { requestFocus } from "../lib/ui/kit/focus.ts";

// external: a phone browser opens the on-screen keyboard when a textarea takes focus
export function focusComposer(force = false): void {
  if (!force && isTouch()) return;
  requestFocus("#ta");
}
