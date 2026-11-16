import { useLayoutEffect } from "react";
import { type CommitJob, setState, useStore } from "../../store/store.ts";

export type FocusTarget = string | (() => HTMLElement | null | undefined);

const find = (target: FocusTarget): HTMLElement | null =>
  (typeof target === "string" ? document.querySelector<HTMLElement>(target) : target()) ?? null;

const done = new WeakSet<CommitJob>();

const unqueue = (jobs: readonly CommitJob[]) => setState((s) => ({ afterCommit: s.afterCommit.filter((job) => !jobs.includes(job)) }));

export function afterCommit(job: CommitJob): void {
  setState((s) => ({ afterCommit: [...s.afterCommit, job] }));
  // oxlint-disable-next-line gates/timer-needs-reason -- the frame the old hand-written focus calls waited: the last try for a job whose node no commit drew yet
  requestAnimationFrame(() => {
    if (done.has(job)) return;
    done.add(job);
    unqueue([job]);
    job();
  });
}

export function requestFocus(target: FocusTarget, options?: FocusOptions): void {
  afterCommit(() => {
    const el = find(target);
    if (el === null) return false;
    el.focus(options);
    return true;
  });
}

// why: made once at module level, the ref keeps one identity, so React never calls it again
export const focusOnDraw = (el: HTMLElement | null): void => {
  el?.focus();
};

export function focusFirstOf(...selectors: string[]): (el: HTMLElement | null) => void {
  return (el) => {
    if (el === null) return;
    for (const selector of selectors) {
      const hit = el.querySelector<HTMLElement>(selector);
      if (hit !== null) return hit.focus();
    }
  };
}

export function CommitJobs(): null {
  const jobs = useStore((s) => s.afterCommit);
  // oxlint-disable-next-line gates/effect-needs-reason -- runs focus and scroll requests against the DOM this commit drew; the one place that does
  useLayoutEffect(() => {
    if (jobs.length === 0) return;
    unqueue(jobs);
    for (const job of jobs) {
      if (done.has(job)) continue;
      if (job() !== false) done.add(job);
    }
  }, [jobs]);
  return null;
}
