// The Linux engine build against a fake uv and fake release servers: it stores a whole engine
// tree or none. Nothing here reaches the network; the uv is a shell script that logs its arguments.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeDir } from "@gates-local/runtime-files/paths";
import { InstallError } from "../runtime/install.ts";
import { type ReleaseServer, removeDir, startReleaseServer, tmpDir } from "../runtime/test-fakes.ts";
import type { InstallProgress } from "../runtime/types.ts";
import { engineDir, engineFiles, engineRoot } from "./engine.ts";
import { LINUX_ENGINE, linuxBuild, linuxPinned, type LinuxPins, netReceived, uvDownloads } from "./linux-build.ts";
import { CUDA_ONLY, cpuLock, LINUX_LOCK_CPU } from "./linux-lock-cpu.ts";
import { createOwnComfy } from "./own.ts";
import { createImageSetup, type EnginePlan, type ImageSetupDeps } from "./setup.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const FAKE_UV = `#!/bin/sh
echo "$*" >> "$FAKE_UV_LOG"
echo "$UV_PYTHON_INSTALL_DIR|$UV_PYTHON_PREFERENCE" >> "$FAKE_UV_LOG.python"
# as uv does: what it fetched stays in its cache
mkdir -p "$UV_CACHE_DIR" && echo wheel > "$UV_CACHE_DIR/$1.whl" && echo "$UV_CACHE_DIR" >> "$FAKE_UV_LOG.cache"
# as uv does: it locks its credentials file before it fetches, in this folder or the person's home
echo "\${UV_CREDENTIALS_DIR:-unset}" >> "$FAKE_UV_LOG.credentials"
if [ -n "$UV_CREDENTIALS_DIR" ]; then mkdir -p "$UV_CREDENTIALS_DIR" && : > "$UV_CREDENTIALS_DIR/credentials.toml.lock"; fi
case "$1" in
  venv) for a; do last=$a; done; mkdir -p "$last/bin"; printf '#!/bin/sh\\n' > "$last/bin/python"; chmod +x "$last/bin/python" ;;
  pip) if [ -n "$FAKE_UV_FAIL" ]; then echo "error: no matching hash for torch" >&2; exit 1; fi
    printf 'Resolved 2 packages in 1ms\\nDownloading torch (0.5KiB)\\n' >&2
    if [ -n "$FAKE_UV_SLOW" ]; then sleep 1.2; fi
    printf ' Downloaded torch\\nPrepared 2 packages in 1ms\\n' >&2 ;;
