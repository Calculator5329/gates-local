import * as S from "effect/Schema";
import { FitError } from "./types.ts";
import { sendSpan } from "../chat/send-times.ts";

const TagsResponse = S.Struct({
  models: S.Array(
    S.Struct({
      name: S.String,
      model: S.optional(S.String),
      size: S.Number,
      digest: S.optional(S.String),
    }),
  ),
});
export type TagsResponse = typeof TagsResponse.Type;

const ShowResponse = S.Struct({
  system: S.optional(S.String),
  parameters: S.optional(S.String),
  model_info: S.optional(S.Record(S.String, S.Unknown)),
  capabilities: S.optional(S.Array(S.String)),
});
export type ShowResponse = typeof ShowResponse.Type;

// external: Ollama's verbose /api/show carries the whole vocabulary beside the tensor list, about 12 MB for a gemma4 file.
const TensorsResponse = S.Struct({
  tensors: S.optional(S.Array(S.Struct({ name: S.String, type: S.String, shape: S.Array(S.Number) }))),
});
export type TensorsResponse = typeof TensorsResponse.Type;

const PsEntry = S.Struct({
  name: S.String,
  model: S.optional(S.String),
  size: S.Number,
  size_vram: S.Number,
  context_length: S.optional(S.Number),
  expires_at: S.optional(S.String),
});
export type PsEntry = typeof PsEntry.Type;

const PsResponse = S.Struct({ models: S.Array(PsEntry) });
export type PsResponse = typeof PsResponse.Type;

const USUAL_TIMEOUT_MS = 15_000;

function request(baseUrl: string, path: string, init: RequestInit | undefined): Promise<unknown> {
  return sendSpan(path.replace("/api/", ""), () => requestNow(baseUrl, path, init));
}

async function requestNow(baseUrl: string, path: string, init: RequestInit | undefined): Promise<unknown> {
  const url = new URL(path, baseUrl);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(USUAL_TIMEOUT_MS) });
  } catch (error) {
    throw new FitError("runtime-unreachable", `${url.href}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  if (response.status === 404) throw new FitError("model-not-found", `${url.pathname} 404: ${text.slice(0, 200)}`);
  if (!response.ok) throw new FitError("runtime-bad-response", `${url.pathname} HTTP ${response.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new FitError("runtime-bad-response", `${url.pathname} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

function decode<Sch extends S.ConstraintDecoder<unknown>>(schema: Sch, path: string, value: unknown): Sch["Type"] {
  try {
    return S.decodeUnknownSync(schema)(value);
  } catch (error) {
    throw new FitError("runtime-bad-response", `${path} did not match the expected shape: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const withSignal = (signal: AbortSignal | undefined): RequestInit => (signal === undefined ? {} : { signal: AbortSignal.any([signal, AbortSignal.timeout(USUAL_TIMEOUT_MS)]) });

export async function fetchTags(baseUrl: string, signal?: AbortSignal): Promise<TagsResponse> {
  return decode(TagsResponse, "/api/tags", await request(baseUrl, "/api/tags", withSignal(signal)));
}

export async function fetchShow(baseUrl: string, model: string, signal?: AbortSignal): Promise<ShowResponse> {
  const body = await request(baseUrl, "/api/show", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model }),
    ...withSignal(signal),
  });
  return decode(ShowResponse, "/api/show", body);
}

export async function fetchTensors(baseUrl: string, model: string, signal?: AbortSignal): Promise<TensorsResponse> {
  const body = await request(baseUrl, "/api/show", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, verbose: true }),
    ...withSignal(signal),
  });
  return decode(TensorsResponse, "/api/show", body);
}

export async function fetchPs(baseUrl: string, signal?: AbortSignal): Promise<PsResponse> {
  return decode(PsResponse, "/api/ps", await request(baseUrl, "/api/ps", withSignal(signal)));
}

// external: Ollama reads a name with no tag as that name with ":latest".
const withTag = (name: string) => (name.includes(":") ? name : `${name}:latest`);

export function sameModel(a: string, b: string): boolean {
  return withTag(a) === withTag(b);
}

export function isCopyOf(listed: PsEntry, model: string): boolean {
  const underItsOwnName = sameModel(listed.name, model);
  const underAnotherName = listed.model !== undefined && sameModel(listed.model, model);
  return underItsOwnName || underAnotherName;
}

export function findLoaded(ps: PsResponse, model: string): PsEntry | undefined {
  return ps.models.find((m) => isCopyOf(m, model));
}
