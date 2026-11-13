// The fit table: every model the app shows, at every context it offers, from one GPU reading, and
// the memory line the picker's footer shows from that same reading. The server pushes it as
// fit.changed whenever something it depends on moves; clients show the last one they got and ask
// for nothing else.
//
// One basis: every row's need is a TotalNeed (fit.ts), the whole model at that context, GPU plus
// system memory. One reading: a row has no reading of its own; build() takes one and makes every row
// from it, so a table that mixes two cannot be built.
import { randomUUID } from "node:crypto";
import type { CatalogEntry, ContextSize, FitMemory, FitRow, FitTable, ModelLoad } from "@gates-local/contracts";
import type { GpuBaseline } from "./baseline.ts";
import { VRAM_SAFETY_MARGIN_BYTES } from "./constants.ts";
import { cardRamBytes, decideFit, estimateBeforeDownload, planWith, takeReadings, type FitDeps, type Readings, type TotalNeed, type TotalReport } from "./fit.ts";
import { defaultNvidiaSmi, GPU_REUSE_MS, readGpu } from "./gpu.ts";
import { FitError, type GpuSnapshot } from "./types.ts";

/** The contexts the picker offers. */
export const TABLE_CONTEXTS: readonly ContextSize[] = [8192, 16384, 32768, 65536];

/** A row as the server builds it: its need can only come from a TotalReport. */
type TableRow = Omit<FitRow, "needVramBytes"> & { readonly needVramBytes: TotalNeed };

/** A model the table states: an installed one is planned, one offered for download is estimated from its download. */
export type TableModel = Pick<CatalogEntry, "name" | "downloadBytes" | "installed">;

const rowOf = ({ measuredAt: _theTableHoldsTheReading, ...report }: TotalReport, stops: readonly string[]): TableRow => ({ ...report, stops: [...stops] });

export interface FitTableDeps {
  readonly baseUrl: () => string | undefined;
  readonly fit?: Omit<FitDeps, "baseUrl">;
  /** The models the table states: installed chat models and models offered for download. */
  readonly models: () => Promise<readonly TableModel[]>;
  /** Models of admitted turns: a load would have to stop their chats to use their memory. */
  readonly busy: () => readonly string[];
  /** The idle ComfyUI the app started, which a load may stop. */
  readonly comfyPid: () => number | undefined;
  readonly push: (table: FitTable) => void;
  readonly boot?: string;
  readonly log?: (line: string) => void;
}

export interface FitTableSource {
  /** The last table; builds one first when there is none yet. */
  get(): Promise<FitTable>;
  /**
   * Something the table depends on changed: build a new one (coalesced) and push it if it differs.
   * `afterPlan`: a send just planned on a fresh GPU reading, and the build may take it (chat row 33).
   */
  changed(options?: { afterPlan?: boolean }): void;
  /** A models.load notice: no table is built while a load is running (its memory is half counted). */
  load(load: ModelLoad): void;
}

/** The footer's line right now, and the programs holding memory above the card's baseline (the download list names them). */
function memoryOf(gpu: GpuSnapshot, margin: number, baseline: GpuBaseline | undefined, own: readonly number[]): FitMemory {
  if (gpu.gpuCount === 0) return { kind: "cpu" };
  const others = baseline?.others(gpu, own);
  return { kind: "gpu", freeBytes: gpu.freeBytes, usableBytes: Math.max(0, gpu.freeBytes - margin), ...(others ? { others } : {}) };
}

/**
 * Every row from the one reading `r`. A model whose check fails gets no row; the others still do.
 * An installed model is planned right now, as a send would load it, and also carries its verdict
 * against the card (`card`: the GPU's memory and the system memory the computer has), which every
 * list and Settings show; one offered for download is judged against the card.
 */
async function rowsFrom(deps: FitTableDeps, baseUrl: string, r: Readings, models: readonly TableModel[], comfyPid: number | undefined): Promise<TableRow[]> {
  const rows: TableRow[] = [];
  const busy = deps.busy();
  const baseline = deps.fit?.baseline;
  const cardFree = baseline?.cardFree(r.gpu) ?? r.gpu.freeBytes;
  // the system memory side of the card: what the computer has, never what is free right now
  const cardRam = cardRamBytes(r.memTotalBytes);
  const margins = deps.fit?.margins ? { margins: deps.fit.margins } : {};
  const cardOf = (row: TableRow): TableRow => {
    const { verdict, freeVramBytes, spillRamBytes, shortfallBytes } = decideFit({
      model: row.model,
      numCtx: row.numCtx,
      needBytes: row.needVramBytes,
      freeVramBytes: Math.max(cardFree, row.freeVramBytes),
      memAvailableBytes: cardRam,
      measuredAt: r.gpu.measuredAt,
      ...margins,
    });
    return { ...row, card: { verdict, freeVramBytes, spillRamBytes, ...(shortfallBytes === undefined ? {} : { shortfallBytes }) } };
  };
  // With no GPU the card is the computer's own memory, judged the same way.
  const onCard = baseline !== undefined;
  for (const entry of models) {
    const sizes = new Set<number>();
    for (const numCtx of TABLE_CONTEXTS) {
      try {
        const row = entry.installed
          ? await planWith({ ...deps.fit, baseUrl, model: entry.name, numCtx, busy, ...(comfyPid === undefined ? {} : { comfyPid }) }, r).then((plan) => {
              const planned = rowOf(plan.report, plan.stop);
              return onCard ? cardOf(planned) : planned;
            })
          : rowOf(
              estimateBeforeDownload({
                model: entry.name,
                numCtx,
                downloadBytes: entry.downloadBytes,
                freeVramBytes: cardFree,
                memAvailableBytes: cardRam,
                measuredAt: r.gpu.measuredAt,
                ...margins,
              }),
              [],
            );
        // A model that holds less than this context runs at its own size: one row for that size.
        if (sizes.has(row.numCtx)) continue;
        sizes.add(row.numCtx);
        rows.push(row);
      } catch (e) {
        deps.log?.(`fit table: ${entry.name} at ${numCtx}: ${(e as Error).message}`);
      }
    }
  }
  return rows;
}

