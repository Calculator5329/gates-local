import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { parseRelease } from "./semver.ts";

export interface ReleaseArtifact {
  platform: "linux" | "win32";
  arch: "x64";
  kind: "appimage" | "nsis";
  file: string;
  size: number;
  sha512: string;
}
export interface ReleaseManifest {
  schema: 1;
  version: string;
  commit: string;
  artifacts: ReleaseArtifact[];
}
/**
 * The public halves of the keys that may sign a version list, as base64
 * Ed25519 SPKI. An installed copy accepts a list only when one of these
 * verifies it. docs/releasing.md says how a key is made and replaced.
 */
export const TRUSTED_RELEASE_KEYS: readonly string[] = ["MCowBQYDK2VwAyEAmkifrULbJLUgNyNjPq/gN0LS/MWyENTsD536HKcSu4I="];

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return Object.fromEntries(Object.entries(value));
}
function keys(value: Record<string, unknown>, allowed: readonly string[], field: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${field}.${key} is an unknown key`);
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a nonempty string`);
  return value;
}
export function validateReleaseVersion(value: unknown): string {
  const version = text(value, "version");
  if (!/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version) || parseRelease(`v${version}`) === null) throw new Error("version must be major.minor.patch without a leading v or suffix; each part is at most 6 digits");
  return version;
}
function artifact(value: unknown, index: number, version: string): ReleaseArtifact {
  const field = `artifacts[${index}]`;
  const row = object(value, field);
  keys(row, ["platform", "arch", "kind", "file", "size", "sha512"], field);
  const platform = row["platform"];
  if (platform !== "linux" && platform !== "win32") throw new Error(`${field}.platform must be linux or win32`);
  const arch = row["arch"];
  if (arch !== "x64") throw new Error(`${field}.arch must be x64`);
  const kind = row["kind"];
  const expectedKind = platform === "linux" ? "appimage" : "nsis";
  if (kind !== expectedKind) throw new Error(`${field}.kind must be ${expectedKind} for ${platform}`);
  const file = text(row["file"], `${field}.file`);
  const expected = platform === "linux" ? `Gates-Local-${version}-x86_64.AppImage` : `Gates-Local-${version}-Setup-x64.exe`;
  if (file !== expected) throw new Error(`${field}.file must be ${expected}`);
  const size = row["size"];
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) throw new Error(`${field}.size must be a positive safe integer`);
  const sha512 = text(row["sha512"], `${field}.sha512`);
  if (!/^[a-f0-9]{128}$/.test(sha512)) throw new Error(`${field}.sha512 must be 128 lowercase hex characters`);
  return { platform, arch, kind: expectedKind, file, size, sha512 };
}

function validate(value: unknown): ReleaseManifest {
  const row = object(value, "release");
  keys(row, ["schema", "version", "commit", "artifacts"], "release");
  if (row["schema"] !== 1) throw new Error("schema must be 1; this release schema is not supported");
  const version = validateReleaseVersion(row["version"]);
  const commit = text(row["commit"], "commit");
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("commit must be 40 lowercase hex characters");
  if (!Array.isArray(row["artifacts"]) || row["artifacts"].length === 0) throw new Error("artifacts must be a nonempty array");
  const artifacts = row["artifacts"].map((item: unknown, index: number) => artifact(item, index, version));
  const seen = new Set<string>();
  for (const item of artifacts) {
    if (seen.has(item.platform)) throw new Error(`artifacts contains duplicate platform ${item.platform}`);
    seen.add(item.platform);
  }
  return { schema: 1, version, commit, artifacts };
}

/** Decode only after authenticating untrusted bytes with verifyManifest. */
export function parseManifest(bytes: Uint8Array): ReleaseManifest {
  let input: string;
  try { input = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("release.json must be UTF-8"); }
  let value: unknown;
  try { value = JSON.parse(input); }
  catch { throw new Error("release.json must be valid JSON"); }
  const parsed = validate(value);
  if (!Buffer.from(bytes).equals(encodeManifest(parsed))) throw new Error("release.json bytes must match the canonical encoding");
  return parsed;
}
export function encodeManifest(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(validate(value), null, 2) + "\n", "utf8");
}

/** SPKI DER encoded as canonical base64, one string per trusted Ed25519 public key. The only parser of a trusted entry. */
export function parseReleaseKey(value: string): KeyObject {
  try {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) || value.length === 0) throw new Error();
    const key = createPublicKey({ key: Buffer.from(value, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error();
    return key;
  } catch { throw new Error("release public key must be a base64 SPKI Ed25519 key"); }
}
export function signManifest(bytes: Uint8Array, key: KeyObject): Buffer {
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") throw new Error("release signing key must be an Ed25519 private key");
  return Buffer.from(sign(null, bytes, key).toString("base64") + "\n");
}

/** Authenticate exact bytes before JSON parsing; never reserialize to verify. */
export function verifyManifest(bytes: Uint8Array, signature: Uint8Array, trustedKeys: readonly string[]): ReleaseManifest {
  if (trustedKeys.length === 0) throw new Error("This build has no release key and cannot check updates");
  const line = Buffer.from(signature).toString("utf8");
  if (!/^[A-Za-z0-9+/]{86}==\n$/.test(line)) throw new Error("release signature must be base64 of a 64-byte Ed25519 signature followed by LF");
  const decoded = Buffer.from(line.trimEnd(), "base64");
  if (decoded.length !== 64 || decoded.toString("base64") + "\n" !== line) throw new Error("release signature must be canonical base64 of a 64-byte Ed25519 signature");
  const candidates = trustedKeys.map(parseReleaseKey);
  if (!candidates.some((key) => verify(null, bytes, key, decoded))) throw new Error("release signature does not match a trusted public key");
  return parseManifest(bytes);
}
