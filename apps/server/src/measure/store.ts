// The measured models (row 29), one per model name, in a JSON file in the app's data folder.
// The digest is kept so the page can tell a measure of older weights from the installed ones.
//
// Two files. measures.json is the one 0.2.4 and older read: they know only the eight-check measure
// (kinds "tools" and "sql"), and one check of another kind makes the whole file unreadable there,
// so their next Measure rewrites it with one result. This build never writes it; it writes
// measures-2.json, reads that first and takes from the old file only the models it lacks, so a
// rollback finds the old file as it left it. An entry either file holds that this build cannot
// read (a later build's) is left out of the list and kept when the file is written again.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import { ModelMeasure } from "@gates-local/contracts";

const FILE = "measures-2.json";
/** 0.2.4's file: read for older measures, never written. */
const OLD_FILE = "measures.json";
const decodeFile = S.decodeUnknownSync(S.Struct({ version: S.Finite, measures: S.Array(S.Unknown) }));
const decodeMeasure = S.decodeUnknownOption(ModelMeasure);

export interface MeasureStore {
  list(): ModelMeasure[];
  /** Saves `m` in place of the model's last measure; returns the whole list. */
  put(m: ModelMeasure): ModelMeasure[];
}

interface Read {
  measures: ModelMeasure[];
  /** Entries this build cannot read, with the model they name. */
  kept: { model: unknown; raw: unknown }[];
}

/** A file's entries, each read on its own: a missing or unreadable file has none. */
function readFile(file: string): Read {
  let entries: readonly unknown[];
  try {
    entries = decodeFile(JSON.parse(readFileSync(file, "utf8"))).measures;
  } catch {
    return { measures: [], kept: [] };
  }
  const read: Read = { measures: [], kept: [] };
  for (const raw of entries) {
    const m = decodeMeasure(raw);
    if (Option.isSome(m)) read.measures.push(m.value);
    else read.kept.push({ model: (raw as { model?: unknown } | null)?.model, raw });
  }
  return read;
}

export function measureStore(dataDir: string): MeasureStore {
  const file = path.join(dataDir, FILE);
  let cache: (Read & { older: ModelMeasure[] }) | undefined;
  const read = () => {
    if (cache) return cache;
    const mine = readFile(file);
    const named = new Set(mine.measures.map((m) => m.model));
    const older = readFile(path.join(dataDir, OLD_FILE)).measures.filter((m) => !named.has(m.model));
    cache = { ...mine, older };
    return cache;
  };
  const all = () => [...read().older, ...read().measures];
  return {
    list: all,
    put(m) {
      const now = read();
      const measures = [...now.measures.filter((x) => x.model !== m.model), m];
      const kept = now.kept.filter((x) => x.model !== m.model);
      mkdirSync(dataDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ version: 2, measures: [...measures, ...kept.map((x) => x.raw)] }, null, 2)}\n`);
      renameSync(tmp, file);
      cache = { measures, kept, older: now.older.filter((x) => x.model !== m.model) };
      return all();
    },
  };
}
