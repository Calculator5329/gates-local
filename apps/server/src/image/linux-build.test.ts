// The Linux engine build against a fake uv and fake release servers: it stores a whole engine
// tree or none. Nothing here reaches the network; the uv is a shell script that logs its arguments.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ReleaseServer, removeDir, startReleaseServer, tmpDir } from "../runtime/test-fakes.ts";
import type { InstallProgress } from "../runtime/types.ts";
import { engineDir, engineRoot } from "./engine.ts";
import { LINUX_ENGINE, linuxBuild, linuxPinned, type LinuxPins } from "./linux-build.ts";
import { createOwnComfy } from "./own.ts";

const FAKE_UV = `#!/bin/sh
echo "$*" >> "$FAKE_UV_LOG"
case "$1" in
  venv) for a; do last=$a; done; mkdir -p "$last/bin"; printf '#!/bin/sh\\n' > "$last/bin/python"; chmod +x "$last/bin/python" ;;
  pip) if [ -n "$FAKE_UV_FAIL" ]; then echo "error: no matching hash for torch" >&2; exit 1; fi ;;
esac
`;

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function tarGz(work: string, name: string, files: Record<string, { text: string; mode?: number }>): Buffer {
  const src = path.join(work, `${name}-src`);
  for (const [file, { text, mode }] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(src, file)), { recursive: true });
    writeFileSync(path.join(src, file), text, mode === undefined ? {} : { mode });
  }
  const out = path.join(work, `${name}.tar.gz`);
  execFileSync("tar", ["-czf", out, "-C", src, "."]);
  return readFileSync(out);
}

let work: string, appDataDir: string, uvLog: string;
let uvServer: ReleaseServer, sourceServer: ReleaseServer, pins: LinuxPins;

beforeEach(async () => {
  work = tmpDir("linux-build");
  appDataDir = path.join(work, "data", "gates-local");
  uvLog = path.join(work, "uv.log");
  process.env["FAKE_UV_LOG"] = uvLog;
  delete process.env["FAKE_UV_FAIL"];
  const uv = tarGz(work, "uv", { "uv-x86_64-unknown-linux-gnu/uv": { text: FAKE_UV, mode: 0o755 } });
  const source = tarGz(work, "source", { "ComfyUI-0.0.0/main.py": { text: "# ComfyUI\n" }, "ComfyUI-0.0.0/requirements.txt": { text: "torch\n" } });
  uvServer = await startReleaseServer(uv);
  sourceServer = await startReleaseServer(source);
  pins = {
    version: "0.0.0",
    python: "3.13",
    uv: { version: "0.0.1", url: uvServer.url, sha256: sha256(uv), sizeBytes: uv.length, format: "tar.gz", verified: true, source: "test" },
    uvDir: "uv-x86_64-unknown-linux-gnu",
    source: { version: "0.0.0", url: sourceServer.url, sha256: sha256(source), sizeBytes: source.length, format: "tar.gz", verified: true, source: "test" },
    sourceDir: "ComfyUI-0.0.0",
    lock: "torch==9.9.9 --hash=sha256:00\n",
    wheelBytes: 1000,
  };
});

afterEach(async () => {
  await uvServer.close();
  await sourceServer.close();
  delete process.env["FAKE_UV_LOG"];
  delete process.env["FAKE_UV_FAIL"];
  removeDir(work);
});

const own = () => createOwnComfy({ appDataDir, port: 1, platform: "linux" });
const leftovers = () => existsSync(engineRoot(appDataDir)) ? readdirSync(engineRoot(appDataDir)).filter((e) => e.startsWith(".")) : [];

describe.skipIf(process.platform === "win32")("linuxBuild", () => {
  it("fetches uv and the source through the pinned installer, builds the venv from the lock with hashes, and puts the whole tree in place at once", async () => {
    const events: InstallProgress[] = [];
    const plan = linuxBuild({ appDataDir, pins });
    expect(own().installed()).toBe(false);
    await plan.run((p) => events.push(p), new AbortController().signal);

    const tree = engineDir(appDataDir, "0.0.0");
    expect(readFileSync(path.join(tree, "ComfyUI", "main.py"), "utf8")).toBe("# ComfyUI\n");
    expect(existsSync(path.join(tree, "venv", "bin", "python"))).toBe(true);
    expect(own().installed()).toBe(true);
    expect(leftovers()).toEqual([]);
    const calls = readFileSync(uvLog, "utf8").trim().split("\n");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/^venv --relocatable --python 3\.13 \S+\/venv$/);
    // best-match, as the lock was compiled: first-index would take certifi and the like from the
    // torch index, which lacks the pinned versions
    expect(calls[1]).toMatch(/^pip sync --require-hashes --index-strategy unsafe-best-match --python \S+\/venv\/bin\/python \S+\/requirements\.lock$/);
    // the lock it synced is the pinned one
    expect(readFileSync(path.join(tree, "requirements.lock"), "utf8")).toBe(pins.lock);
    // progress counts every part of the one download, up to its whole size
    expect(events.at(-1)?.receivedBytes).toBe(plan.bytes);
    expect(events.every((e) => e.totalBytes === plan.bytes)).toBe(true);
  });

  it("a sync that fails leaves no engine and no half-built tree, and says why", async () => {
    process.env["FAKE_UV_FAIL"] = "1";
    await expect(linuxBuild({ appDataDir, pins }).run(() => {}, new AbortController().signal)).rejects.toThrow(/no matching hash for torch/);
    expect(existsSync(engineDir(appDataDir, "0.0.0"))).toBe(false);
    expect(own().installed()).toBe(false);
    expect(leftovers()).toEqual([]);
  });
});

describe("LINUX_ENGINE, the shipped pins", () => {
  it("is pinned: uv and the source have their digests, and every package in the lock carries one", () => {
    expect(linuxPinned(LINUX_ENGINE)).toBe(true);
    expect(LINUX_ENGINE.uv.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(LINUX_ENGINE.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(LINUX_ENGINE.uv.url).toContain(`/${LINUX_ENGINE.uv.version}/${LINUX_ENGINE.uvDir}.tar.gz`);
    expect(LINUX_ENGINE.wheelBytes).toBeGreaterThan(1e9);
    // one entry per package: its pin, then its hashes, each line continued with a backslash
    const entries = LINUX_ENGINE.lock.split(/\n(?=\S)/).filter((e) => /^[A-Za-z0-9_.-]+==/.test(e));
    expect(entries.length).toBeGreaterThan(50);
    for (const entry of entries) expect(entry, entry.split("\n")[0]).toMatch(/--hash=sha256:[0-9a-f]{64}/);
    expect(entries.some((e) => e.startsWith("torch==2.14.1+cu130 "))).toBe(true);
    // uv's annotations name the folder the lock was compiled in; none ship
    expect(LINUX_ENGINE.lock).not.toMatch(/^\s*#/m);
  });
});
