import { expect, it } from "vitest";
import { editMenu } from "./context-menu.ts";

it("keeps T3's native roles visible with the actual edit flags", () => {
  const flags = { canCut: false, canCopy: false, canPaste: true, canSelectAll: true };
  expect(editMenu({ editFlags: flags })).toEqual([{ role: "cut", enabled: false }, { role: "copy", enabled: false }, { role: "paste", enabled: true }, { role: "selectAll", enabled: true }]);
  expect(editMenu({ editFlags: { ...flags, canCopy: true, canCut: true } }).every(item => item.enabled)).toBe(true);
});
