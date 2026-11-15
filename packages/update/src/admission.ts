import { randomUUID } from "node:crypto";

export const HANDOFF_GRACE_MS = 5_000;

export const UPDATE_PAUSED = "Gates Local is closing to update. New replies, image jobs, model downloads and imports are paused. Try again after it reopens.";

/** An installed copy's update startup (docs/design/installed-updates.md, "Update startup"): every write waits for the result. */
export const FINISHING = "Gates Local is finishing an update. Try again in a moment.";

/**
 * `finishing`: this server is a token launch of an installed update. Admission
 * stays closed, with its own sentence, until `open()`, which the caller calls
 * once it reads a result carrying its token.
 */
export function createUpdateAdmission(o: { readonly finishing?: boolean } = {}) {
  let revision = 0;
  let closed = false;
  let finishing = o.finishing === true;
  // target: a clone's commit, or an installed copy's pinned artifact identity.
  let lease: { token: string; target: string; committed: boolean; detach?: () => void } | undefined;
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
      if (finishing && !closed) throw Object.assign(new Error(FINISHING), { code: "update-finishing" });
      if (closed || lease !== undefined) throw Object.assign(new Error(UPDATE_PAUSED), { code: "update-installing" });
      revision++;
    },
    revision: () => revision,
    installing: () => lease !== undefined,
    finishing: () => finishing,
    /** The update startup's result carried this launch's token: writes go through from now on. */
    open() {
      if (!finishing) return;
      finishing = false;
      notify();
    },
    reserve(target: string) {
      if (finishing && !closed) throw new Error(FINISHING);
      if (closed || lease !== undefined) throw new Error(UPDATE_PAUSED);
      const token = randomUUID();
      lease = { token, target, committed: false };
      // A renderer that disappears before handing off cannot strand admission.
      expire(token);
      notify();
      return token;
    },
    commit(token: string, target: string, release: string, disconnected?: AbortSignal) {
      if (lease?.token !== token || lease.target !== target || lease.committed || release === "" || release === token) return null;
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
