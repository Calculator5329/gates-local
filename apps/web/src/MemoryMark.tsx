// One memory mark, the same wherever a model's memory shows (settings row 28, proposal 05, the owner
// picked A): "the measure for a model is not what is available now its based on the ram in the card".
// The bar is the whole card (with no GPU, the computer's memory), the fill is what this model takes,
// and the number says both: "6.6 / 16 GB". The fill's colour is the verdict (green on the GPU, amber
// slower, a grey full bar when it cannot run); the verdict's words are the mark's name and its tip.
// What other programs hold is never in a mark: each list says it once under its rows.
//
// Used by Settings › Models and Download. The chat picker (Picker.tsx, the row's .pk-v and the context
// rows' .pk-cost) and the image picker (ImagePicker.tsx, the size rows' bars) are where the same part
// goes next.
import type { FitReport } from "@gates-local/contracts";
import { type State, useStore } from "./store.ts";

const GIB = 1024 ** 3;

/** The whole a model is judged against: the table's reading, else the GPU's own size; undefined when neither is known. */
export function markWhole(s: Pick<State, "fitTable" | "gpu">): number | undefined {
  const memory = s.fitTable?.memory;
  if (memory !== undefined && memory.kind !== "unreadable" && memory.totalBytes !== undefined) return memory.totalBytes;
  return s.gpu !== undefined && s.gpu !== "na" ? s.gpu.totalBytes : undefined;
}

/** One decimal under 10 GB, whole from 10 up ("6.6", "17"), as every size in Models reads. */
const amount = (bytes: number) => {
  const g = bytes / GIB;
  return g < 9.95 ? g.toFixed(1) : String(Math.round(g));
};

/** "6.6 / 16 GB": what the model takes over the whole card, in the app's GB (GiB). */
export function markText(need: number, whole: number): string {
  return `${amount(need)} / ${Math.round(whole / GIB)} GB`;
}

/** The fill as a share of the bar: the need over the whole, the whole bar when it cannot run or needs more. */
export function markFill(verdict: FitReport["verdict"], need: number, whole: number): number {
  return verdict === "refuse" || whole <= 0 ? 1 : Math.min(1, need / whole);
}

const KIND: Record<FitReport["verdict"], string> = { fits: "gpu", spills: "spill", refuse: "no" };

/**
 * The mark for one model's report. words: the verdict said in words, the mark's accessible name;
 * tip: its tooltip (HTML, escaped by the caller), shown on hover or focus.
 */
export function MemoryMark({ report, words, tip }: { report: FitReport; words: string; tip: string }) {
  const whole = useStore(markWhole);
  const need = report.needVramBytes;
  const text = whole === undefined ? `${amount(need)} GB` : markText(need, whole);
  const fill = whole === undefined ? 0 : markFill(report.verdict, need, whole);
  return (
    <span
      className={`mm ${KIND[report.verdict]}`}
      role="img"
      aria-label={`${words}: ${text.replace(" / ", " of ")}`}
      tabIndex={0}
      data-tip={tip}
      data-testid="models.fit.memory-mark"
    >
      <span className="mm-bar" aria-hidden="true"><i style={{ width: `${(fill * 100).toFixed(1)}%` }} /></span>
      <span className="mm-n" aria-hidden="true">{text}</span>
    </span>
  );
}
