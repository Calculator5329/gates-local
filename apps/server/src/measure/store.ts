// The measured models (row 29), one per model name, in a JSON file in the app's data folder.
// The digest is kept so the page can tell a measure of older weights from the installed ones.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as S from "effect/Schema";
import { ModelMeasure } from "@gates-local/contracts";

const FILE = "measures.json";
const decode = S.decodeUnknownSync(S.Struct({ version: S.Literal(1), measures: S.Array(ModelMeasure) }));

export interface MeasureStore {
  list(): ModelMeasure[];
  /** Saves `m` in place of the model's last measure; returns the whole list. */
  put(m: ModelMeasure): ModelMeasure[];
}

export function measureStore(dataDir: string): MeasureStore {
  const file = path.join(dataDir, FILE);
  let cache: ModelMeasure[] | undefined;
  const read = (): ModelMeasure[] => {
    if (cache) return cache;
    try {
      cache = [...decode(JSON.parse(readFileSync(file, "utf8"))).measures];
    } catch {
      // No file yet, or one this version cannot read: nothing measured.
      cache = [];
    }
    return cache;
  };
  return {
    list: () => [...read()],
    put(m) {
      const next = [...read().filter((x) => x.model !== m.model), m];
      mkdirSync(dataDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ version: 1, measures: next }, null, 2)}\n`);
      renameSync(tmp, file);
      cache = next;
      return [...next];
    },
  };
}
