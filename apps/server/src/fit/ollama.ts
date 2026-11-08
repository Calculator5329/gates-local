// The three Ollama reads the fit check needs: /api/tags (weights size),
// /api/show (architecture) and /api/ps (what is loaded and where). Effect
// Schema decodes each response at the boundary; unknown keys are ignored.
import { Schema as S } from "effect";
import { FitError } from "./types.ts";

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
  model_info: S.optional(S.Record(S.String, S.Unknown)),
  capabilities: S.optional(S.Array(S.String)),
});
export type ShowResponse = typeof ShowResponse.Type;

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

async function request(baseUrl: string, path: string, init: RequestInit | undefined): Promise<unknown> {
  const url = new URL(path, baseUrl);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000) });
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

export async function fetchTags(baseUrl: string): Promise<TagsResponse> {
  return decode(TagsResponse, "/api/tags", await request(baseUrl, "/api/tags", undefined));
}

/** `signal` ends the request early; it is combined with the usual 15 s timeout. */
export async function fetchShow(baseUrl: string, model: string, signal?: AbortSignal): Promise<ShowResponse> {
  const body = await request(baseUrl, "/api/show", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model }),
    ...(signal === undefined ? {} : { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) }),
  });
  return decode(ShowResponse, "/api/show", body);
}

export async function fetchPs(baseUrl: string): Promise<PsResponse> {
  return decode(PsResponse, "/api/ps", await request(baseUrl, "/api/ps", undefined));
}

/** Ollama names carry an implicit ":latest"; match either spelling. */
const withTag = (name: string) => (name.includes(":") ? name : `${name}:latest`);

export function sameModel(a: string, b: string): boolean {
  return withTag(a) === withTag(b);
}

export function findLoaded(ps: PsResponse, model: string): PsEntry | undefined {
  return ps.models.find((m) => sameModel(m.name, model) || (m.model !== undefined && sameModel(m.model, model)));
}
