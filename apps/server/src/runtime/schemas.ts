import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export const VersionResponse = Schema.Struct({ version: Schema.String });

const TagDetails = Schema.Struct({
  family: Schema.optionalKey(Schema.String),
  parameter_size: Schema.optionalKey(Schema.String),
  quantization_level: Schema.optionalKey(Schema.String),
});

export const TagsResponse = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      digest: Schema.String,
      size: Schema.Number,
      modified_at: Schema.String,
      details: Schema.optionalKey(TagDetails),
    }),
  ),
});

export const PsResponse = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      size: Schema.Number,
      size_vram: Schema.Number,
      expires_at: Schema.optionalKey(Schema.String),
      context_length: Schema.optionalKey(Schema.Number),
    }),
  ),
});

// external: Ollama can answer a failed load with HTTP 200 and an error field.
export const GenerateResponse = Schema.Struct({
  done: Schema.optionalKey(Schema.Boolean),
  error: Schema.optionalKey(Schema.String),
});

export const InstallManifest = Schema.Struct({
  version: Schema.String,
  url: Schema.String,
  sha256: Schema.String,
  sizeBytes: Schema.Number,
  unpackedBytes: Schema.optional(Schema.Number),
  format: Schema.Literals(["tar.zst", "tar.gz", "zip", "7z"]),
  verified: Schema.Boolean,
  source: Schema.String,
});
export type InstallManifest = typeof InstallManifest.Type;

export function decode<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
): { ok: true; value: S["Type"] } | { ok: false; message: string } {
  const r = Schema.decodeUnknownResult(schema)(input);
  if (Result.isSuccess(r)) return { ok: true, value: r.success };
  return { ok: false, message: r.failure.message };
}

export function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}
