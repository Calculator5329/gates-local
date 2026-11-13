// The chat models the app suggests, read from chat-models.json: the server's
// catalog and tiers and the client's maker groups and example names all come
// from that one file. A malformed edit stops the app at startup with the
// reason, never a half-read list.
import * as S from "effect/Schema";
import data from "./chat-models.json" with { type: "json" };

const SuggestedModel = S.Struct({ name: S.String, label: S.String, purpose: S.String, downloadBytes: S.Number });
const TierRow = S.Struct({ gb: S.Number, picks: S.Array(S.String) });
const ChatModelsFile = S.Struct({
  format: S.Literal(1),
  models: S.Array(SuggestedModel),
  tiers: S.Struct({ system: S.Array(TierRow), gpu: S.Array(TierRow) }),
  makers: S.Array(S.Struct({ name: S.String, match: S.String })),
  example: S.String,
  typedExample: S.String,
});
export type ChatModels = typeof ChatModelsFile.Type;

/** The file's problems, one line each; empty when it holds together. */
export function chatModelsProblems(file: ChatModels): string[] {
  const names = new Set(file.models.map((m) => m.name));
  const problems: string[] = [];
  if (names.size !== file.models.length) problems.push("a model is listed twice");
  for (const m of file.models) {
    if (!m.name.includes(":")) problems.push(`${m.name}: name the tag (name:tag)`);
    if (m.purpose.split(/\s+/).length > 4) problems.push(`${m.name}: purpose is over four words`);
    if (!(m.downloadBytes > 0)) problems.push(`${m.name}: downloadBytes must be positive`);
  }
  for (const [by, rows] of Object.entries(file.tiers)) {
    if (rows.length === 0) problems.push(`no ${by} tier`);
    for (const t of rows) {
      if (t.picks.length === 0 || t.picks.length > 3) problems.push(`${by} ${t.gb} GB: one to three picks`);
      for (const p of t.picks) if (!names.has(p)) problems.push(`${by} ${t.gb} GB: ${p} is not in models`);
    }
  }
  if (!names.has(file.example)) problems.push(`example ${file.example} is not in models`);
  if (names.has(file.typedExample)) problems.push(`typedExample ${file.typedExample} is already in models`);
  for (const m of file.makers) if (pattern(m.match) === undefined) problems.push(`maker ${m.name}: match is not a pattern`);
  return problems;
}

function pattern(source: string): RegExp | undefined {
  try {
    return new RegExp(source, "i");
  } catch {
    return undefined;
  }
}

function load(raw: unknown): ChatModels {
  const file = S.decodeUnknownSync(ChatModelsFile)(raw);
  const problems = chatModelsProblems(file);
  if (problems.length > 0) throw new Error(`chat-models.json: ${problems.join("; ")}`);
  return file;
}

export const CHAT_MODELS: ChatModels = load(data);

const makerPatterns = CHAT_MODELS.makers.map((m) => ({ name: m.name, re: new RegExp(m.match, "i") }));

/** The maker a tag groups under, stable across local aliases, quantizations and hosted copies; "Other" when none matches. */
export function makerOf(tag: string): string {
  return makerPatterns.find((m) => m.re.test(tag))?.name ?? "Other";
}
