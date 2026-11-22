import { MEASURE_VERSION, type MeasureCheck, type MeasurePart, type ModelMeasure } from "@gates-local/contracts";
import { k } from "../lib/words/format.ts";
import { Icon, type IconId } from "../lib/ui/icons.tsx";
import { tpsText } from "../models/model-speed.tsx";

export const PART: Readonly<Record<MeasurePart, string>> = { tools: "Tools", files: "Files", database: "Database", instructions: "Follows instructions", pages: "Pages" };
const ORDER: readonly MeasurePart[] = ["tools", "files", "database", "instructions", "pages"];
const partOf = (c: MeasureCheck): MeasurePart => (c.kind === "sql" ? "database" : c.kind);

export const SLOW_WORDS: Readonly<Record<NonNullable<ModelMeasure["slow"]>, string>> = {
  decode: "Slower than you read: under 10 tok/s",
  "first-token": "Slow to start: over 10 s to the first word",
};

export const seconds = (ms: number) => `${ms < 10_000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000)} s`;
export const samplingText = (m: ModelMeasure) => m.sampling ? `Temperature ${m.sampling.temperature}, seed ${m.sampling.seed}, model defaults` : "Your chat's sampling settings";
export const isOlder = (m: ModelMeasure) => m.version === undefined;
export const isEarlier = (m: ModelMeasure) => m.version !== undefined && m.version !== MEASURE_VERSION;
export const EARLIER_WORDS = "Earlier checks";
export const earlierWords = (m: ModelMeasure): string => {
  if (!isEarlier(m)) return "";
  const what = m.version === 4 ? "a Library file named without /library was refused; it reads now"
    : m.version === 3 ? "a check the model cut short was skipped; it fails now" : "fewer tasks, and some replies graded differently";
  return `${EARLIER_WORDS}: ${what}. Measure again to set it beside newer scores.`;
};

export function ScoreTop({ m }: { m: ModelMeasure }) {
  const older = isOlder(m);
  const passed = m.checks.filter((c) => c.ok).length;
  return (
    <div className="mc-top" data-testid="measure.chat.score">
      <div className="md-head">
        <span className="md-score" aria-label={older ? `Older score: ${passed} of ${m.checks.length} checks` : `Score ${m.score} of 100`}>
          {older ? `${passed}/${m.checks.length}` : m.score}
        </span>
      </div>
      <div className="md-facts">
        <span><Icon id="gauge" cls="s14" />{k(m.numCtx)}</span>
        {older ? null : <span><Icon id="bulb" cls="s14" />{m.think === undefined ? "No thinking" : m.think ? "Thinking on" : "Thinking off"}</span>}
        <span><Icon id="speed" cls="s14" />{tpsText(m.tokensPerSecond) ?? "–"}</span>
        {m.firstTokenMs === undefined ? null : <span><Icon id="clock" cls="s14" />{seconds(m.firstTokenMs)} to first word</span>}
        {older ? null : <span data-testid="models.measure.sampling"><Icon id="sliders" cls="s14" />{samplingText(m)}</span>}
      </div>
      {m.slow ? <p className="md-slow" data-testid="models.measure.slow"><Icon id="snail" cls="s14" />{SLOW_WORDS[m.slow]}</p> : null}
      {older ? <p className="md-old" data-testid="models.measure.older">Older measure: eight checks of tools and a database, before Files, Instructions and Pages. Measure again for the five parts.</p> : null}
      {isEarlier(m) ? <p className="md-old" data-testid="models.measure.earlier"><Icon id="clock" cls="s14" />{earlierWords(m)}</p> : null}
      {older ? null : <Parts m={m} />}
      <MeasureNotes m={m} />
    </div>
  );
}

export interface ShortPart { part: MeasurePart; counted: number; total: number; waiting: boolean }

export function shortParts(m: ModelMeasure): ShortPart[] {
  if (isOlder(m)) return [];
  return ORDER.flatMap((part) => {
    const mine = m.checks.filter((c) => partOf(c) === part);
    const counted = mine.filter((c) => c.state === undefined).length;
    return counted < mine.length ? [{ part, counted, total: mine.length, waiting: mine.some((c) => c.state === "pending") }] : [];
  });
}

