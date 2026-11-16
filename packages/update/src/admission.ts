import { randomUUID } from "node:crypto";
import { brokenForTest } from "./break-for-test.ts";

export const HANDOFF_GRACE_MS = 5_000;

export const UPDATE_PAUSED = "Gates Local is closing to update. New replies, image jobs, model downloads and imports are paused. Try again after it reopens.";

/** An installed copy's update startup (docs/design/installed-updates.md, "Update startup"): every write waits for the result. */
export const FINISHING = "Gates Local is finishing an update. Try again in a moment.";

/**
 * `finishing`: this server is a token launch of an installed update. Admission
 * stays closed, with its own sentence, until `open()`, which the caller calls
 * once it reads a result carrying its token. A producer calls `admit()`
 * synchronously, before it registers work or reaches its first await.
 */
export function createUpdateAdmission(o: { readonly finishing?: boolean } = {}) {
  let revision = 0;
  let closed = false;
  let finishing = o.finishing === true;
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
    admit() {
      if (finishing && !closed) throw Object.assign(new Error(FINISHING), { code: "update-finishing" });
      const held = lease !== undefined && !(brokenForTest("reservation-lets-work-in") && !lease.committed);
      if (closed || held) throw Object.assign(new Error(UPDATE_PAUSED), { code: "update-installing" });
      revision++;
    },
    revision: () => revision,
    installing: () => lease !== undefined,
    finishing: () => finishing,
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
      expire(token);
      notify();
      return token;
    },
    commit(token: string, target: string, release: string, disconnected?: AbortSignal, graceMs = HANDOFF_GRACE_MS) {
      if (lease?.token !== token || lease.target !== target || lease.committed || release === "" || release === token) return null;
      if (!brokenForTest("commit-leaves-the-window-its-key")) lease.token = release;
      lease.committed = true;
      clearTimeout(expiry);
      if (disconnected) {
        const lost = () => expire(release, brokenForTest("grace-is-the-short-one") ? HANDOFF_GRACE_MS : graceMs);
        if (disconnected.aborted) lost();
        else {
          disconnected.addEventListener("abort", lost, { once: true });
          lease.detach = () => disconnected.removeEventListener("abort", lost);
        }
      }
      return release;
    },
    cancel,
    close() { closed = true; clearTimeout(expiry); lease?.detach?.(); },
    onChange(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

export type UpdateAdmission = ReturnType<typeof createUpdateAdmission>;
