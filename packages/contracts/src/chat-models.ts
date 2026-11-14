// The chat models the app suggests, read from chat-models.json: the server's
// catalog and tiers and the client's maker groups and example names all come
// from that one file. A malformed edit stops the app at startup with the
// reason, never a half-read list.
//
// An installed copy can also take a newer list from the release page
// (models.json, signed like the release list; apps/server/src/update/installed/
// models-list.ts). That list goes through parseChatModels too, so a downloaded
// list is held to the same rules as the built-in one, and the server sends the
// list in use to the client (models.suggested); the client never reads this
// file for anything a downloaded list can change.
import * as S from "effect/Schema";
import data from "./chat-models.json" with { type: "json" };

const SuggestedModel = S.Struct({ name: S.String, label: S.String, purpose: S.String, downloadBytes: S.Number });
const TierRow = S.Struct({ gb: S.Number, picks: S.Array(S.String) });
const MakerRule = S.Struct({ name: S.String, match: S.String });
export type MakerRule = typeof MakerRule.Type;
const ChatModelsFile = S.Struct({
  format: S.Literal(1),
  /** Raised with every edit: a downloaded list is used only when its revision is higher than the list in use. */
  revision: S.Number,
  models: S.Array(SuggestedModel),
  tiers: S.Struct({ system: S.Array(TierRow), gpu: S.Array(TierRow) }),
  makers: S.Array(MakerRule),
  example: S.String,
  typedExample: S.String,
});
export type ChatModels = typeof ChatModelsFile.Type;

/** The file's problems, one line each; empty when it holds together. */
export function chatModelsProblems(file: ChatModels): string[] {
  const names = new Set(file.models.map((m) => m.name));
  const problems: string[] = [];
  if (!Number.isSafeInteger(file.revision) || file.revision < 1) problems.push("revision must be a whole number from 1");
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

/**
 * The one reader of a chat model list, built in or downloaded: the shape, then
 * chatModelsProblems. Throws with every reason; never returns a half-read list.
 */
export function parseChatModels(raw: unknown, source = "chat-models.json"): ChatModels {
  let file: ChatModels;
  try {
    file = S.decodeUnknownSync(ChatModelsFile)(raw);
  } catch (error) {
    throw new Error(`${source}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const problems = chatModelsProblems(file);
  if (problems.length > 0) throw new Error(`${source}: ${problems.join("; ")}`);
  return file;
}

/** The list built into this copy. The server may use a newer downloaded one instead (runtime/chat-list.ts). */
export const CHAT_MODELS: ChatModels = parseChatModels(data);

/** What the client shows from the list in use: maker groups and example names (models.suggested). */
export const SuggestedList = S.Struct({
  revision: S.Number,
  /** The picker's groups in their order; a tag joins the first whose match (a case-blind pattern) finds it. */
  makers: S.Array(MakerRule),
  /** The model the app names when it needs an example ("such as …", "ollama pull …"). */
  example: S.String,
  exampleLabel: S.String,
  /** A name that is not in the list, for the "type a name" box. */
  typedExample: S.String,
});
export type SuggestedList = typeof SuggestedList.Type;

export function suggestedList(file: ChatModels): SuggestedList {
  return {
    revision: file.revision,
    makers: file.makers,
    example: file.example,
    exampleLabel: file.models.find((m) => m.name === file.example)?.label ?? file.example,
    typedExample: file.typedExample,
  };
}

const compiled = new WeakMap<readonly MakerRule[], readonly { name: string; re: RegExp | undefined }[]>();

/** The maker a tag groups under, stable across local aliases, quantizations and hosted copies; "Other" when none matches. */
export function makerIn(makers: readonly MakerRule[], tag: string): string {
  let rules = compiled.get(makers);
  if (rules === undefined) {
    rules = makers.map((m) => ({ name: m.name, re: pattern(m.match) }));
    compiled.set(makers, rules);
  }
  return rules.find((m) => m.re?.test(tag) === true)?.name ?? "Other";
}
