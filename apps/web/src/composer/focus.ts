import { isTouch } from "../lib/ui/ui.tsx";

/** Put the cursor in the message box. On touch only when asked (force): focus there pops the keyboard. */
export function focusComposer(force = false): void {
  if (!force && isTouch()) return;
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("#ta")?.focus());
}
