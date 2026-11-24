import { checksOf, type MeasurePart, type MeasureTurn } from "@gates-local/contracts";
import { NA, type State, useStore } from "../lib/store/store.ts";
import { nameOf } from "../models/models-rules.ts";
import { measuringNow, runOf } from "./measures.ts";

const PART_NAME: Readonly<Record<MeasurePart, string>> = { tools: "Tools", files: "Files", database: "Database", instructions: "Instructions", images: "Images", pages: "Pages" };

const labelOf = (s: State, model: string) => nameOf(model, s.catalog === NA ? undefined : s.catalog).text;

// why: a page that waits for the window to run it is not graded yet
export const gradedOf = (turns: readonly MeasureTurn[]) => turns.filter((t) => t.check !== undefined && t.check.state !== "pending").length;

const liveTurns = (s: State, model: string) => (s.measureLive?.model === model ? s.measureLive.turns : []);

export function MeasureTitle({ model }: { model: string }) {
  const label = useStore((s) => labelOf(s, model));
  const going = useStore((s) => runOf(s, model) !== undefined || (s.measureLive?.model === model && s.measureLive.ended !== undefined));
  const at = useStore((s) => (going ? liveTurns(s, model).at(-1) : undefined));
  return (
    <>
      <h2 data-testid="measure.chat.title">{going ? `Measuring ${label}` : label}</h2>
      {at === undefined ? null : <span className="mc-at" data-testid="measure.chat.at">{`${PART_NAME[at.part]} · ${at.n} of ${at.of}`}</span>}
    </>
  );
}

// why: drawn only while a run goes and never saved, so it is a row and not a thread
export function MeasurePinned({ open }: { open: (model: string) => void }) {
  const model = useStore(measuringNow);
  const label = useStore((s) => (model === undefined ? "" : labelOf(s, model)));
  const shown = useStore((s) => s.measureShown !== null && s.measureShown === model && s.view !== "settings" && s.view !== "pictures");
  const graded = useStore((s) => (model === undefined ? 0 : gradedOf(liveTurns(s, model))));
  const of = useStore((s) => {
    const run = model === undefined ? undefined : s.measuring[model];
    return run === undefined ? 0 : checksOf(run);
  });
  if (model === undefined) return null;
  return (
    <div className={`sb-row mc-pin${shown ? " on" : ""}`}>
      <button type="button" className="sb-thread" data-testid="sidebar.measure.open" onClick={() => open(model)}>
        <span className="live" aria-hidden="true" />
        <span className="t">{`Measuring ${label}`}</span>
        <span className="sb-status"><span className="ago">{`${graded}/${of}`}</span></span>
      </button>
    </div>
  );
}
