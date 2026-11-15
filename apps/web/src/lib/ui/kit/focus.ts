// Focus and other DOM work that must wait until React has drawn the node it acts on. A caller says
// what it wants (`requestFocus("#searchIn")`); the request rides in the store with the state change
// that draws the node, and <CommitJobs />, the last thing App draws, runs it once that commit is in
// the DOM. Each request also holds one frame: a node that commit did not draw (a screen still
// loading) gets its last try then, so a request is never later than a frame, even with nothing
// drawing.
import { useLayoutEffect } from "react";
import { type CommitJob, setState, useStore } from "../../store/store.ts";

/** A CSS selector, or a function that finds the node (null when there is nothing to act on). */
export type FocusTarget = string | (() => HTMLElement | null | undefined);

const find = (target: FocusTarget): HTMLElement | null =>
  (typeof target === "string" ? document.querySelector<HTMLElement>(target) : target()) ?? null;

/** Jobs that ran and are finished; a job that missed its node is not here until its frame. */
const done = new WeakSet<CommitJob>();

const unqueue = (jobs: readonly CommitJob[]) => setState((s) => ({ afterCommit: s.afterCommit.filter((job) => !jobs.includes(job)) }));

/** Run `job` after the next commit, or a frame later when it returns false. Jobs run in the order they were asked for. */
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

/** Move focus to `target` once the commit that draws it is in the DOM. */
export function requestFocus(target: FocusTarget, options?: FocusOptions): void {
  afterCommit(() => {
    const el = find(target);
    if (el === null) return false;
    el.focus(options);
    return true;
  });
}

/**
 * A ref callback that focuses its node as React draws it, and only then: made once at module level,
 * it keeps one identity, so a later render does not call it again and take focus back.
 */
export const focusOnDraw = (el: HTMLElement | null): void => {
  el?.focus();
};

/** As focusOnDraw, for the first node inside that matches the first selector that matches anything. */
export function focusFirstOf(...selectors: string[]): (el: HTMLElement | null) => void {
  return (el) => {
    if (el === null) return;
    for (const selector of selectors) {
      const hit = el.querySelector<HTMLElement>(selector);
      if (hit !== null) return hit.focus();
    }
  };
}

/** Runs the store's after-commit work. Mount once, as the last child of the app. */
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