export function createFitTable(deps: FitTableDeps): FitTableSource {
  const boot = deps.boot ?? randomUUID();
  const margin = deps.fit?.margins?.vramMarginBytes ?? VRAM_SAFETY_MARGIN_BYTES;
  let seq = 0;
  let last: FitTable | undefined;
  let lastPushed: string | undefined;
  let building: Promise<FitTable> | undefined;
  let again = false;
  /** The next build may take a GPU reading up to GPU_REUSE_MS old: only when every trigger since the last build said so. */
  let reuseNext: boolean | undefined;
  /** Open models.load notices by model. */
  const loading = new Map<string, number>();
  const now = deps.fit?.now ?? Date.now;
  const unreadable = (seqNow: number, detail: string): FitTable => ({ reading: { boot, seq: seqNow, measuredAt: now() }, memory: { kind: "unreadable", detail }, rows: [] });

  const build = async (): Promise<FitTable> => {
    const at = ++seq;
    const reuseGpuMs = reuseNext === true ? GPU_REUSE_MS : 0;
    reuseNext = undefined;
    const baseUrl = deps.baseUrl();
    try {
      if (baseUrl === undefined) throw new Error("the model runtime is not running");
      const r = await takeReadings({ ...deps.fit, baseUrl, reuseGpuMs });
      const comfyPid = deps.comfyPid();
      const own = comfyPid === undefined ? [] : [comfyPid];
      deps.fit?.baseline?.observe(r.gpu, own);
      const memory = memoryOf(r.gpu, margin, deps.fit?.baseline, own);
      const rows = await rowsFrom(deps, baseUrl, r, await deps.models(), comfyPid);
      return { reading: { boot, seq: at, measuredAt: r.gpu.measuredAt }, memory, rows };
    } catch (e) {
      deps.log?.(`fit table: ${(e as Error).message}`);
      // nvidia-smi and the runtime disagree: neither line can be trusted.
      if (e instanceof FitError && e.code === "gpu-unreadable") return unreadable(at, e.message);
      // No runtime to ask: no rows, and the footer's line from the GPU alone.
      try {
        const gpu = await readGpu(deps.fit?.runNvidiaSmi ?? defaultNvidiaSmi, now, undefined, reuseGpuMs);
        return { reading: { boot, seq: at, measuredAt: gpu.measuredAt }, memory: memoryOf(gpu, margin, undefined, []), rows: [] };
      } catch (gpuError) {
        return unreadable(at, (gpuError as Error).message);
      }
    }
  };

  const publish = (table: FitTable) => {
    // A load opened while this build read: GPU memory was filling under it. Drop it; the load's end
    // builds again.
    if (loading.size > 0) return;
    // seq rises in build order and builds never overlap, so the last one built is the newest.
    last = table;
    const content = JSON.stringify([table.memory, table.rows]);
    if (content === lastPushed) return;
    lastPushed = content;
    try {
      deps.push(table);
    } catch (e) {
      deps.log?.(`fit.changed push failed: ${(e as Error).message}`);
    }
  };

  /** One build at a time; a trigger during one builds once more after it. */
  const run = (): Promise<FitTable> => {
    if (building) {
      again = true;
      return building;
    }
    building = build()
      .then((table) => {
        publish(table);
        return table;
      })
      .finally(() => {
        building = undefined;
        if (again) {
          again = false;
          kick();
        }
      });
    return building;
  };

  // While a load runs, a trigger waits for it: the load's end triggers once every load has ended.
  const kick = () => {
    if (loading.size === 0) void run();
  };
  const trigger = (reuseGpu = false) => {
    reuseNext = (reuseNext ?? true) && reuseGpu;
    kick();
  };

  return {
    get: async () => {
      if (last !== undefined) return last;
      reuseNext = false;
      return await run();
    },
    changed: (options) => trigger(options?.afterPlan === true),
    load(load) {
      const open = loading.get(load.model) ?? 0;
      if (load.state === "loading") {
        loading.set(load.model, open + 1);
        return;
      }
      if (open > 1) loading.set(load.model, open - 1);
      else loading.delete(load.model);
      trigger();
    },
  };
}
