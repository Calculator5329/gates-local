// The update card's words the packaged probes wait for, read from the code
// that says them, so a probe never holds a copy of a sentence that has moved.
// A checked download's line comes from the server (downloadLines), the
// footer's name from the sidebar (updateIcon).
import { expect, type Locator } from "@playwright/test";
import type { UpdateStatus } from "@gates-local/contracts";
import { downloadLines, type Restart } from "@gates-local/update/installed/copy";
import { updateIcon } from "../../apps/web/src/updates/update-state.ts";

/**
 * The line a copy shows once a download is checked. restart is what this copy
 * can do with it (replaceability: "yes" and "windows" restart into it, every
 * other value says why the person puts it in place); program is the running
 * AppImage the server names, or null.
 */
export function downloadedLine(version: string, restart: Restart = "yes", program: string | null = null, platform: string = process.platform): string {
  const line = downloadLines(version, { state: "ready" }, restart, undefined, platform, program)[0];
  if (line === undefined) throw new Error(`no line for a checked download of ${version}`);
  return line;
}

/** The footer's name for this status, on a copy that cannot restart into its download. */
export const footerName = (status: UpdateStatus | null): string | null => updateIcon({ status, desktop: true })?.label ?? null;

/** The one next step a checked download offers: Restart to update, or Open folder for a copy that keeps the file. */
export const nextStep = (group: Locator, next: "restart" | "folder") =>
  group.getByRole("button", { name: next === "restart" ? "Restart to update" : "Open folder", exact: true });

/**
 * Waits for a checked download to settle: its line is there and its next step
 * is enabled. A Windows card says Checking… with Restart greyed while it looks
 * for the go-back installer, so a probe that read it at once would read that.
 * Returns the group's text once settled.
 */
export async function settledDownload(group: Locator, line: string, next: "restart" | "folder", timeoutMs = 180_000): Promise<string> {
  // innerText: the card keeps the line hidden under Checking… to hold its size, and the hidden copy does not count.
  await expect(group).toContainText(line, { timeout: timeoutMs, useInnerText: true });
  await expect(nextStep(group, next)).toBeEnabled({ timeout: 60_000 });
  return await group.innerText();
}
