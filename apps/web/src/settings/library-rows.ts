import type { SampleDatabase, Source, SourceImport } from "@gates-local/contracts";

export interface DbRow {
  readonly key: string;
  readonly sample?: SampleDatabase;
  readonly source?: Source;
  readonly job?: SourceImport;
}

export function databaseRows(samples: readonly SampleDatabase[], sources: readonly Source[], jobs: readonly SourceImport[]): DbRow[] {
  const copyOf = (id: string) => sources.find(s => s.kind === "sqlite" && s.managed?.kind === "sample" && s.managed.key === id);
  const slots = samples.map((sample): DbRow => {
    const source = copyOf(sample.id);
    if (source) return { key: `sample:${sample.id}`, sample, source };
    const job = jobs.findLast(j => j.kind === "sample" && j.key === sample.id);
    return { key: `sample:${sample.id}`, sample, ...(job ? { job } : {}) };
  });
  const placed = new Set(slots.flatMap(r => r.source ? [r.source.id] : []));
  const own = sources.filter(s => s.kind === "sqlite" && !placed.has(s.id)).toSorted((a, b) => a.addedAt - b.addedAt);
  return [...slots, ...own.map((source): DbRow => ({ key: `db:${source.id}`, source }))];
}

export interface AskNeeds {
  readonly downloaded: boolean;
  readonly chat: boolean;
  readonly tools: boolean;
  readonly tool: boolean;
}

export function askWhy({ downloaded, chat, tools, tool }: AskNeeds): string | null {
  if (!downloaded) return "Download it to ask these.";
  if (!chat) return "Needs a model that can chat.";
  if (!tools) return "Needs tools turned on, in Tools.";
  if (!tool) return "Needs the database tool, in Tools.";
  return null;
}
