import { type ReleaseArtifact, verifyManifest } from "@gates-local/update/release-manifest";
import { compare, parseRelease } from "@gates-local/update/semver";
import { FEED_LIMITS, type Get } from "@gates-local/update/installed/feed";

export type InstalledOutcome =
  | { readonly kind: "development" }
  | { readonly kind: "no-key" }
  | { readonly kind: "unreachable"; readonly detail: string }
  | { readonly kind: "no-list" }
  | { readonly kind: "bad-signature"; readonly detail: string }
  | { readonly kind: "none-found"; readonly listed: string }
  | { readonly kind: "newer"; readonly target: string }
  | { readonly kind: "newer"; readonly target: string; readonly artifact: ReleaseArtifact; readonly signed: { readonly list: Buffer; readonly signature: Buffer } };

export interface InstalledCheckOptions {
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  readonly keys: readonly string[];
  readonly base: URL;
  readonly get: Get;
  readonly signal: AbortSignal;
  readonly totalMs?: number;
}

export function listUrls(base: URL): { list: URL; signature: URL } {
  const root = base.href.replace(/\/+$/, "");
  return { list: new URL(`${root}/latest/download/release.json`), signature: new URL(`${root}/latest/download/release.json.sig`) };
}

export async function checkInstalled(o: InstalledCheckOptions): Promise<InstalledOutcome> {
  const own = parseRelease(`v${o.version}`);
  if (own === null) return { kind: "development" };
  if (o.keys.length === 0) return { kind: "no-key" };
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
  if (signature.kind === "missing") return { kind: "bad-signature", detail: "release.json.sig is missing" };
  if (signature.kind === "too-large") return { kind: "bad-signature", detail: `release.json.sig is larger than ${FEED_LIMITS.signatureBytes} bytes` };
  let manifest;
  try { manifest = verifyManifest(list.bytes, signature.bytes, o.keys); }
  catch (error) { return { kind: "bad-signature", detail: error instanceof Error ? error.message : String(error) }; }
  const listed = parseRelease(`v${manifest.version}`);
  // why: verifyManifest admits only versions parseRelease reads, so null never comes here
  if (listed === null || compare(listed, own) <= 0) return { kind: "none-found", listed: manifest.version };
  const artifact = manifest.artifacts.find((a) => a.platform === o.platform && a.arch === o.arch);
  return artifact === undefined ? { kind: "newer", target: manifest.version } : { kind: "newer", target: manifest.version, artifact, signed: { list: list.bytes, signature: signature.bytes } };
}
