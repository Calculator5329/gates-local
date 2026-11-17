import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import { canonicalTag } from "../runtime/recommended.ts";
import { createLoadedRecord, type LoadedRecord } from "./memory.ts";

export const OWN_MODELS_FILE = "own-models.json";

const OwnModel = S.Struct({
  tag: S.String,
  numCtx: S.Finite,
  at: S.Finite,
  mode: S.String,
  carried: S.optional(S.Boolean),
});
type OwnModel = typeof OwnModel.Type;
const decodeFile = S.decodeUnknownSync(S.Struct({ models: S.Array(S.Unknown) }));
const decodeModel = S.decodeUnknownOption(OwnModel);

export interface KeptRecordOptions {
  readonly dataDir: string;
  readonly mode: () => string;
  readonly holdsOne?: () => boolean;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

function readKept(file: string, mode: string, log: (line: string) => void): OwnModel[] {
  let raw: readonly unknown[];
  try {
    raw = decodeFile(JSON.parse(readFileSync(file, "utf8"))).models;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") log(`${OWN_MODELS_FILE} unreadable, so no model is the app's from the last run: ${(e as Error).message}`);
    return [];
  }
  const kept: OwnModel[] = [];
  for (const entry of raw) {
    const model = decodeModel(entry);
    // decision: docs/decisions.md "Other programs' memory is freed only with a click"
    if (Option.isSome(model) && model.value.carried !== true && model.value.mode === mode) kept.push(model.value);
  }
  return kept;
}

export function keptRecord(options: KeptRecordOptions): LoadedRecord {
  const log = options.log ?? (() => undefined);
  const now = options.now ?? Date.now;
  const file = path.join(options.dataDir, OWN_MODELS_FILE);
  const record = createLoadedRecord(options.holdsOne);
  const since = new Map<string, { readonly at: number; readonly mode: string; readonly carried?: true }>();
  const carried = readKept(file, options.mode(), log);
  for (const m of carried) since.set(canonicalTag(m.tag), { at: m.at, mode: m.mode, carried: true });
  record.restore({ listed: [], ours: carried.map((m) => [canonicalTag(m.tag), m.numCtx] as const) });

  let said: string | undefined;
  const save = () => {
    const models = record.ours().flatMap((tag): OwnModel[] => {
      const numCtx = record.oursAt(tag);
      const when = since.get(tag);
      if (numCtx === undefined || when === undefined) return [];
      return [{ tag, numCtx, ...when }];
    });
    const text = `${JSON.stringify({ models }, null, 2)}\n`;
    if (text === said) return;
    try {
      mkdirSync(options.dataDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, text);
      renameSync(tmp, file);
      said = text;
    } catch (e) {
      log(`writing ${OWN_MODELS_FILE} failed: ${(e as Error).message}`);
    }
  };
  const saved = <T>(result: T): T => {
    save();
    return result;
  };
  save();

  return {
    listed: () => record.listed(),
    ours: () => record.ours(),
    oursAt: (model) => record.oursAt(model),
    loaded(model, numCtx) {
      since.set(canonicalTag(model), { at: now(), mode: options.mode() });
      return saved(record.loaded(model, numCtx));
    },
    left: (model) => saved(record.left(model)),
    observe: (listed) => saved(record.observe(listed)),
    clear: () => saved(record.clear()),
    restore: (kept) => saved(record.restore(kept)),
  };
}
