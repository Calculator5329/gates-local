import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import { MeasureChat, type MeasureCheck, type MeasurePart, type MeasureTurn, type ModelMeasure, type ToolStep } from "@gates-local/contracts";
import { CASES, type MeasureCase } from "./cases.ts";

export function turnOf(c: MeasureCase): MeasureTurn {
  const mine = CASES.filter((x) => x.part === c.part);
  return { id: c.id, part: c.part, n: mine.indexOf(c) + 1, of: mine.length, prompt: c.prompt, ...(c.history ? { history: c.history } : {}), thinking: "", answer: "", steps: [] };
}

// why: the eight checks of a measure without a version are kinds "tools" and "sql".
const partOfKind = (kind: MeasureCheck["kind"]): MeasurePart => (kind === "sql" ? "database" : kind);

const ARROW = " → ";
const parsed = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
};

// why: a kept line is `name {input} → output`; the chat's detail is the call's JSON, then output
function stepOfCall(id: string, line: string, i: number): ToolStep {
  const cut = line.indexOf(ARROW);
  const head = cut < 0 ? line : line.slice(0, cut);
  const space = head.indexOf(" ");
  const name = space < 0 ? head : head.slice(0, space);
  const input = space < 0 ? undefined : parsed(head.slice(space + 1));
  const call = input === undefined ? head : JSON.stringify({ name, input });
  return { callId: `${id}-${i}`, name, state: "done", summary: head, detail: cut < 0 ? call : `${call}\n${line.slice(cut + ARROW.length)}` };
}

// why: a measure older than kept chats is rebuilt from its checks, asked as this build asks them
export function chatOf(m: ModelMeasure, kept: MeasureChat | undefined): MeasureChat {
  if (kept !== undefined && kept.at === m.at) return kept;
  const parts = m.checks.map((check) => CASES.find((c) => c.id === check.id)?.part ?? partOfKind(check.kind));
  const turns = m.checks.map((check, i): MeasureTurn => {
    const c = CASES.find((x) => x.id === check.id);
    const part = parts[i]!;
    return {
      id: check.id, part, n: parts.slice(0, i + 1).filter((p) => p === part).length, of: parts.filter((p) => p === part).length,
      ...(c ? { prompt: c.prompt, ...(c.history ? { history: c.history } : {}) } : {}),
      thinking: "", answer: check.reply ?? "", steps: (check.calls ?? []).map((line, n) => stepOfCall(check.id, line, n)),
    };
  });
  return { model: m.model, at: m.at, turns };
}

const FILE = "measure-chats.json";
const decodeFile = S.decodeUnknownSync(S.Struct({ version: S.Finite, chats: S.Array(S.Unknown) }));
const decodeChat = S.decodeUnknownOption(MeasureChat);

export interface ChatStore {
  get(model: string): MeasureChat | undefined;
  put(chat: MeasureChat): void;
}

// why: one chat per model, its last run's; a chat this build cannot read is dropped, not fatal
export function chatStore(dataDir: string): ChatStore {
  const file = path.join(dataDir, FILE);
  let cache: MeasureChat[] | undefined;
  const read = (): MeasureChat[] => {
    if (cache) return cache;
    try {
      cache = decodeFile(JSON.parse(readFileSync(file, "utf8"))).chats.flatMap((raw) => Option.toArray(decodeChat(raw)));
    } catch {
      cache = [];
    }
    return cache;
  };
  return {
    get: (model) => read().find((c) => c.model === model),
    put(chat) {
      const turns = chat.turns.map(({ check: _check, ...t }) => t);
      const chats = [...read().filter((c) => c.model !== chat.model), { ...chat, turns }];
      mkdirSync(dataDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ version: 1, chats })}\n`);
      renameSync(tmp, file);
      cache = chats;
    },
  };
}
