// The score and the part counts of a measure, and the grading of its pages once a window has run
// them. The score is one number out of 100: each part's share of its checks passed, weighted by
// WEIGHTS, over the parts that have a graded check. A check still waiting for a window, or skipped
// because this machine cannot run it, counts for nothing either way.
import type { MeasureCheck, MeasurePartCount, ModelMeasure, PageSeen } from "@gates-local/contracts";
import { CASES, PARTS, WEIGHTS } from "./cases.ts";

const partOf = new Map(CASES.map((c) => [c.id, c.part]));
const graded = (c: MeasureCheck) => c.state === undefined;

export function partsOf(checks: readonly MeasureCheck[]): MeasurePartCount[] {
  return PARTS.flatMap((part) => {
    const mine = checks.filter((c) => partOf.get(c.id) === part && graded(c));
    return mine.length ? [{ part, passed: mine.filter((c) => c.ok).length, total: mine.length, weight: WEIGHTS[part] }] : [];
  });
}

export function scoreOf(parts: readonly MeasurePartCount[]): number {
  const weight = parts.reduce((sum, p) => sum + p.weight, 0);
  return weight === 0 ? 0 : Math.round((100 * parts.reduce((sum, p) => sum + (p.weight * p.passed) / p.total, 0)) / weight);
}

/** How many checks are waiting for a window to run their page. */
export const pendingPages = (m: ModelMeasure) => m.checks.filter((c) => c.state === "pending").length;

/** Words a page showed, as kept with its check. */
const SEEN_KEPT = 200;
const clip = (text: string) => text.length > SEEN_KEPT ? `${text.slice(0, SEEN_KEPT)}…` : text;

/**
 * The measure with each pending page graded on what the window saw when it used it. A page the
 * window could not run (`error`) fails with that reason. Pages already graded keep their result.
 */
export function gradePages(m: ModelMeasure, pages: readonly PageSeen[]): ModelMeasure {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const checks = m.checks.map((c): MeasureCheck => {
    const seen = c.state === "pending" ? byId.get(c.id) : undefined;
    const kase = CASES.find((k) => k.id === c.id);
    if (!seen || kase?.kind !== "page") return c;
    const { state: _state, ...rest } = c;
    const why = seen.error ?? kase.expect(seen.seen);
    return { ...rest, ok: why === undefined, result: seen.seen.map(clip).join(" · ") || "Nothing.", ...(why ? { why } : {}) };
  });
  const parts = partsOf(checks);
  return { ...m, checks, parts, score: scoreOf(parts) };
}
