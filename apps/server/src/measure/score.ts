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

export const pendingPages = (m: ModelMeasure) => m.checks.filter((c) => c.state === "pending").length;

const skipped = (c: MeasureCheck, why: string): MeasureCheck => {
  const { page: _page, script: _script, ...rest } = c;
  return { ...rest, ok: false, state: "skipped", why };
};

export function skipPages(m: ModelMeasure, why: string): ModelMeasure {
  if (pendingPages(m) === 0) return m;
  const checks = m.checks.map((c): MeasureCheck => (c.state === "pending" ? skipped(c, why) : c));
  const parts = partsOf(checks);
  return { ...m, checks, parts, score: scoreOf(parts) };
}

const SEEN_KEPT = 200;
const clip = (text: string) => text.length > SEEN_KEPT ? `${text.slice(0, SEEN_KEPT)}…` : text;

export function gradePages(m: ModelMeasure, pages: readonly PageSeen[]): ModelMeasure {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const checks = m.checks.map((c): MeasureCheck => {
    const seen = c.state === "pending" ? byId.get(c.id) : undefined;
    const kase = CASES.find((k) => k.id === c.id);
    if (!seen || kase?.kind !== "page") return c;
    if (seen.skipped !== undefined) return skipped(c, seen.skipped);
    const { state: _state, ...rest } = c;
    const why = seen.error ?? kase.expect(seen.seen);
    return { ...rest, ok: why === undefined, result: seen.seen.map(clip).join(" · ") || "Nothing.", ...(why ? { why } : {}) };
  });
  const parts = partsOf(checks);
  return { ...m, checks, parts, score: scoreOf(parts) };
}
