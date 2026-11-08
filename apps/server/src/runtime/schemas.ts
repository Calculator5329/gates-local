// Effect Schemas for everything the runtime module reads from outside:
// Ollama HTTP responses, the ownership state file and the install manifest.
import { Result, Schema } from "effect";

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
      /** The num_ctx the model is loaded at; absent (older Ollama) means unknown. */
      context_length: Schema.optionalKey(Schema.Number),
    }),
  ),
});

/** POST /api/generate with stream false: one object; a load that failed may still be HTTP 200 with `error`. */
export const GenerateResponse = Schema.Struct({
  done: Schema.optionalKey(Schema.Boolean),
  error: Schema.optionalKey(Schema.String),
});

export const OwnedRecord = Schema.Struct({
  pid: Schema.Number,
  startTime: Schema.String,
  command: Schema.String,
  baseUrl: Schema.String,
  binary: Schema.String,
  startedAt: Schema.Number,
});
export type OwnedRecord = typeof OwnedRecord.Type;

export const InstallManifest = Schema.Struct({
  version: Schema.String,
  url: Schema.String,
  sha256: Schema.String,
  sizeBytes: Schema.Number,
  /** tar.zst and tar.gz: the Linux releases. zip: the Windows release. */
  format: Schema.Literals(["tar.zst", "tar.gz", "zip"]),
  verified: Schema.Boolean,
  source: Schema.String,
});
export type InstallManifest = typeof InstallManifest.Type;

/** Decode or return a readable message; never throws. */
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
