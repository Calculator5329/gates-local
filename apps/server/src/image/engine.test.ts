// The app's own ComfyUI: installed into runtime/comfyui/<version>/ through the
// same pinned installer as Ollama. fixtures/fake-portable.7z has the Windows
// portable's layout (python_embeded/, ComfyUI/main.py) and the release's own
// 7z options (LZMA2 with the BCJ2 filter), a few files and no real program.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InstallError } from "../runtime/install.ts";
import type { InstallManifest } from "../runtime/schemas.ts";
import { removeDir, startReleaseServer, tmpDir, type ReleaseServer } from "../runtime/test-fakes.ts";
import type { InstallProgress } from "../runtime/types.ts";
import { ENGINE_OFFERED, engineDir, engineOffered, engineRoot, installEngine } from "./engine.ts";

describe("engineOffered, the release switch and the owner's try-it switch", () => {
  it("follows ENGINE_OFFERED unless GATES_LOCAL_OFFER_ENGINE is 1, and refuses any other value", () => {
    expect(engineOffered(undefined)).toBe(ENGINE_OFFERED);
    expect(engineOffered("")).toBe(ENGINE_OFFERED);
    expect(engineOffered("1")).toBe(true);
    // a typo is an error at startup, never a silent "off" the owner then reads as a broken button
    for (const bad of ["true", "yes", "0", " 1"]) expect(() => engineOffered(bad), bad).toThrow(/GATES_LOCAL_OFFER_ENGINE/);
  });
});

const FIXTURE = path.join(import.meta.dirname, "fixtures", "fake-portable.7z");
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
// The 7z goes through libarchive: Windows has its own reader, anywhere else it
// is bsdtar, which a plain Linux install may not have. Without it the two
// cases that unpack are skipped and counted as skipped; the second of them
// would otherwise pass on "no bsdtar" where it means "wrong tree".
const CAN_UNPACK = process.platform === "win32" || spawnSync("bsdtar", ["--version"]).status === 0;

let work: string;
let appDataDir: string;
let archive: Buffer;
let server: ReleaseServer;

function manifest(over: Partial<InstallManifest> = {}): InstallManifest {
  return { version: "0.0.1-test", url: server.url, sha256: sha256(archive), sizeBytes: archive.length, format: "7z", verified: true, source: "test", ...over };
}

beforeEach(async () => {
  work = tmpDir("engine");
  appDataDir = path.join(work, "data", "gates-local");
  archive = readFileSync(FIXTURE);
  server = await startReleaseServer(archive);
});

afterEach(async () => {
  await server.close();
  removeDir(work);
});

describe("installEngine", () => {
  it.skipIf(!CAN_UNPACK)("unpacks the portable 7z into runtime/comfyui/<version>, with nothing left in staging", async () => {
    const events: InstallProgress[] = [];
    const r = await installEngine({ appDataDir, manifest: manifest(), layout: "windows-portable", onProgress: (p) => events.push(p), progressIntervalMs: 0 });
    expect(r.dir).toBe(engineDir(appDataDir, "0.0.1-test"));
    expect(existsSync(path.join(r.dir, "ComfyUI_windows_portable", "python_embeded", "python.exe"))).toBe(true);
    expect(existsSync(path.join(r.dir, "ComfyUI_windows_portable", "ComfyUI", "main.py"))).toBe(true);
    expect(existsSync(path.join(r.dir, "ComfyUI_windows_portable", "ComfyUI", "comfy", "model_management.py"))).toBe(true);
    expect([...new Set(events.map((e) => e.phase))]).toEqual(["download", "verify", "extract", "done"]);
    expect(readdirSync(engineRoot(appDataDir)).filter((e) => e.startsWith(".staging-"))).toEqual([]);
  });

  it("names the image engine, not Ollama, when the checksum is wrong, and installs nothing", async () => {
    const e = await installEngine({ appDataDir, manifest: manifest({ sha256: "0".repeat(64) }), layout: "windows-portable" }).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(InstallError);
    expect((e as InstallError).code).toBe("hash-mismatch");
    expect((e as InstallError).message).toContain("The image engine download did not match its pinned checksum");
    expect((e as InstallError).message).not.toContain("Ollama");
    expect(existsSync(engineDir(appDataDir, "0.0.1-test"))).toBe(false);
  });

  it.skipIf(!CAN_UNPACK)("a tree without the layout's entry files is not installed", async () => {
    const e = await installEngine({ appDataDir, manifest: manifest(), layout: "uv-venv" }).catch((err: unknown) => err);
    expect((e as InstallError).code).toBe("extract-failed");
    expect((e as InstallError).message).toContain("Unpacking the image engine failed");
    expect(existsSync(engineDir(appDataDir, "0.0.1-test"))).toBe(false);
  });
});
