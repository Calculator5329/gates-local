import type { UpdateStatus } from "@gates-local/contracts";

export type UpdateButton = { state: "available" | "installing" | "failed"; label: string; detail: string; disabled: boolean };

/** Sidebar and Settings share this presentation and session's single install action. */
export function updateButton(status: UpdateStatus | null, desktop: boolean, installing = false, error: string | null = null): UpdateButton | null {
  if (!desktop) return null;
  if (installing || status?.installing === true) return { state: "installing", label: "Closing to update…", detail: "Gates Local closes while dependencies install and the app builds, then opens again.", disabled: true };
  if (error !== null) return { state: "failed", label: "Retry update", detail: error, disabled: false };
  const result = status?.result;
  if (result && result.outcome !== "updated") return { state: "failed", label: "Retry update", detail: [result.line, result.logPath && `Full log: ${result.logPath}`, ...result.commands ?? []].filter(Boolean).join("\n"), disabled: false };
  const check = status?.lastCheck;
  if (check?.state === "available") return { state: "available", label: `Update ${check.target}`, detail: ["Update and restart", check.notes ?? check.changes.join("\n")].join("\n"), disabled: false };
  return null;
}