esac
`;

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
/** A lock's entries by package name. */
const lockEntries = (lock: string) => new Map(lock.split(/\n(?=\S)/).filter((e) => /^[A-Za-z0-9_.-]+==/.test(e)).map((e) => [e.split("==")[0]!, e.trimEnd()]));

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
    cpu: { lock: "torch==9.9.9+cpu --hash=sha256:01\n", wheelBytes: 100 },
  };
});

afterEach(async () => {
  await uvServer.close();
  await sourceServer.close();
  delete process.env["FAKE_UV_LOG"];
  delete process.env["FAKE_UV_FAIL"];
  delete process.env["FAKE_UV_SLOW"];
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
    // progress counts every part of the one download, up to its whole size; a wheel uv says it
    // finished counts while the sync still runs (the counter sat at 0.0 GB for the whole engine)
    const archives = pins.uv.sizeBytes + pins.source.sizeBytes;
    expect(events.some((e) => e.phase !== "done" && e.receivedBytes === archives + 512)).toBe(true);
    expect(events.at(-1)?.receivedBytes).toBe(plan.bytes);
    expect(events.every((e) => e.totalBytes === plan.bytes)).toBe(true);
  });

  it("keeps no copy of the download: uv's cache is the build's own folder, gone once the engine is in place", async () => {
    await linuxBuild({ appDataDir, pins }).run(() => {}, new AbortController().signal);
    const caches = [...new Set(readFileSync(`${uvLog}.cache`, "utf8").trim().split("\n"))];
    expect(caches).toHaveLength(1);
    expect(caches[0]!.startsWith(engineRoot(appDataDir) + path.sep)).toBe(true);
    expect(existsSync(caches[0]!)).toBe(false);
    expect(existsSync(path.join(appDataDir, "runtime", "uv-cache"))).toBe(false);
    expect(readdirSync(engineDir(appDataDir, "0.0.0"))).not.toContain("uv-cache");
    expect(leftovers()).toEqual([]);
  });

  it("uv's credentials lock goes in the build's own folder, never the person's home, and is gone with it", async () => {
    await linuxBuild({ appDataDir, pins }).run(() => {}, new AbortController().signal);
    const dirs = [...new Set(readFileSync(`${uvLog}.credentials`, "utf8").trim().split("\n"))];
    expect(dirs).toHaveLength(1);
    expect(dirs[0]!.startsWith(engineRoot(appDataDir) + path.sep)).toBe(true);
    expect(existsSync(dirs[0]!)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("the processor build syncs the CPU lock into its own folder and counts its own download; the card build is untouched", async () => {
    const plan = linuxBuild({ appDataDir, pins });
    expect(plan.version).toBe("0.0.0");
    expect(plan.bytes).toBe(pins.uv.sizeBytes + pins.source.sizeBytes + 1000);
    const cpu = plan.cpu!;
    expect(cpu.version).toBe("0.0.0-cpu");
    expect(cpu.bytes).toBe(pins.uv.sizeBytes + pins.source.sizeBytes + 100);
    const events: InstallProgress[] = [];
    await cpu.run((p) => events.push(p), new AbortController().signal);
    expect(readFileSync(path.join(engineDir(appDataDir, "0.0.0-cpu"), "requirements.lock"), "utf8")).toBe(pins.cpu!.lock);
    expect(existsSync(engineDir(appDataDir, "0.0.0"))).toBe(false);
    expect(own().installed()).toBe(true);
    expect(events.at(-1)).toMatchObject({ phase: "done", version: "0.0.0-cpu", receivedBytes: cpu.bytes, totalBytes: cpu.bytes });
  });

  it("while a wheel downloads, the count follows the bytes this computer receives, never past the wheels uv has started", async () => {
    process.env["FAKE_UV_SLOW"] = "1";
    // the network counter moves 100 bytes a reading; torch (512 bytes) is in flight for 1.2 s
    let readings = 0;
    const events: InstallProgress[] = [];
    const plan = linuxBuild({ appDataDir, pins, received: () => 100 * readings++ });
    await plan.run((p) => events.push(p), new AbortController().signal);
    const archives = pins.uv.sizeBytes + pins.source.sizeBytes;
    const during = events.filter((e) => e.phase !== "done" && e.receivedBytes > archives && e.receivedBytes < archives + 512);
    expect(during.length).toBeGreaterThan(0);
    const counts = events.map((e) => e.receivedBytes);
    expect(counts).toEqual(counts.toSorted((a, b) => a - b));
    expect(Math.max(...counts)).toBe(plan.bytes);
    // another download on the computer (a megabyte a reading) runs it no further than torch's 512
    const busy: InstallProgress[] = [];
    let busyReadings = 0;
    await linuxBuild({ appDataDir: path.join(work, "busy"), pins, received: () => 1e6 * busyReadings++ }).run((p) => busy.push(p), new AbortController().signal);
    expect(Math.max(...busy.filter((e) => e.phase !== "done").map((e) => e.receivedBytes))).toBe(archives + 512);
    // no network reading (no /proc/net/dev): the count moves when a wheel ends, as before
    const quiet: InstallProgress[] = [];
    await linuxBuild({ appDataDir: path.join(work, "quiet"), pins, received: () => undefined }).run((p) => quiet.push(p), new AbortController().signal);
    expect(quiet.some((e) => e.receivedBytes > archives && e.receivedBytes < archives + 512)).toBe(false);
  });

  it("a sync that fails leaves no engine and no half-built tree, and says why", async () => {
    process.env["FAKE_UV_FAIL"] = "1";
    await expect(linuxBuild({ appDataDir, pins }).run(() => {}, new AbortController().signal)).rejects.toThrow(/no matching hash for torch/);
    expect(existsSync(engineDir(appDataDir, "0.0.0"))).toBe(false);
    for (const cache of readFileSync(`${uvLog}.cache`, "utf8").trim().split("\n")) expect(existsSync(cache)).toBe(false);
    expect(own().installed()).toBe(false);
    expect(leftovers()).toEqual([]);
  });
});

describe("uvDownloads, the sync's own lines", () => {
  it("counts a wheel once uv says it finished, at the size uv gave it, and never past the whole", () => {
    const counter = uvDownloads(3 * 1024 ** 3);
    const read = counter.line;
    expect(read("Resolved 103 packages in 2.10s")).toBe(0);
    expect(read("Downloading torch (846.4MiB)")).toBe(0);
    expect(read("Downloading nvidia-cudnn-cu13 (1.1GiB)")).toBe(0);
    // started and not ended: what they will add
    expect(counter.inFlight()).toBe(Math.round(846.4 * 1024 ** 2) + Math.round(1.1 * 1024 ** 3));
    // uv indents the end line; a colour code (FORCE_COLOR) is not part of the name
    expect(read(" \u001b[1m\u001b[36mDownloaded\u001b[39m\u001b[0m torch")).toBe(Math.round(846.4 * 1024 ** 2));
    // a download whose size uv did not know adds nothing
    expect(read("Downloading sympy")).toBe(Math.round(846.4 * 1024 ** 2));
    expect(read(" Downloaded sympy")).toBe(Math.round(846.4 * 1024 ** 2));
    expect(read(" Downloaded nvidia-cudnn-cu13")).toBe(Math.round(846.4 * 1024 ** 2) + Math.round(1.1 * 1024 ** 3));
    expect(read("Downloading triton (2.0GiB)")).toBe(Math.round(846.4 * 1024 ** 2) + Math.round(1.1 * 1024 ** 3));
    expect(read(" Downloaded triton")).toBe(3 * 1024 ** 3);
    expect(counter.inFlight()).toBe(0);
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

  it("the processor lock is the cu130 one with torch's CPU build and no CUDA library, every other pin and hash the same", () => {
    const card = lockEntries(LINUX_ENGINE.lock), cpu = lockEntries(LINUX_ENGINE.cpu!.lock);
    expect(LINUX_ENGINE.cpu!.lock).toBe(LINUX_LOCK_CPU);
    expect(LINUX_ENGINE.cpu!.lock).toContain("--extra-index-url https://download.pytorch.org/whl/cpu\n");
    expect(LINUX_ENGINE.cpu!.lock).not.toMatch(/cu130|nvidia|triton|cuda/);
    expect(cpu.get("torch")).toMatch(/^torch==2\.14\.1\+cpu \\\n/);
    expect(cpu.get("torchvision")).toMatch(/^torchvision==0\.29\.1\+cpu \\\n/);
    for (const name of CUDA_ONLY) expect(card.has(name), name).toBe(true);
    expect(cpu.size).toBe(card.size - CUDA_ONLY.length);
    for (const [name, entry] of cpu) if (name !== "torch" && name !== "torchvision") expect(entry, name).toBe(card.get(name));
    for (const entry of cpu.values()) expect(entry.split("\n")[0]).toMatch(/ \\$/);
    expect(LINUX_ENGINE.cpu!.wheelBytes).toBeGreaterThan(5e8);
    expect(LINUX_ENGINE.cpu!.wheelBytes).toBeLessThan(LINUX_ENGINE.wheelBytes / 3);
    // a torch bump in the cu130 lock must not ship with the old CPU torch beside it
    expect(() => cpuLock(LINUX_ENGINE.lock.replace("torch==2.14.1+cu130", "torch==2.15.0+cu130"))).toThrow(/compile the CPU lock again/);
  });
});

function writeTree(dir: string) {
  const files = engineFiles(dir, "uv-venv");
  for (const file of [files.python, files.main]) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, "", { mode: 0o755 }); }
}

describe.skipIf(process.platform === "win32")("linuxBuild, what it leaves where", () => {
  it("uv builds the venv with its own standalone Python in runtime/uv-python, never a Python on the system", async () => {
    await linuxBuild({ appDataDir, pins }).run(() => {}, new AbortController().signal);
    const runs = readFileSync(`${uvLog}.python`, "utf8").trim().split("\n");
    expect(runs).toHaveLength(2);
    for (const run of runs) expect(run).toBe(`${path.join(runtimeDir(appDataDir), "uv-python")}|only-managed`);
  });

  it("uv and ComfyUI's source each stay in their own pinned folder: runtime/uv/<uv version> and runtime/comfyui-src/<version>", async () => {
    await linuxBuild({ appDataDir, pins }).run(() => {}, new AbortController().signal);
    expect(existsSync(path.join(runtimeDir(appDataDir), "uv", "0.0.1", "uv-x86_64-unknown-linux-gnu", "uv"))).toBe(true);
    expect(existsSync(path.join(runtimeDir(appDataDir), "comfyui-src", "0.0.0", "ComfyUI-0.0.0", "main.py"))).toBe(true);
    expect(readdirSync(runtimeDir(appDataDir)).toSorted()).toEqual(["comfyui", "comfyui-src", "uv"]);
  });

  it("a uv or source archive whose checksum is wrong builds nothing and runs no uv", async () => {
    for (const part of ["uv", "source"] as const) {
      const data = path.join(work, `bad-${part}`);
      const bad = { ...pins, [part]: { ...pins[part], sha256: "0".repeat(64) } };
      const error = await linuxBuild({ appDataDir: data, pins: bad }).run(() => {}, new AbortController().signal).catch((e: unknown) => e);
      expect(error, part).toBeInstanceOf(InstallError);
      expect((error as InstallError).code, part).toBe("hash-mismatch");
      expect(existsSync(engineDir(data, "0.0.0")), part).toBe(false);
    }
    expect(existsSync(uvLog)).toBe(false);
    expect(existsSync(path.join(runtimeDir(path.join(work, "bad-uv")), "comfyui-src"))).toBe(false);
  });

  it("a whole tree in a dot folder (a build a killed app left half done) is never taken for the engine", () => {
    writeTree(path.join(engineRoot(appDataDir), ".build-killed"));
    expect(own().installed()).toBe(false);
  });

  it("the next build sweeps away the staging folder a killed build left behind", async () => {
    const left = path.join(engineRoot(appDataDir), ".build-killed");
    writeTree(left);
    await linuxBuild({ appDataDir, pins }).run(() => {}, new AbortController().signal);
    expect(existsSync(left)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("uv's cache a killed build left behind is swept by the next build, as its staging folder is", async () => {
    const plan = linuxBuild({ appDataDir, pins });
    await plan.run(() => {}, new AbortController().signal);
    const cache = readFileSync(`${uvLog}.cache`, "utf8").trim().split("\n")[0]!;
    mkdirSync(cache, { recursive: true });
    writeFileSync(path.join(cache, "torch.whl"), "wheel");
    await plan.cpu!.run(() => {}, new AbortController().signal);
    expect(existsSync(cache)).toBe(false);
  });
});

const GIB = 1024 ** 3;

function setupDeps(plan: EnginePlan): ImageSetupDeps {
  return {
    appDataDir: "/nowhere",
    own: { installed: () => false },
    image: {
      status: async () => ({ state: "stopped", owner: "none" }) as never,
      engine: () => ({ owner: "none", state: "stopped", room: 16 * GIB }) as never,
      start: async () => ({}) as never,
      download: async () => ({ files: [] }),
    },
    setDevice: () => {},
    engine: () => plan,
    gpuStatus: async () => ({}) as never,
    settingsAddress: () => undefined,
    push: () => {},
    freeBytes: async () => 500 * GIB,
  };
}

describe("LINUX_ENGINE's sizes, as the setup reads them", () => {
  it("with no measured disk use, the free space it asks for is four times the download (uv, the source and the wheels) and the model", async () => {
    const { version, python, uv, uvDir, source, sourceDir, lock, wheelBytes } = LINUX_ENGINE;
    const plan = linuxBuild({ appDataDir: "/nowhere", pins: { version, python, uv, uvDir, source, sourceDir, lock, wheelBytes } });
    expect(plan.diskBytes).toBeUndefined();
    const info = await createImageSetup(setupDeps(plan)).info();
    expect(info.engine?.bytes).toBe(uv.sizeBytes + source.sizeBytes + wheelBytes);
    expect(info.needBytes).toBe((uv.sizeBytes + source.sizeBytes + wheelBytes) * 4 + info.model!.bytes);
  });
});

describe("linuxPinned, whether the build may be offered", () => {
  it("is not, while either archive has no confirmed digest or the lock is empty", () => {
    expect(linuxPinned({ ...LINUX_ENGINE, uv: { ...LINUX_ENGINE.uv, verified: false } })).toBe(false);
    expect(linuxPinned({ ...LINUX_ENGINE, source: { ...LINUX_ENGINE.source, verified: false } })).toBe(false);
    expect(linuxPinned({ ...LINUX_ENGINE, lock: "" })).toBe(false);
  });
});

const NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 5000      10    0    0    0     0          0         0     5000      10    0    0    0     0       0          0
  eth0: 1200       9    0    0    0     0          0         0      800       7    0    0    0     0       0          0
 wlan0:  300       2    0    0    0     0          0         0      100       1    0    0    0     0       0          0
`;

describe("netReceived, this computer's network counter", () => {
  it("adds up what every interface but loopback has received, and gives nothing where that cannot be read", () => {
    vi.mocked(readFileSync).mockImplementationOnce(() => NET_DEV);
    expect(netReceived()).toBe(1500);
    expect(vi.mocked(readFileSync)).toHaveBeenLastCalledWith("/proc/net/dev", "utf8");
    vi.mocked(readFileSync).mockImplementationOnce(() => { throw new Error("ENOENT: no such file or directory, open '/proc/net/dev'"); });
    expect(netReceived()).toBeUndefined();
  });
});
