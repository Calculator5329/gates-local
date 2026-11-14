// The chat model list an installed copy takes from its release page, so a new
// model shows up without a release (owner, proposal 13 option A).
//
// models.json and models.json.sig sit beside release.json and are read by the
// same bounded read (feed.ts, FEED_LIMITS.modelsBytes and signatureBytes),
// from the same base, with no query string, and verified by the same key and
// the same check (verifySigned) as release.json. The file is
//   { "schema": 1, "chat": <a chat-models.json list> }
// and its chat list goes through parseChatModels, the reader of the built-in
// list. The list is used only when its schema is known and its revision is
// higher than the list in use; the verified bytes and their signature are then
// kept in <data dir>/models-list/ and checked again on the next start.
//
// A missing models.json (every release before this one) says nothing. A list
// that fails its size, signature or shape is dropped and logged once, and the
// copy keeps the list it has. Nothing here changes an update check's verdict.
// A downloaded list names models and their numbers (sizes, memory tiers,
// maker patterns): it never names a file to fetch or code to run.
import { type ChatModels, parseChatModels } from "@gates-local/contracts";
import fs from "node:fs";
import path from "node:path";
import { verifySigned } from "../release-manifest.ts";
import { FEED_LIMITS, type Get } from "./feed.ts";

export const MODELS_SCHEMA = 1;
export const MODELS_DIR = "models-list";
export const MODELS_FILE = "models.json";
export const MODELS_SIGNATURE_FILE = "models.json.sig";

export type ListOutcome =
  /** No models.json on the release page, or none kept: silent. */
  | { readonly kind: "missing" }
  | { readonly kind: "unreachable"; readonly detail: string }
  /** Too large, unsigned, wrongly signed, an unknown schema or a list that does not hold together. */
  | { readonly kind: "refused"; readonly detail: string }
  /** Verified, but its revision is not higher than the list in use. */
  | { readonly kind: "not-newer"; readonly revision: number; readonly inUse: number }
  | { readonly kind: "used"; readonly revision: number };

export interface ModelListsDeps {
  /** The server's --data-dir; the kept list goes in its models-list/ folder. */
  readonly dataDir: string;
  /** The release page base B, as the update check reads it. */
  readonly base: URL;
  /** The same release keys release.json is verified with. */
  readonly keys: readonly string[];
  readonly get: Get;
  /** The list this server uses now (runtime/chat-list.ts). */
  readonly inUse: () => ChatModels;
  readonly use: (list: ChatModels) => void;
  readonly log?: (line: string) => void;
  /** One time budget for the list and its signature together. Default FEED_LIMITS.totalMs; tests shorten it. */
  readonly totalMs?: number;
}

export interface ModelLists {
  /** On start: the kept list, verified again, when it is newer than the list in use. */
  readonly loadStored: () => ListOutcome;
  /** After a check whose release.json verified: read, verify and maybe use the release page's list. */
  readonly refresh: (signal: AbortSignal) => Promise<ListOutcome>;
}

/** The list and signature addresses under B, beside release.json. */
export function modelsUrls(base: URL): { list: URL; signature: URL } {
  const root = base.href.replace(/\/+$/, "");
  return { list: new URL(`${root}/latest/download/${MODELS_FILE}`), signature: new URL(`${root}/latest/download/${MODELS_SIGNATURE_FILE}`) };
}

/** The bytes the release kit signs: two-space JSON and one trailing LF. */
export function encodeModelsFile(chat: unknown, schema: number = MODELS_SCHEMA): Buffer {
  return Buffer.from(JSON.stringify({ schema, chat }, null, 2) + "\n", "utf8");
}

