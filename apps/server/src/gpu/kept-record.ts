import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
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
// why: one entry the app cannot decode makes the whole file unreadable, so it is moved aside
const decodeFile = S.decodeUnknownSync(S.Struct({ models: S.Array(OwnModel) }));

// why: renameSync replaces an existing file, so an earlier file kept aside takes a free name
function freeName(base: string): string {
  let name = base;
  for (let n = 2; existsSync(name); n++) name = `${base}-${n}`;
  return name;
}

export interface KeptRecordOptions {
  readonly dataDir: string;
  readonly mode: () => string;
  readonly holdsOne?: () => boolean;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

// why: undefined is a file there that could be neither read nor moved aside, so nothing is written
function readKept(file: string, mode: string, at: number, log: (line: string) => void): OwnModel[] | undefined {
  let raw: readonly OwnModel[];
  try {
    raw = decodeFile(JSON.parse(readFileSync(file, "utf8"))).models;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    // why: a file the app cannot read may not be its own, so it is kept beside the new one
    const aside = freeName(`${file}.unreadable-${at}`);
    try {
      renameSync(file, aside);
    } catch (moving) {
      log(`${OWN_MODELS_FILE} unreadable and could not be moved aside, so it is left as it is: ${(moving as Error).message}`);
      return undefined;
    }
    log(`${OWN_MODELS_FILE} unreadable, so no model is the app's from the last run; moved to ${path.basename(aside)}: ${(e as Error).message}`);
    return [];
  }
  const kept: OwnModel[] = [];
  for (const model of raw) {
    // decision: docs/decisions.md "Other programs' memory is freed only with a click"
    if (model.carried !== true && model.mode === mode) kept.push(model);
  }
  return kept;
}

export function keptRecord(options: KeptRecordOptions): LoadedRecord {
  const log = options.log ?? (() => undefined);
  const now = options.now ?? Date.now;
  const file = path.join(options.dataDir, OWN_MODELS_FILE);
  const record = createLoadedRecord(options.holdsOne);
  const since = new Map<string, { readonly at: number; readonly mode: string; readonly carried?: true }>();
  const read = readKept(file, options.mode(), now(), log);
  const carried = read ?? [];
  for (const m of carried) since.set(canonicalTag(m.tag), { at: m.at, mode: m.mode, carried: true });
  record.restore({ listed: [], ours: carried.map((m) => [canonicalTag(m.tag), m.numCtx] as const) });

  let said: string | undefined;
  const save = () => {
    if (read === undefined) return;
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
    fromLastRun: (model) => since.get(canonicalTag(model))?.carried === true,
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
