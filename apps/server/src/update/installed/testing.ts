// Signed release lists for the installed-copy tests: a key made in memory for
// each test, lists written by the contract's own writer, an in-memory feed in
// place of the network, and a loopback release page for the download's real
// requests. Nothing here writes to disk.
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import http, { type ServerResponse } from "node:http";
import { encodeManifest, signManifest } from "../release-manifest.ts";
import type { Fetched, Get } from "./feed.ts";

export function releaseKey(): { readonly privateKey: KeyObject; readonly publicKey: string } {
  const pair = generateKeyPairSync("ed25519");
  return { privateKey: pair.privateKey, publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64") };
}

export function signedList(version: string, platforms: readonly ("linux" | "win32")[], key: KeyObject): { readonly list: Buffer; readonly sig: Buffer } {
  const artifacts = platforms.map((platform) => platform === "linux"
    ? { platform, arch: "x64", kind: "appimage", file: `Gates-Local-${version}-x86_64.AppImage`, size: 10, sha512: "0".repeat(128) }
    : { platform, arch: "x64", kind: "nsis", file: `Gates-Local-${version}-Setup-x64.exe`, size: 10, sha512: "0".repeat(128) });
  const list = encodeManifest({ schema: 1, version, commit: "a".repeat(40), artifacts });
  return { list, sig: signManifest(list, key) };
}

export const artifactFile = (version: string, platform: "linux" | "win32" = "linux") =>
  platform === "linux" ? `Gates-Local-${version}-x86_64.AppImage` : `Gates-Local-${version}-Setup-x64.exe`;

export const sha512 = (bytes: Uint8Array) => createHash("sha512").update(bytes).digest("hex");

/**
 * A signed list whose artifacts (one per platform, the same bytes) are real:
 * size and SHA-512 from bytes, unless over says otherwise.
 */
export function listFor(version: string, bytes: Buffer, key: KeyObject, over: { readonly size?: number; readonly sha512?: string } = {}): { readonly list: Buffer; readonly sig: Buffer } {
  const artifacts = (["linux", "win32"] as const).map((platform) => ({
    platform, arch: "x64", kind: platform === "linux" ? "appimage" : "nsis", file: artifactFile(version, platform),
    size: over.size ?? bytes.length, sha512: over.sha512 ?? sha512(bytes),
  }));
  const list = encodeManifest({ schema: 1, version, commit: "a".repeat(40), artifacts });
  return { list, sig: signManifest(list, key) };
}

export const BASE = new URL("https://feed.example.invalid/owner/repo/releases");
export const LIST_URL = `${BASE.href}/latest/download/release.json`;
export const SIG_URL = `${LIST_URL}.sig`;

/** An in-memory feed: what each address answers, and every address read. */
export function memoryFeed(answers: Record<string, Fetched> = {}): { readonly get: Get; readonly reads: string[]; answer(url: string, fetched: Fetched): void; serve(files: { list: Buffer; sig: Buffer }): void } {
  const table = new Map(Object.entries(answers));
  const reads: string[] = [];
  return {
    reads,
    get: (url) => {
      reads.push(url.href);
      return Promise.resolve(table.get(url.href) ?? { kind: "failed", detail: "connection refused" });
    },
    answer: (url, fetched) => { table.set(url, fetched); },
    serve: ({ list, sig }) => { table.set(LIST_URL, { kind: "ok", bytes: list }); table.set(SIG_URL, { kind: "ok", bytes: sig }); },
  };
}

/** How the loopback page answers one path; undefined falls through to the served files. */
export type Route = (path: string, res: ServerResponse) => boolean;

export interface ReleasePage {
  /** The base B, an http loopback address (read only with allowLoopbackHttp). */
  readonly base: URL;
  /** Every path asked for, in order. */
  readonly requests: string[];
  /** Resolves once per hang-up seen on an artifact request, in order. */
  readonly hangUps: Promise<void>[];
  serve(files: { readonly list: Buffer; readonly sig: Buffer }, artifact?: { readonly file: string; readonly bytes: Buffer }): void;
  route(route: Route | undefined): void;
  close(): Promise<void>;
}

/** A real http server on a port the system picks (never a runtime's port). */
export async function releasePage(): Promise<ReleasePage> {
  const files = new Map<string, Buffer>();
  const requests: string[] = [];
  const hangUps: Promise<void>[] = [];
  let custom: Route | undefined;
  const server = http.createServer((req, res) => {
    const path = req.url ?? "";
    requests.push(path);
    if (path.includes("/download/v")) {
      const socket = req.socket;
      hangUps.push(new Promise((resolve) => socket.on("close", () => resolve())));
    }
    if (custom?.(path, res) === true) return;
    const body = files.get(path);
    if (body === undefined) res.writeHead(404).end();
    else res.writeHead(200, { "Content-Length": body.length }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    base: new URL(`http://127.0.0.1:${address.port}/r`),
    requests,
    hangUps,
    serve: ({ list, sig }, artifact) => {
      files.set("/r/latest/download/release.json", list);
      files.set("/r/latest/download/release.json.sig", sig);
      if (artifact !== undefined) {
        const version = /Gates-Local-(\d+\.\d+\.\d+)-/.exec(artifact.file)?.[1] ?? "";
        files.set(`/r/download/v${version}/${artifact.file}`, artifact.bytes);
      }
    },
    route: (route) => { custom = route; },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