/** Decode only bytes verifySigned accepted. Throws with the reason. */
export function parseModelsFile(bytes: Uint8Array): ChatModels {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error(`${MODELS_FILE} must be UTF-8`); }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error(`${MODELS_FILE} must be valid JSON`); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${MODELS_FILE} must be an object`);
  const schema: unknown = Reflect.get(value, "schema");
  if (schema !== MODELS_SCHEMA) throw new Error(`${MODELS_FILE} schema ${String(schema)} is not one this copy reads`);
  return parseChatModels(Reflect.get(value, "chat"), `${MODELS_FILE} chat`);
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createModelLists(deps: ModelListsDeps): ModelLists {
  const log = deps.log ?? (() => undefined);
  const folder = path.join(deps.dataDir, MODELS_DIR);
  const listFile = path.join(folder, MODELS_FILE);
  const signatureFile = path.join(folder, MODELS_SIGNATURE_FILE);
  // The hourly check would say the same thing every hour: each reason is logged once in a row.
  let lastLogged: string | undefined;
  const note = (line: string) => {
    if (line === lastLogged) return;
    lastLogged = line;
    log(line);
  };
  const refused = (where: string, detail: string): ListOutcome => {
    note(`chat model list ${where} not used: ${detail}`);
    return { kind: "refused", detail };
  };

  /** Verified bytes: their list, or the reason it is refused. */
  const read = (list: Buffer, signature: Buffer): ChatModels | Error => {
    try {
      verifySigned(list, signature, deps.keys);
      return parseModelsFile(list);
    } catch (error) {
      return error instanceof Error ? error : new Error(message(error));
    }
  };

  /** Use the list when it is newer than the one in use. */
  const consider = (list: ChatModels): ListOutcome => {
    const inUse = deps.inUse().revision;
    if (list.revision <= inUse) return { kind: "not-newer", revision: list.revision, inUse };
    deps.use(list);
    lastLogged = undefined;
    return { kind: "used", revision: list.revision };
  };

  /** Each file written whole beside itself, then renamed into place. */
  const keep = (list: Buffer, signature: Buffer) => {
    fs.mkdirSync(folder, { recursive: true });
    for (const [file, bytes] of [[signatureFile, signature], [listFile, list]] as const) {
      const part = `${file}.part`;
      fs.writeFileSync(part, bytes);
      fs.renameSync(part, file);
    }
  };

  const loadStored = (): ListOutcome => {
    let list: Buffer, signature: Buffer;
    try {
      if (!fs.lstatSync(listFile).isFile() || !fs.lstatSync(signatureFile).isFile()) return refused("kept in the data folder", "a kept file is not a regular file");
      list = fs.readFileSync(listFile);
      signature = fs.readFileSync(signatureFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
      return refused("kept in the data folder", message(error));
    }
    if (list.length > FEED_LIMITS.modelsBytes || signature.length > FEED_LIMITS.signatureBytes) return refused("kept in the data folder", "a kept file is larger than its limit");
    const parsed = read(list, signature);
    return parsed instanceof Error ? refused("kept in the data folder", parsed.message) : consider(parsed);
  };

  const refresh = async (outer: AbortSignal): Promise<ListOutcome> => {
    const totalMs = deps.totalMs ?? FEED_LIMITS.totalMs;
    const clock = new AbortController();
    const timer = setTimeout(() => clock.abort(new Error(`the model list took longer than ${totalMs / 1000} seconds`)), totalMs);
    timer.unref?.();
    const signal = AbortSignal.any([outer, clock.signal]);
    try {
      const urls = modelsUrls(deps.base);
      const list = await deps.get(urls.list, FEED_LIMITS.modelsBytes, signal);
      if (list.kind === "missing") return { kind: "missing" };
      if (list.kind === "failed") { note(`chat model list not read: ${list.detail}`); return { kind: "unreachable", detail: list.detail }; }
      if (list.kind === "too-large") return refused("from the release page", `${MODELS_FILE} is larger than ${FEED_LIMITS.modelsBytes} bytes`);
      const signature = await deps.get(urls.signature, FEED_LIMITS.signatureBytes, signal);
      if (signature.kind === "failed") { note(`chat model list not read: ${signature.detail}`); return { kind: "unreachable", detail: signature.detail }; }
      if (signature.kind === "missing") return refused("from the release page", `${MODELS_SIGNATURE_FILE} is missing`);
      if (signature.kind === "too-large") return refused("from the release page", `${MODELS_SIGNATURE_FILE} is larger than ${FEED_LIMITS.signatureBytes} bytes`);
      const parsed = read(list.bytes, signature.bytes);
      if (parsed instanceof Error) return refused("from the release page", parsed.message);
      if (parsed.revision <= deps.inUse().revision) return consider(parsed);
      // Kept before it is used, so it survives a restart; one that cannot be written is still used until then.
      try { keep(list.bytes, signature.bytes); }
      catch (error) { note(`chat model list not kept: ${message(error)}`); }
      return consider(parsed);
    } finally {
      clearTimeout(timer);
    }
  };

  return { loadStored, refresh };
}
