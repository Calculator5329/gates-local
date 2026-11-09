import { randomUUID } from "node:crypto";

export const HANDOFF_GRACE_MS = 5_000;

export const UPDATE_PAUSED = "Gates Local is closing to update. New replies, image jobs, model downloads and imports are paused. Try again after it reopens.";

export function createUpdateAdmission() {
  let revision = 0;
  let closed = false;
  let lease: { token: string; targetCommit: string; committed: boolean; detach?: () => void } | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const cancel = (token: string) => {
    if (closed || lease?.token !== token) return false;
    clearTimeout(expiry);
    lease.detach?.();
    lease = undefined;
    notify();
    return true;
  };
  const expire = (token: string, ms = 30_000) => {
    clearTimeout(expiry);
    expiry = setTimeout(() => cancel(token), ms);
    expiry.unref?.();
  };
  return {
    /** Called synchronously before a producer registers work or reaches its first await. */
    admit() {
      if (closed || lease !== undefined) throw Object.assign(new Error(UPDATE_PAUSED), { code: "update-installing" });
      revision++;
    },
    revision: () => revision,
    installing: () => lease !== undefined,
    reserve(targetCommit: string) {
      if (closed || lease !== undefined) throw new Error(UPDATE_PAUSED);
      const token = randomUUID();
      lease = { token, targetCommit, committed: false };
      // A renderer that disappears before handing off cannot strand admission.
      expire(token);
      notify();
      return token;
    },
    commit(token: string, targetCommit: string, release: string, disconnected?: AbortSignal) {
      if (lease?.token !== token || lease.targetCommit !== targetCommit || lease.committed || release === "" || release === token) return null;
      // Transfer cancellation authority to main. A late renderer cancellation
      // must not reopen admission after main has started the detached updater.
      lease.token = release;
      lease.committed = true;
      // Main already knows this capability even if its reply is lost. Only
      // explicit failure cancellation or server exit releases a committed install.
      clearTimeout(expiry);
      if (disconnected) {
        // Main normally quits immediately after handoff. If it disconnects
        // but stays open, the detached updater is still waiting for its PID;
        // let normal work resume instead of stranding every client.
        const lost = () => expire(release, HANDOFF_GRACE_MS);
        if (disconnected.aborted) lost();
        else {
          disconnected.addEventListener("abort", lost, { once: true });
          lease.detach = () => disconnected.removeEventListener("abort", lost);
        }
      }
      return lease.token;
    },
    cancel,
    close() { closed = true; clearTimeout(expiry); lease?.detach?.(); },
    onChange(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

export type UpdateAdmission = ReturnType<typeof createUpdateAdmission>;
