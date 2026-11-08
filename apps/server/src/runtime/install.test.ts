import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InstallError, installPinned } from "./install.ts";
import { installDir, installedBinary, runtimeDir } from "./paths.ts";
import type { InstallManifest } from "./schemas.ts";
import { FAKE_RELEASE_FORMAT, FAKE_RELEASE_LIB, type ReleaseServer, buildFakeRelease, removeDir, startReleaseServer, tmpDir } from "./test-fakes.ts";
import type { InstallProgress } from "./types.ts";

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let work: string;
let appDataDir: string;
let tarball: Buffer;
let server: ReleaseServer;

function manifest(over: Partial<InstallManifest> = {}): InstallManifest {
  return {
    version: "9.9.9-test",
    url: server.url,
    sha256: sha256(tarball),
    sizeBytes: tarball.length,
    format: FAKE_RELEASE_FORMAT,
    verified: true,
    source: "test",
    ...over,
  };
}

/** Nothing half-installed: no version dir, no staging dirs. */
function expectNothingInstalled(version = "9.9.9-test") {
  expect(existsSync(installDir(appDataDir, version))).toBe(false);
  const left = existsSync(runtimeDir(appDataDir)) ? readdirSync(runtimeDir(appDataDir)).filter((e) => e.startsWith(".staging-")) : [];
  expect(left).toEqual([]);
}

async function expectInstallError(p: Promise<unknown>, code: string): Promise<InstallError> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(InstallError);
  expect((e as InstallError).code).toBe(code);
  return e as InstallError;
}

beforeEach(async () => {
  work = tmpDir("install");
  appDataDir = path.join(work, "data", "gates-local");
  // This host's release: tar.zst with bin/ollama on Linux, a ZIP with ollama.exe on Windows.
  tarball = buildFakeRelease(work);
  server = await startReleaseServer(tarball);
});

afterEach(async () => {
  await server.close();
  removeDir(work);
});

describe("installPinned", () => {
  it("downloads, verifies, extracts and renames into runtime/ollama/<version>", async () => {
    const events: InstallProgress[] = [];
    const r = await installPinned({ appDataDir, manifest: manifest(), onProgress: (p) => events.push(p), progressIntervalMs: 0 });
    expect(r.alreadyInstalled).toBe(false);
    expect(r.binary).toBe(installedBinary(appDataDir, "9.9.9-test"));
    accessSync(r.binary, constants.X_OK);
    expect(existsSync(path.join(r.dir, FAKE_RELEASE_LIB))).toBe(true);
    const phases = [...new Set(events.map((e) => e.phase))];
    expect(phases).toEqual(["download", "verify", "extract", "done"]);
    expect(events.filter((e) => e.phase === "download").at(-1)?.receivedBytes).toBe(tarball.length);
    expect(readdirSync(runtimeDir(appDataDir)).filter((e) => e.startsWith(".staging-"))).toEqual([]);
  });

  it("skips the download when the pinned version is already installed", async () => {
    await installPinned({ appDataDir, manifest: manifest() });
    const hits = server.hits;
    const r = await installPinned({ appDataDir, manifest: manifest() });
    expect(r.alreadyInstalled).toBe(true);
    expect(server.hits).toBe(hits);
  });

  it("refuses a bad hash with a usable message and leaves nothing installed", async () => {
    const bad = "0".repeat(64);
    const e = await expectInstallError(installPinned({ appDataDir, manifest: manifest({ sha256: bad }) }), "hash-mismatch");
    expect(e.message).toContain("did not match its pinned checksum");
    expect(e.message).toContain(bad);
    expect(e.message).toContain(sha256(tarball));
    expect(e.message).toContain("Nothing was installed");
    expectNothingInstalled();
  });

  it("an interrupted download leaves nothing installed and says to retry", async () => {
    server.mode = "truncate";
    const e = await expectInstallError(installPinned({ appDataDir, manifest: manifest() }), "interrupted");
    expect(e.message).toMatch(/retry/i);
    expectNothingInstalled();
  });

  it("a download longer than the pinned size is refused before it is hashed to completion", async () => {
    const e = await expectInstallError(installPinned({ appDataDir, manifest: manifest({ sizeBytes: tarball.length - 10 }) }), "hash-mismatch");
    expect(e.message).toContain("larger than the pinned");
    expectNothingInstalled();
  });

  it("an HTTP error is a download failure, nothing installed", async () => {
    server.mode = "404";
    const e = await expectInstallError(installPinned({ appDataDir, manifest: manifest() }), "download-failed");
    expect(e.message).toContain("HTTP 404");
    expectNothingInstalled();
  });

  it("a hash-correct archive that does not unpack leaves nothing installed", async () => {
    await server.close();
    const junk = Buffer.from("this is not a zstd tarball");
    server = await startReleaseServer(junk);
    const e = await expectInstallError(
      installPinned({ appDataDir, manifest: manifest({ sha256: sha256(junk), sizeBytes: junk.length }) }),
      "extract-failed",
    );
    expect(e.message).toContain("Nothing was installed");
    expectNothingInstalled();
  });

  it("refuses an unverified manifest without downloading", async () => {
    await expectInstallError(installPinned({ appDataDir, manifest: manifest({ verified: false }) }), "unverified-manifest");
    expect(server.hits).toBe(0);
    expectNothingInstalled();
  });

  it("clears staging left by an earlier crashed install", async () => {
    const stale = path.join(runtimeDir(appDataDir), ".staging-crashed");
    mkdirSync(stale, { recursive: true });
    writeFileSync(path.join(stale, "asset"), "partial");
    await installPinned({ appDataDir, manifest: manifest() });
    expect(existsSync(stale)).toBe(false);
  });
});
