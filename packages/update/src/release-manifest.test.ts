import { generateKeyPairSync, sign } from "node:crypto";
import { expect, test } from "vitest";
import { encodeManifest, parseManifest, parseReleaseKey, signManifest, TRUSTED_RELEASE_KEYS, validateReleaseVersion, verifyManifest } from "./release-manifest.ts";

const pair = generateKeyPairSync("ed25519");
const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const value = () => ({ schema: 1, version: "1.2.3", commit: "a".repeat(40), artifacts: [
  { platform: "linux", arch: "x64", kind: "appimage", file: "Gates-Local-1.2.3-x86_64.AppImage", size: 12, sha512: "b".repeat(128) },
] });
const raw = (input: unknown) => Buffer.from(JSON.stringify(input, null, 2) + "\n");
const signedBytes = (bytes: Uint8Array, key = pair.privateKey) => Buffer.from(sign(null, bytes, key).toString("base64") + "\n");

test("manifest round trip signs the exact bytes and accepts any trusted key", () => {
  const bytes = encodeManifest(value());
  expect(bytes).toEqual(raw(value()));
  const signature = signManifest(bytes, pair.privateKey);
  expect(signature.toString()).toMatch(/^[A-Za-z0-9+/]{86}==\n$/);
  const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
  expect(verifyManifest(bytes, signature, [other, publicKey])).toEqual(value());
});

test("every public key in the source trusted list passes the parser installed copies use", () => {
  // One entry the runtime parser refuses makes every update check throw, even beside a good key.
  for (const entry of TRUSTED_RELEASE_KEYS) expect(parseReleaseKey(entry).asymmetricKeyType).toBe("ed25519");
});
test.each([["without padding", (key: string) => key.replace(/=+$/, "")], ["with a trailing newline", (key: string) => key + "\n"], ["with a leading space", (key: string) => " " + key]])("the trusted-list parser refuses a real key %s", (_name, spoil) => {
  const key = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
  expect(parseReleaseKey(key).asymmetricKeyType).toBe("ed25519");
  expect(() => parseReleaseKey(spoil(key))).toThrow("base64 SPKI Ed25519 key");
});

test.each(["CON.exe", "installer.", "Gates.bat", "release.json", "Gates-Local-1.2.4-x86_64.AppImage"])("refuses file outside exact artifact shape: %s", (file) => {
  const v = value(); v.artifacts[0]!.file = file;
  expect(() => parseManifest(raw(v))).toThrow("file");
});
test.each([
  ["platform", 7], ["platform", "darwin"], ["arch", 7], ["arch", "arm64"], ["kind", 7], ["kind", "nsis"],
])("refuses artifact %s value %s", (field, replacement) => {
  const v = value();
  const input = { ...v, artifacts: [{ ...v.artifacts[0], [field]: replacement }] };
  expect(() => parseManifest(raw(input))).toThrow(String(field));
});

test.each(["1000000.1.1", "1.1000000.1", "1.1.1000000"])("refuses a version part over six digits: %s", (version) => {
  expect(() => validateReleaseVersion(version)).toThrow("version");
});
test("six-digit version parts remain valid", () => {
  expect(validateReleaseVersion("999999.999999.999999")).toBe("999999.999999.999999");
});

test.each([
  ["duplicate version key", () => raw(value()).toString().replace('"version": "1.2.3",', '"version": "1.2.3", "version": "1.2.3",')],
  ["compact JSON", () => JSON.stringify(value()) + "\n"],
  ["byte order mark", () => "\ufeff" + raw(value()).toString()],
  ["schema 1.0", () => raw(value()).toString().replace('"schema": 1,', '"schema": 1.0,')],
  ["space before final LF", () => raw(value()).toString().trimEnd() + " \n"],
  ["CRLF", () => raw(value()).toString().replaceAll("\n", "\r\n")],
  ["double trailing LF", () => raw(value()).toString() + "\n"],
])("refuses noncanonical bytes: %s", (_name, bytes) => {
  const input = Buffer.from(bytes());
  expect(() => verifyManifest(input, signedBytes(input), [publicKey])).toThrow("canonical");
});

test.each([
  ["changed manifest byte", "signature"], ["another signing key", "signature"],
  ["truncated signature", "64-byte"], ["empty trusted list", "no release key"],
  ["malformed public key", "public key"],
])("refuses %s before parsing", (cause, message) => {
  let bytes = raw(value());
  let signature = signedBytes(bytes);
  let keys = [publicKey];
  if (cause === "changed manifest byte") bytes = Buffer.from(bytes.toString().replace("1.2.3", "1.2.4"));
  if (cause === "another signing key") signature = signedBytes(bytes, generateKeyPairSync("ed25519").privateKey);
  if (cause === "truncated signature") signature = Buffer.from("AA==\n");
  if (cause === "empty trusted list") keys = [];
  if (cause === "malformed public key") keys = ["not-a-key"];
  expect(() => verifyManifest(bytes, signature, keys)).toThrow(message);
});

test("signature failure wins over invalid JSON", () => {
  expect(() => verifyManifest(Buffer.from("not JSON"), Buffer.from("A".repeat(86) + "==\n"), [publicKey])).toThrow("signature");
});

test("signature refuses non-ASCII bytes even if their low seven bits spell base64", () => {
  const bytes = raw(value());
  const signature = signedBytes(bytes);
  signature[0] = signature[0]! | 0x80;
  expect(() => verifyManifest(bytes, signature, [publicKey])).toThrow("signature");
});

const invalid: [string, () => unknown, string][] = [
  ...["../escape", "sub/file", "sub\\file", "bad..name", ".hidden", ""].map((file): [string, () => unknown, string] => [
    `file ${JSON.stringify(file)}`, () => { const v = value(); v.artifacts[0]!.file = file; return v; }, "file",
  ]),
  ["unknown top-level key", () => ({ ...value(), extra: true }), "extra"],
  ["unknown artifact key", () => { const v = value(); return { ...v, artifacts: [{ ...v.artifacts[0], extra: true }] }; }, "extra"],
  ["wrong version type", () => ({ ...value(), version: 1 }), "version"],
  ["wrong artifacts type", () => ({ ...value(), artifacts: {} }), "artifacts"],
  ["wrong size type", () => { const v = value(); return { ...v, artifacts: [{ ...v.artifacts[0], size: "12" }] }; }, "size"],
  ["unknown schema", () => ({ ...value(), schema: 2 }), "schema"],
  ["duplicate platform", () => { const v = value(); v.artifacts.push({ ...v.artifacts[0]! }); return v; }, "duplicate"],
  ["leading v", () => ({ ...value(), version: "v1.2.3" }), "version"],
  ["pre-release", () => ({ ...value(), version: "1.2.3-rc.1" }), "version"],
  ["unsafe size", () => { const v = value(); v.artifacts[0]!.size = Number.MAX_SAFE_INTEGER + 1; return v; }, "size"],
  ["empty artifacts", () => ({ ...value(), artifacts: [] }), "artifacts"],
  ["bad hash", () => { const v = value(); v.artifacts[0]!.sha512 = "bad"; return v; }, "sha512"],
  ["bad commit", () => ({ ...value(), commit: "ABC" }), "commit"],
];
test.each(invalid)("refuses signed manifest: %s", (_name, input, message) => {
  const bytes = raw(input());
  // Signing accepts bytes; verification authenticates them before decoding fields.
  const signature = signedBytes(bytes);
  expect(() => verifyManifest(bytes, signature, [publicKey])).toThrow(message);
  expect(() => parseManifest(bytes)).toThrow(message);
});
