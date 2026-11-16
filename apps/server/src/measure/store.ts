import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import { ModelMeasure } from "@gates-local/contracts";

// why: its own file, as one check of a newer kind makes the whole old file unreadable to 0.2.4.
const FILE = "measures-2.json";
const OLD_FILE = "measures.json";
const decodeFile = S.decodeUnknownSync(S.Struct({ version: S.Finite, measures: S.Array(S.Unknown) }));
const decodeMeasure = S.decodeUnknownOption(ModelMeasure);

export interface MeasureStore {
  list(): ModelMeasure[];
  put(m: ModelMeasure): ModelMeasure[];
}

interface Read {
  measures: ModelMeasure[];
  kept: { model: unknown; raw: unknown }[];
}

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