const and = (words: readonly string[]) => words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;

export function shortWords(m: ModelMeasure): string | undefined {
  const short = shortParts(m);
  if (short.length === 0) return undefined;
  const whole = short.filter((p) => p.counted === 0).map((p) => PART[p.part]);
  return [...(whole.length ? [`Without ${and(whole)}`] : []), ...short.filter((p) => p.counted > 0).map((p) => `${PART[p.part]} ${p.counted} of ${p.total}`)].join(" · ");
}

export function MeasureNotes({ m }: { m: ModelMeasure }) {
  const pending = m.checks.filter((c) => c.state === "pending").length;
  const short = shortParts(m).filter((p) => !(p.waiting && p.counted === 0));
  const left = short.filter((p) => p.counted === 0).map((p) => PART[p.part]);
  const fewer = short.filter((p) => p.counted > 0).map((p) => `${PART[p.part]} over ${p.counted} of its ${p.total} checks`);
  const across = acrossParts(m.checks);
  return (
    <>
      {pending ? <p className="md-old" data-testid="models.measure.pending">{pending === 1 ? "1 page waits" : `${pending} pages wait`} for this app's window to run {pending === 1 ? "it" : "them"}; the score leaves Pages out until then.</p> : null}
      {across.map((why) => <p key={why} className="md-old" data-testid="models.measure.skipped">Skipped: {why}</p>)}
      {left.length || fewer.length ? (
        <p className="md-old" data-testid="models.measure.left-out">
          The score {left.length ? `leaves ${and(left)} out` : ""}{left.length && fewer.length ? ", and counts " : fewer.length ? "counts " : ""}{and(fewer)}.
        </p>
      ) : null}
    </>
  );
}

// why: a reason checks of several parts were skipped for is said once, in the score's notes
function acrossParts(checks: readonly MeasureCheck[]): string[] {
  const parts = new Map<string, Set<MeasurePart>>();
  for (const c of checks) if (c.state === "skipped" && c.why) parts.set(c.why, (parts.get(c.why) ?? new Set()).add(partOf(c)));
  return [...parts].filter(([, p]) => p.size > 1).map(([why]) => why);
}

// why: a reason shows on the first grade line that has it, unless the notes above said it
export function whyShown(checks: readonly MeasureCheck[], notes: boolean): ReadonlySet<string> {
  const said = new Set(notes ? acrossParts(checks) : []);
  const shown = new Set<string>();
  for (const c of checks) {
    if (c.ok || c.why === undefined || said.has(c.why)) continue;
    said.add(c.why);
    shown.add(c.id);
  }
  return shown;
}

export function gradeOf(c: MeasureCheck): { icon: IconId; word: string; tone: "ok" | "no" | "wait" } {
  if (c.state === "pending") return { icon: "clock", word: "Waiting", tone: "wait" };
  if (c.state === "skipped") return { icon: "lock", word: "Skipped", tone: "wait" };
  if (c.ok) return { icon: "check", word: "Passed", tone: "ok" };
  return c.cutThinking ? { icon: "bulb", word: "Cut while thinking", tone: "no" } : { icon: "x", word: "Failed", tone: "no" };
}

function Parts({ m }: { m: ModelMeasure }) {
  const parts = m.parts ?? [];
  return (
    <div className="md-parts" role="table" aria-label="Parts of the score">
      <div className="md-prow md-ph" role="row">
        <span role="columnheader">Part</span>
        <span role="columnheader">Passed</span>
        <span role="columnheader">Weight</span>
      </div>
      {ORDER.map((part) => {
        const p = parts.find((x) => x.part === part);
        return (
          <div key={part} className={p ? "md-prow" : "md-prow none"} role="row" data-testid={`models.measure.part-${part}`}>
            <span role="cell">{PART[part]}</span>
            <span role="cell" className="md-n">{p ? `${p.passed}/${p.total}` : "–"}</span>
            <span role="cell" className="md-n">{p ? p.weight : "–"}</span>
          </div>
        );
      })}
    </div>
  );
}
