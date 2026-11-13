import type { UpdatePreparation, UpdateStatus } from "@gates-local/contracts";

const IDLE: UpdateStatus = { version: { kind: "commit", commit: "abc1234" }, result: null, lastCheck: null, activity: [] };
// A check of the channel the test server's switch follows (releases), as a real server's would be: Settings shows only that one.
const AVAILABLE: UpdateStatus = { ...IDLE, lastCheck: { state: "available", checkedAt: 1, current: "abc1234", target: "def5678", targetCommit: `def5678${"0".repeat(33)}`, channel: "release", total: 1, changes: ["Faster chat"] } };

/** One fixture owner for both announced state and subsequent RPC reads. */
export function updateFixtureState() {
  let current = IDLE;
  let activity: readonly string[] = [];
  let revision = 0;
  const status = (): UpdateStatus => ({ ...current, activity, ...(current.lastCheck?.state === "available" ? { approval: `fixture-${revision}` } : {}) });
  return {
    status,
    show: () => { current = AVAILABLE; return { ...current, activity, approval: `fixture-${revision}` }; },
    notice: () => { current = { ...IDLE, result: { at: 1, outcome: "updated", line: "Updated to the approved commit." } }; return status(); },
    failure: () => { current = { ...IDLE, result: { at: 1, outcome: "stopped", line: `The update stopped at ${"stack_frame_".repeat(80)}. The previous version is restored.`, logPath: `/srv/updates/${"long-folder/".repeat(32)}failure.log` } }; return status(); },
    dismiss: () => { current = { ...current, result: null }; return { dismissed: true }; },
    work: (items: readonly string[]) => { activity = items; revision++; },
    prepare: (approval: string): UpdatePreparation => {
      const latest = status();
      if (latest.approval !== approval || latest.lastCheck?.state !== "available" || latest.lastCheck.targetCommit === undefined) return { state: "changed", status: latest };
      return { state: "ready", reservation: "fixture-reservation", target: latest.lastCheck.targetCommit };
    },
  };
}
