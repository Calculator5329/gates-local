// Behavior adapted from T3 Code DesktopWindow.ts at d137c5081ac5efb2b8ea9aec8b334e1bb4d0182a (MIT).
import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

/** T3 keeps the four editing roles visible and disables those that do not apply. */
export function editMenu(params: { editFlags: Pick<ContextMenuParams["editFlags"], "canCut" | "canCopy" | "canPaste" | "canSelectAll"> }): MenuItemConstructorOptions[] {
  const flags = params.editFlags;
  return [
    { role: "cut", enabled: flags.canCut },
    { role: "copy", enabled: flags.canCopy },
    { role: "paste", enabled: flags.canPaste },
    { role: "selectAll", enabled: flags.canSelectAll },
  ];
}
