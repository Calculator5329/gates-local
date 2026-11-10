// Signed release lists for the installed-copy tests: a key made in memory for
// each test, lists written by the contract's own writer, and an in-memory
// feed in place of the network. Nothing is written to disk.
import { generateKeyPairSync, type KeyObject } from "node:crypto";
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
