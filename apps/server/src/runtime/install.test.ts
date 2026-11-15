import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstallError, installNeed, installPinned, shortDisk } from "./install.ts";
import { installDir, installedBinary, runtimeDir } from "./paths.ts";
import type { InstallManifest } from "./schemas.ts";
import { FAKE_RELEASE_FORMAT, FAKE_RELEASE_LIB, type ReleaseServer, buildFakeRelease, removeDir, startReleaseServer, tmpDir } from "./test-fakes.ts";
import type { InstallProgress } from "./types.ts";

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// The disk and the folder moves, as a full disk or a virus scanner on Windows would answer them.
const fsFaults = vi.hoisted(() => ({ write: undefined as Error | undefined, moveRefusals: 0, moves: 0 }));
vi.mock("node:fs/promises", async (real) => {
  const fs = await real<typeof import("node:fs/promises")>();
  // the unpacked tree's move into place: refused while refusals are left, as a scanner holding a file refuses it
  const rename: typeof fs.rename = async (from, to) => {
    if (path.basename(String(from)) !== "tree") return fs.rename(from, to);
    fsFaults.moves += 1;
    if (fsFaults.moveRefusals > 0) {
      fsFaults.moveRefusals -= 1;
      throw Object.assign(new Error(`EPERM: operation not permitted, rename '${String(from)}'`), { code: "EPERM" });
    }
    return fs.rename(from, to);
  };
  const open: typeof fs.open = async (...args) => {
    const handle = await fs.open(...args);
    const fault = fsFaults.write;
    if (fault === undefined) return handle;
    return new Proxy(handle, {
      get(t, key) {
        if (key === "write") return () => Promise.reject(fault);
        const v: unknown = Reflect.get(t, key, t);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
  };
  return { ...fs, default: { ...fs, open, rename }, open, rename };
});
const errno = (code: string, message: string) => Object.assign(new Error(`${code}: ${message}`), { code });

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

/** No staging dirs left. */
function noStaging() {
  const left = existsSync(runtimeDir(appDataDir)) ? readdirSync(runtimeDir(appDataDir)).filter((e) => e.startsWith(".staging-")) : [];
  expect(left).toEqual([]);
}

/** Nothing half-installed: no version dir, no staging dirs. */
function expectNothingInstalled(version = "9.9.9-test") {
  expect(existsSync(installDir(appDataDir, version))).toBe(false);
  noStaging();
}
expectNothingInstalled.staging = noStaging;

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
  fsFaults.write = undefined;
  fsFaults.moveRefusals = 0;
  fsFaults.moves = 0;
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

  // Node's fetch waits 300 s (undici's bodyTimeout) for a body that stops sending; the download ends itself sooner.
  it("a download that stops sending ends after the idle bound, as an interrupted download that says to retry", async () => {
    server.mode = "hang";
    const t0 = Date.now();
    const e = await expectInstallError(installPinned({ appDataDir, manifest: manifest(), idleMs: 300 }), "interrupted");
    expect(Date.now() - t0).toBeLessThan(3000);
    // the figures the running download counted in ("0.6 of 1.5 GB"), never MiB; a figure keeps its unit on its line
    expect(e.message).toMatch(/^The Ollama download stopped at \d+\.\d of \d+\.\d GB \(no data for 0\.3 s\)\. Check the network and retry/);
    expectNothingInstalled();
  }, 10_000);

  // Guards a bug seen on a fresh install: a full disk read as a network problem, and Retry repeated it.
  it("a disk short of the archive and its unpacked copy refuses before a byte downloads, in the picture setup's words", async () => {
    const m = manifest({ unpackedBytes: 3 * tarball.length });
    const e = await expectInstallError(installPinned({ appDataDir, manifest: m, freeBytes: () => Promise.resolve(tarball.length) }), "disk-full");
    expect(installNeed(m)).toBe(4 * tarball.length);
    expect(e.message).toBe(shortDisk(4 * tarball.length, tarball.length));
    expect(server.hits).toBe(0);
    expectNothingInstalled();
  });

  it("a write refused for a full disk says the disk is full and what is needed, not the network", async () => {
    fsFaults.write = errno("ENOSPC", "no space left on device, write");
    const e = await expectInstallError(installPinned({ appDataDir, manifest: manifest() }), "disk-full");
    expect(e.message).toMatch(/^The disk is full\. Needs \S+ GB free; \S+ GB is free on this drive\.$/);
    expect(e.message).not.toMatch(/network/i);
    expectNothingInstalled();
  });

  // Guards the Windows case the update download already handles: a scanner holds a fresh file for a moment.
  it("on Windows a move into place refused twice is tried again and the install lands", async () => {
    fsFaults.moveRefusals = 2;
    const r = await installPinned({ appDataDir, manifest: manifest(), windows: true });
    expect(fsFaults.moves).toBe(3);
    accessSync(r.binary, constants.X_OK);
    expectNothingInstalled.staging();
  });

  it("a Retry after a refused move moves the checked tree it kept, with no second download", async () => {
    fsFaults.moveRefusals = Number.POSITIVE_INFINITY;
    const e = await expectInstallError(installPinned({ appDataDir, manifest: manifest(), windows: true, moveRetryMs: 300 }), "move-failed");
    expect(e.message).not.toMatch(/network/i);
    expect(existsSync(installDir(appDataDir, "9.9.9-test"))).toBe(false);
    expect(server.hits).toBe(1);
    fsFaults.moveRefusals = 0;
    const r = await installPinned({ appDataDir, manifest: manifest(), windows: true });
    expect(server.hits).toBe(1);
    accessSync(r.binary, constants.X_OK);
    expectNothingInstalled.staging();
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
