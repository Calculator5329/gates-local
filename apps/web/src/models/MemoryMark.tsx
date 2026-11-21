import type { FitReport } from "@gates-local/contracts";
import { NBSP, cardGb, needAmount as amount, needBasis, roughly, slowReason } from "../lib/words/format.ts";
import type { TableFit } from "../fit/fit-table.ts";
import { Icon } from "../lib/ui/icons.tsx";
import { type State, useStore } from "../lib/store/store.ts";

export function markWhole(s: Pick<State, "fitTable" | "gpu">): number | undefined {
  const memory = s.fitTable?.memory;
  if (memory !== undefined && memory.kind !== "unreadable" && memory.totalBytes !== undefined) return memory.totalBytes;
  return s.gpu !== undefined && s.gpu !== "na" ? s.gpu.totalBytes : undefined;
}

export function markText(need: number, whole: number): string {
  return `${amount(need)} / ${cardGb(whole).replace(NBSP, " ")}`;
}

export function markFill(verdict: FitReport["verdict"], need: number, whole: number): number {
  return verdict === "refuse" || whole <= 0 ? 1 : Math.min(1, need / whole);
}

const KIND: Record<FitReport["verdict"], string> = { fits: "gpu", spills: "spill", refuse: "no" };

export function MemoryMark({ report, words }: { report: FitReport; words: string }) {
  const whole = useStore(markWhole);
  const need = report.needVramBytes;
  const measured = report.source === "measured";
  const text = whole === undefined ? `${amount(need)} GB` : markText(need, whole);
  const fill = whole === undefined ? 0 : markFill(report.verdict, need, whole);
  return (
    <span
      className={`mm ${KIND[report.verdict]}`}
      role="img"
      aria-label={`${words}: ${text.replace(" / ", " of ")}, ${needBasis(measured)}`}
      data-testid="models.fit.memory-mark"
    >
      <span className="mm-bar" aria-hidden="true"><i style={{ width: `${(fill * 100).toFixed(1)}%` }} /></span>
      <span className="mm-n" aria-hidden="true">{roughly(measured)}{text}</span>
    </span>
  );
}

export function SlowLine({ fit, tps, tip = true, listed = false, testId = "models.fit.slow-now" }: { fit: TableFit | undefined; tps?: string | undefined; tip?: boolean; listed?: boolean; testId?: string }) {
  const said = useStore((s) => (listed && s.fitTable?.memory.kind === "gpu" ? s.fitTable.memory.others?.programs : undefined));
  const why = slowReason(fit?.slowNow, tps, said);
  if (why === undefined) return null;
  const saidBelow = !why.short.endsWith(" in the way");
  return (
    <div className="mm-why" data-testid={testId}>
      <Icon id="gauge" cls="s14" />
      <span>{why.short}</span>
      {tip && !saidBelow ? <span className="vh">. {why.sentence}</span> : null}
    </div>
  );
}
