import type { SampleDatabase, Source, SourceImport } from "@gates-local/contracts";

/**
 * One row of Settings › Library › Databases. A sample's row keeps its key
 * (`sample:<id>`) whether or not it is downloaded, so the download happens in
 * the row and its end is the same row; `source` is set once it is in the
 * Library, `job` only while it is not.
 */
export interface DbRow {
  readonly key: string;
  readonly sample?: SampleDatabase;
  readonly source?: Source;
  readonly job?: SourceImport;
}

/**
 * Samples first, each in its catalog slot; then the person's own databases in
 * the order they were added. A sample in the Library is its slot's database,
 * never a second row; a copy of a sample the catalog no longer has is listed
 * once with the person's own.
 */
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

/** What a sample's questions need before one can be asked. */
export interface AskNeeds {
  /** The sample is in the Library, ready. */
  readonly downloaded: boolean;
  /** Ollama is up with a model that can chat. */
  readonly chat: boolean;
  /** Settings › Tools › "Let the model use tools". */
  readonly tools: boolean;
  /** The tool that reads databases on this computer has a source it can use. */
  readonly tool: boolean;
}

/** Why the questions cannot be asked now, in one line; null when they can. */
export function askWhy({ downloaded, chat, tools, tool }: AskNeeds): string | null {
  if (!downloaded) return "Download it to ask these.";
  if (!chat) return "Needs a model that can chat.";
  if (!tools) return "Needs tools turned on, in Tools.";
  if (!tool) return "Needs the database tool, in Tools.";
  return null;
}
