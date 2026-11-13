// What the finder has been told: the real findings on clean dev it should keep
// finding (known.json), and the scoreboard's cases, each a bug the owner
// reported that the tests missed (cases/<id>/case.json, its fix undone by
// cases/<id>/undo.patch). Pure functions; scripts/finder-board.ts and
// scripts/bug-finder.ts read the files.
import type { Finding, Kind } from "./detectors.ts";

/** A finding to look for: the screen, and when given the step, the kind and words its element contains. */
export interface Expect {
  readonly screen: string;
  readonly step?: string;
  /** Any kind when left out: for a bug no detector looks for yet, anything new on its screen. */
  readonly kind?: Kind;
  /** Words the finding's element contains (case does not matter). */
  readonly element?: string;
}

/** A finding on clean dev, triaged: real (a bug for an area's queue) or not (the finder's own noise, to tune away). */
export interface Known extends Expect {
  readonly real: boolean;
  /** The area file whose queue it belongs to. */
  readonly area: string;
  /** What is wrong, in one sentence. */
  readonly wrong: string;
}

export interface Case {
  readonly id: string;
  /** The owner's words in the report. */
  readonly owner: string;
  /** Where the owner said it: an area file and its row. */
  readonly source: string;
  /** The commit that fixed it. */
  readonly fix: string;
  /** What undo.patch does to today's code (the fix's own diff reversed, or the fix's mechanism undone by hand). */
  readonly undo: string;
  /** The screens that show it, and how (the steps, in words). */
  readonly screens: readonly string[];
  readonly shows: string;
  /** Any one of these, new against clean dev, is a catch. */
  readonly catch: readonly Expect[];
  /** For a miss: the detector that would catch it. */
  readonly detector?: string;
}

export function matches(f: Finding, e: Expect): boolean {
  return f.screen === e.screen && (e.kind === undefined || f.kind === e.kind) && (e.step === undefined || f.step === e.step)
    && (e.element === undefined || f.element.toLowerCase().includes(e.element.toLowerCase()));
}

const same = (a: Finding, b: Finding) => a.screen === b.screen && a.step === b.step && a.kind === b.kind && a.element === b.element;

/** Clean dev's findings sorted: known real, known not real, and new ones nobody has looked at. */
export function triage<F extends Finding>(found: readonly F[], known: readonly Known[]): { real: F[]; notReal: F[]; fresh: F[] } {
  const out = { real: [] as F[], notReal: [] as F[], fresh: [] as F[] };
  for (const f of found) {
    const k = known.find((e) => matches(f, e));
    (k === undefined ? out.fresh : k.real ? out.real : out.notReal).push(f);
  }
  return out;
}

/** A case is caught when the walk with its fix undone finds what it expects and clean dev does not find the same. */
export function score<F extends Finding>(c: Case, found: readonly F[], clean: readonly Finding[]): F | undefined {
  return found.find((f) => c.catch.some((e) => matches(f, e)) && !clean.some((g) => same(f, g)));
}

/** Reads and checks a case.json: a case missing its words, fix, screens or catch is an error, not a quiet miss. */
export function parseCase(id: string, json: unknown): Case {
  const c = json as Partial<Case>;
  const missing = (["owner", "source", "fix", "undo", "shows"] as const).filter((k) => typeof c[k] !== "string" || c[k] === "");
  if (!Array.isArray(c.screens) || c.screens.length === 0) missing.push("screens" as never);
  if (!Array.isArray(c.catch) || c.catch.length === 0 || !c.catch.every((e) => typeof e?.screen === "string")) missing.push("catch" as never);
  if (missing.length > 0) throw new Error(`case ${id}: ${missing.join(", ")} missing or empty`);
  return { ...(c as Case), id };
}
