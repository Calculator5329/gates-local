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
import { VRAM_SAFETY_MARGIN_BYTES } from "./constants.ts";
import { estimateBeforeDownload, planWith, takeReadings, type FitDeps, type Readings, type TotalNeed, type TotalReport } from "./fit.ts";
import { defaultNvidiaSmi, readGpu } from "./gpu.ts";
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
  /** Something the table depends on changed: build a new one (coalesced) and push it if it differs. */
  changed(): void;
  /** A models.load notice: no table is built while a load is running (its memory is half counted). */
  load(load: ModelLoad): void;
}

function memoryOf(gpu: GpuSnapshot, margin: number): FitMemory {
  if (gpu.gpuCount === 0) return { kind: "cpu" };
  return { kind: "gpu", freeBytes: gpu.freeBytes, usableBytes: Math.max(0, gpu.freeBytes - margin) };
}

/** Every row from the one reading `r`. A model whose check fails gets no row; the others still do. */
async function rowsFrom(deps: FitTableDeps, baseUrl: string, r: Readings, models: readonly TableModel[]): Promise<TableRow[]> {
  const rows: TableRow[] = [];
  const busy = deps.busy();
  const comfyPid = deps.comfyPid();
  for (const entry of models) {
    const sizes = new Set<number>();
    for (const numCtx of TABLE_CONTEXTS) {
      try {
        const row = entry.installed
          ? await planWith({ ...deps.fit, baseUrl, model: entry.name, numCtx, busy, ...(comfyPid === undefined ? {} : { comfyPid }) }, r).then((plan) => rowOf(plan.report, plan.stop))
          : rowOf(
              estimateBeforeDownload({
                model: entry.name,
                numCtx,
                downloadBytes: entry.downloadBytes,
                freeVramBytes: r.gpu.freeBytes,
                memAvailableBytes: r.memAvailableBytes,
                measuredAt: r.gpu.measuredAt,
                ...(deps.fit?.margins ? { margins: deps.fit.margins } : {}),
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
  /** Open models.load notices by model. */
  const loading = new Map<string, number>();
  const now = deps.fit?.now ?? Date.now;
  const unreadable = (seqNow: number, detail: string): FitTable => ({ reading: { boot, seq: seqNow, measuredAt: now() }, memory: { kind: "unreadable", detail }, rows: [] });

  const build = async (): Promise<FitTable> => {
    const at = ++seq;
    const baseUrl = deps.baseUrl();
    try {
      if (baseUrl === undefined) throw new Error("the model runtime is not running");
      const r = await takeReadings({ ...deps.fit, baseUrl });
      const rows = await rowsFrom(deps, baseUrl, r, await deps.models());
      return { reading: { boot, seq: at, measuredAt: r.gpu.measuredAt }, memory: memoryOf(r.gpu, margin), rows };
    } catch (e) {
      deps.log?.(`fit table: ${(e as Error).message}`);
      // nvidia-smi and the runtime disagree: neither line can be trusted.
      if (e instanceof FitError && e.code === "gpu-unreadable") return unreadable(at, e.message);
      // No runtime to ask: no rows, and the footer's line from the GPU alone.
      try {
        const gpu = await readGpu(deps.fit?.runNvidiaSmi ?? defaultNvidiaSmi, now);
        return { reading: { boot, seq: at, measuredAt: gpu.measuredAt }, memory: memoryOf(gpu, margin), rows: [] };
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
          trigger();
        }
      });
    return building;
  };

  // While a load runs, a trigger waits for it: the load's end triggers once every load has ended.
  const trigger = () => {
    if (loading.size === 0) void run();
  };

  return {
    get: async () => last ?? (await run()),
    changed: trigger,
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
