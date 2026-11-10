// One check of an installed copy: read the release list and its signature,
// verify them with the contract reader, compare the versions. Nothing is
// downloaded or written. The words for each outcome live in module.ts.
import { type ReleaseArtifact, verifyManifest } from "../release-manifest.ts";
import { compare, parseRelease } from "../semver.ts";
import { FEED_LIMITS, type Get } from "./feed.ts";

export type InstalledOutcome =
  /** The build's version is not major.minor.patch (the default 0.0.0-dev). */
  | { readonly kind: "development" }
  /** No trusted key: no request was made. */
  | { readonly kind: "no-key" }
  | { readonly kind: "unreachable"; readonly detail: string }
  | { readonly kind: "no-list" }
  | { readonly kind: "bad-signature"; readonly detail: string }
  /** The verified list is this version or older. */
  | { readonly kind: "none-found"; readonly listed: string }
  /** artifact: this platform's installer, when the list holds one. */
  | { readonly kind: "newer"; readonly target: string }
  /** signed: the exact bytes verified, which the download stores beside the file. */
  | { readonly kind: "newer"; readonly target: string; readonly artifact: ReleaseArtifact; readonly signed: { readonly list: Buffer; readonly signature: Buffer } };

export interface InstalledCheckOptions {
  /** This copy's own version (app.getVersion()). */
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  /** Base64 SPKI Ed25519 keys; empty means no request at all. */
  readonly keys: readonly string[];
  /** The release page base B: the list is B/latest/download/release.json. */
  readonly base: URL;
  readonly get: Get;
  /** Aborts the check from outside (the module closing). */
  readonly signal: AbortSignal;
  /** The one time budget for the list and its signature together. Default FEED_LIMITS.totalMs; tests shorten it. */
  readonly totalMs?: number;
}

/** The list and signature addresses under B. B never carries a query. */
export function listUrls(base: URL): { list: URL; signature: URL } {
  const root = base.href.replace(/\/+$/, "");
  return { list: new URL(`${root}/latest/download/release.json`), signature: new URL(`${root}/latest/download/release.json.sig`) };
}

export async function checkInstalled(o: InstalledCheckOptions): Promise<InstalledOutcome> {
  const own = parseRelease(`v${o.version}`);
  if (own === null) return { kind: "development" };
  if (o.keys.length === 0) return { kind: "no-key" };
  // The only total clock: both reads, every redirect, share this one deadline.
  const totalMs = o.totalMs ?? FEED_LIMITS.totalMs;
  const clock = new AbortController();
  const timer = setTimeout(() => clock.abort(new Error(`the check took longer than ${totalMs / 1000} seconds`)), totalMs);
  timer.unref?.();
  try {
    return await readAndCompare(o, own, AbortSignal.any([o.signal, clock.signal]));
  } finally {
    clearTimeout(timer);
  }
}

async function readAndCompare(o: InstalledCheckOptions, own: NonNullable<ReturnType<typeof parseRelease>>, signal: AbortSignal): Promise<InstalledOutcome> {
  const urls = listUrls(o.base);
  const list = await o.get(urls.list, FEED_LIMITS.listBytes, signal);
  if (list.kind === "missing") return { kind: "no-list" };
  if (list.kind === "failed") return { kind: "unreachable", detail: list.detail };
  if (list.kind === "too-large") return { kind: "bad-signature", detail: `release.json is larger than ${FEED_LIMITS.listBytes} bytes` };
  const signature = await o.get(urls.signature, FEED_LIMITS.signatureBytes, signal);
  if (signature.kind === "failed") return { kind: "unreachable", detail: signature.detail };
  // A list without its signature cannot be trusted, so it is ignored like a bad one.
  if (signature.kind === "missing") return { kind: "bad-signature", detail: "release.json.sig is missing" };
  if (signature.kind === "too-large") return { kind: "bad-signature", detail: `release.json.sig is larger than ${FEED_LIMITS.signatureBytes} bytes` };
  let manifest;
  try { manifest = verifyManifest(list.bytes, signature.bytes, o.keys); }
  catch (error) { return { kind: "bad-signature", detail: error instanceof Error ? error.message : String(error) }; }
  const listed = parseRelease(`v${manifest.version}`);
  // verifyManifest admits only versions parseRelease reads; this is the type's due.
  if (listed === null || compare(listed, own) <= 0) return { kind: "none-found", listed: manifest.version };
  const artifact = manifest.artifacts.find((a) => a.platform === o.platform && a.arch === o.arch);
  return artifact === undefined ? { kind: "newer", target: manifest.version } : { kind: "newer", target: manifest.version, artifact, signed: { list: list.bytes, signature: signature.bytes } };
}
