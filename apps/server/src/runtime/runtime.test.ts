import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { httpGet } from "./http.ts";
import { probe } from "./probe.ts";
import { readProc, readRecord } from "@gates-local/runtime-files/ownership";
import { installedBinary, ownedStateFile } from "@gates-local/runtime-files/paths";
import { InstallError } from "./install.ts";
import { type OllamaRuntime, type RuntimeOptions, childHome, createOllamaRuntime, failureOf, ownedChildEnv } from "./runtime.ts";
import type { InstallManifest } from "./schemas.ts";
import {
  FAKE_RELEASE_FORMAT,
  buildFakeRelease,
  fakeOllamaScript,
  freePort,
  removeDir,
  startFakeOllama,
  startReleaseServer,
  startWrongService,
  tmpDir,
  writeFakeBinary,
} from "./test-fakes.ts";
import type { InstallProgress, RuntimeStatus } from "./types.ts";

const VERSION = "9.9.9-test";

let work: string;
let appDataDir: string;
let home: string;
let emptyPathDir: string;
const cleanups: (() => Promise<unknown> | unknown)[] = [];
const runtimes: OllamaRuntime[] = [];

beforeEach(() => {
  work = tmpDir("rt");
  appDataDir = path.join(work, "data", "gates-local");
  home = path.join(work, "home");
  emptyPathDir = path.join(work, "empty-path");
  mkdirSync(emptyPathDir, { recursive: true });
});

afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.stop();
  for (const c of cleanups.splice(0).toReversed()) await c();
  removeDir(work);
});

const manifest = (over: Partial<InstallManifest> = {}): InstallManifest => ({
  version: VERSION,
  url: "http://127.0.0.1:1/never",
  sha256: "0".repeat(64),
  sizeBytes: 1,
  format: FAKE_RELEASE_FORMAT,
  verified: true,
  source: "test",
  ...over,
});

async function makeRuntime(over: Partial<RuntimeOptions> & { externalBaseUrl: string }) {
  const rt = createOllamaRuntime({
    appDataDir,
    home,
    appPort: await freePort(),
    env: { PATH: emptyPathDir, HOME: home },
    systemModelsDirs: [],
    manifest: manifest(),
    allowInstall: false,
    probeTimeoutMs: 500,
    startTimeoutMs: 10_000,
    ...over,
  });
  runtimes.push(rt);
  const seen: RuntimeStatus[] = [];
  rt.onChange((s) => seen.push(s));
  return { rt, seen };
}

async function nothingAt(): Promise<string> {
  return `http://127.0.0.1:${await freePort()}`;
}

const isUp = async (baseUrl: string) => (await httpGet(`${baseUrl}/api/version`, 500)).kind === "response";

describe("existing Ollama", () => {
  it("reuses a healthy Ollama as external and never records or stops it", async () => {
    const fake = await startFakeOllama({ version: "0.40.4" });
    cleanups.push(() => fake.close());
    const { rt } = await makeRuntime({ externalBaseUrl: fake.baseUrl });
    const s = await rt.ensure();
    expect(s).toEqual({ state: "ready", owner: "external", baseUrl: fake.baseUrl, version: "0.40.4" });
    expect(rt.baseUrl()).toBe(fake.baseUrl);
    expect(existsSync(ownedStateFile(appDataDir))).toBe(false);
    expect(await rt.stop()).toEqual({ stopped: false, reason: "no-record" });
    expect(await isUp(fake.baseUrl)).toBe(true);
    expect(fake.requests.every((r) => r.startsWith("GET "))).toBe(true);
  });

  it("an Ollama on the app port that the app did not start is reused as external", async () => {
    const fake = await startFakeOllama();
    cleanups.push(() => fake.close());
    const { rt } = await makeRuntime({ externalBaseUrl: await nothingAt(), appPort: fake.port });
    const s = await rt.ensure();
    expect(s.state).toBe("ready");
    expect(s.owner).toBe("external");
    expect(s.detail).toContain("did not start");
    expect(await rt.stop()).toEqual({ stopped: false, reason: "no-record" });
    expect(await isUp(fake.baseUrl)).toBe(true);
  });
});

describe("stopped (installed, nothing answering)", () => {
  it("starts the app-owned binary on its own port with the existing models dir, records it, and stops it", async () => {
    writeFakeBinary(installedBinary(appDataDir, VERSION));
    const modelsDir = path.join(home, ".ollama", "models");
    mkdirSync(path.join(modelsDir, "manifests"), { recursive: true });
    const { rt, seen } = await makeRuntime({ externalBaseUrl: await nothingAt() });

    const d = await rt.discover();
    expect(d.state).toBe("stopped");
    expect(d.detail).toContain(installedBinary(appDataDir, VERSION));

    const s = await rt.ensure();
    expect(s.state).toBe("ready");
    expect(s.owner).toBe("app");
    expect(s.version).toBe("0.0.2-fake-app");
    expect(seen.map((x) => x.state)).toEqual(["stopped", "starting", "ready"]);

    const env = await httpGet(`${s.baseUrl}/fake/env`, 1000);
    // on the person's store it keeps the person's home, so the key `ollama signin` registered still
    // signs; the CUDA kernels it compiles go in the app's runtime folder; one model is held at a time
    expect(env.kind === "response" && JSON.parse(env.body)).toEqual({
      OLLAMA_MODELS: modelsDir, OLLAMA_HOST: new URL(s.baseUrl).host,
      HOME: home, CUDA_CACHE_PATH: path.join(appDataDir, "runtime", "cuda-cache"), OLLAMA_MAX_LOADED_MODELS: "1",
    });
    expect(existsSync(childHome(appDataDir))).toBe(false);
    // the folder the status reports is the one the Ollama was really given
    expect(s.modelsDir).toBe(modelsDir);
    // started with OLLAMA_MAX_LOADED_MODELS=1, and the status says so
    expect(s.holdsOne).toBe(true);

    const rec = readRecord(ownedStateFile(appDataDir));
    expect(rec?.baseUrl).toBe(s.baseUrl);
    expect(rec?.holdsOne).toBe(true);
    expect(readProc(rec!.pid)?.startTime).toBe(rec!.startTime);

    // A second runtime instance (server restart) recognises it as ours, still holding one model.
    const again = createOllamaRuntime({ appDataDir, home, appPort: Number(new URL(s.baseUrl).port), externalBaseUrl: d.baseUrl.replace(/:\d+$/, ":1"), env: { PATH: emptyPathDir }, allowInstall: false });
    expect(await again.discover()).toMatchObject({ owner: "app", holdsOne: true });

    const stop = await rt.stop();
    expect(stop).toEqual({ stopped: true, pid: rec!.pid });
    expect(readProc(rec!.pid)).toBeUndefined();
    expect(await isUp(s.baseUrl)).toBe(false);
    expect(rt.status().state).toBe("stopped");
  });

  it("falls back to an ollama on PATH and runs it as app-owned", async () => {
    const binDir = path.join(work, "bin");
    writeFakeBinary(path.join(binDir, "ollama"));
    const { rt } = await makeRuntime({ externalBaseUrl: await nothingAt(), env: { PATH: binDir, HOME: home } });
    const s = await rt.ensure();
    expect(s.state).toBe("ready");
    expect(s.owner).toBe("app");
    expect(s.detail).toContain("from PATH");
    // the person's own install keeps the person's home; no models folder yet: told the default store outright
    const env = await httpGet(`${s.baseUrl}/fake/env`, 1000);
    expect(env.kind === "response" && JSON.parse(env.body)).toMatchObject({ OLLAMA_MODELS: path.join(home, ".ollama", "models"), HOME: home });
  });

  it("the person's install keeps a CUDA cache folder the person set", async () => {
    const binDir = path.join(work, "bin");
    writeFakeBinary(path.join(binDir, "ollama"));
    const cache = path.join(work, "my-cuda-cache");
    const { rt } = await makeRuntime({ externalBaseUrl: await nothingAt(), env: { PATH: binDir, HOME: home, CUDA_CACHE_PATH: cache } });
    const s = await rt.ensure();
    const env = await httpGet(`${s.baseUrl}/fake/env`, 1000);
    expect(env.kind === "response" && JSON.parse(env.body)).toMatchObject({ CUDA_CACHE_PATH: cache, OLLAMA_MAX_LOADED_MODELS: "1", HOME: home });
  });

  it("a look while the app's copy is starting waits for that start and answers its result (BD-02)", async () => {
    const binDir = path.join(work, "bin");
    writeFakeBinary(path.join(binDir, "ollama"));
    const { rt, seen } = await makeRuntime({ externalBaseUrl: await nothingAt(), env: { PATH: binDir } });
    const starting = rt.ensure();
    const looked = await rt.discover();
    expect(looked).toMatchObject({ state: "ready", owner: "app" });
    expect(looked).toEqual(await starting);
    expect(seen.map((s) => s.state), "never stopped on the way to ready").not.toContain("stopped");
  });

  it("with starts off (a pinned URL), an ollama on PATH is reported, never run", async () => {
    const binDir = path.join(work, "bin");
    const ran = path.join(work, "ran");
    writeFakeBinary(path.join(binDir, "ollama"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(ran)}, "ran");\n`);
    const { rt } = await makeRuntime({ externalBaseUrl: await nothingAt(), env: { PATH: binDir }, allowStart: false });
    const s = await rt.ensure();
    expect(s.state).toBe("stopped");
    expect(s.owner).toBe("none");
    expect(existsSync(ran)).toBe(false);
    expect(existsSync(ownedStateFile(appDataDir))).toBe(false);
  });

  it("a binary that dies on start is an error with the log tail, no record left", async () => {
    writeFakeBinary(installedBinary(appDataDir, VERSION), `#!${process.execPath}\nconsole.error("boom: cannot bind");\nprocess.exit(3);\n`);
    const { rt } = await makeRuntime({ externalBaseUrl: await nothingAt() });
    const s = await rt.ensure();
    expect(s.state).toBe("error");
    expect(s.detail).toContain("code 3");
    expect(s.detail).toContain("boom: cannot bind");
    expect(s.failure).toBe("start");
    expect(existsSync(ownedStateFile(appDataDir))).toBe(false);
  });

  it("a data folder that cannot be written ends in an error that names it and can be retried, never a start left on screen", async () => {
    const binDir = path.join(work, "bin");
    writeFakeBinary(path.join(binDir, "ollama"));
    // a file where the data folder's parent should be: nothing can be made under it, as in a
    // read-only folder
    const taken = path.join(work, "taken");
    writeFileSync(taken, "");
    const { rt, seen } = await makeRuntime({ appDataDir: path.join(taken, "gates-local"), externalBaseUrl: await nothingAt(), env: { PATH: binDir, HOME: home } });
    const s = await rt.ensure();
    expect(s).toMatchObject({ state: "error", owner: "none", failure: "start" });
    expect(s.detail).toContain(taken);
    expect(rt.status()).toEqual(s);
    expect(seen.at(-1)).toEqual(s);
    // the folder put right, Retry starts it
    renameSync(taken, `${taken}-aside`);
    expect(await rt.ensure()).toMatchObject({ state: "ready", owner: "app" });
  });

  it("a look that stops on an error ends in an error too, and the next look is free to run", async () => {
    let fails = true;
    const { rt } = await makeRuntime({ externalBaseUrl: await nothingAt(), env: { get PATH(): string { if (fails) throw new Error("the look broke"); return emptyPathDir; }, HOME: home } });
    const s = await rt.discover();
    expect(s).toMatchObject({ state: "error", owner: "none" });
    expect(s.detail).toContain("the look broke");
    fails = false;
    expect(await rt.discover()).toMatchObject({ state: "missing" });
  });
});

describe("the environment of an Ollama the app starts", () => {
  const data = path.join("/data", "gates-local");
  it("the app's own fetched copy on its own models folder gets its own home, on Linux and on Windows", () => {
    expect(ownedChildEnv({ HOME: "/home/ada" }, data, 11500, "linux", true)).toMatchObject({ HOME: childHome(data), OLLAMA_MAX_LOADED_MODELS: "1", OLLAMA_HOST: "127.0.0.1:11500" });
    expect(ownedChildEnv({ USERPROFILE: "C:\\Users\\Ada" }, data, 11500, "win32", true)).toMatchObject({ USERPROFILE: childHome(data) });
  });

  it("the person's install, or any copy on the person's store, keeps the person's home and sign-in", () => {
    expect(ownedChildEnv({ HOME: "/home/ada" }, data, 11500, "linux", false)).toMatchObject({ HOME: "/home/ada", OLLAMA_MAX_LOADED_MODELS: "1" });
    expect(ownedChildEnv({ USERPROFILE: "C:\\Users\\Ada" }, data, 11500, "win32", false)).toMatchObject({ USERPROFILE: "C:\\Users\\Ada" });
  });

  it("a CUDA cache folder the person set is kept; one model at a time is forced over the person's setting", () => {
    for (const own of [true, false]) {
      expect(ownedChildEnv({ CUDA_CACHE_PATH: "/mine", OLLAMA_MAX_LOADED_MODELS: "3" }, data, 1, "linux", own)).toMatchObject({ CUDA_CACHE_PATH: "/mine", OLLAMA_MAX_LOADED_MODELS: "1" });
      expect(ownedChildEnv({}, data, 1, "linux", own).CUDA_CACHE_PATH).toBe(path.join(data, "runtime", "cuda-cache"));
    }
  });
});

describe("missing", () => {
  it("reports missing when no install, nothing on PATH and installs are off", async () => {
    const { rt } = await makeRuntime({ externalBaseUrl: await nothingAt() });
    const s = await rt.ensure();
    expect(s.state).toBe("missing");
    expect(s.owner).toBe("none");
  });

  it("with starts off, installs allowed and no Ollama anywhere, nothing is installed and the status never promises an install", async () => {
    const { rt } = await makeRuntime({ externalBaseUrl: await nothingAt(), allowStart: false, allowInstall: true });
    const s = await rt.ensure();
    expect(s.state).toBe("missing");
    expect(s.detail).not.toContain("will install");
    expect(existsSync(installedBinary(appDataDir, manifest().version))).toBe(false);
  });

  it("with Ollama off PATH, first launch installs the pinned version and runs it", async () => {
    const tarball = buildFakeRelease(work);
    const release = await startReleaseServer(tarball);
    cleanups.push(() => release.close());
    const m = manifest({ url: release.url, sha256: createHash("sha256").update(tarball).digest("hex"), sizeBytes: tarball.length });
    const { rt, seen } = await makeRuntime({ externalBaseUrl: await nothingAt(), manifest: m, allowInstall: true });
    const progress: InstallProgress[] = [];
    rt.onInstallProgress((p) => progress.push(p));

    expect((await rt.discover()).state).toBe("missing");
    const s = await rt.ensure();
    expect(s.state).toBe("ready");
    expect(s.owner).toBe("app");
    // installing repeats as its download moves on
    expect(seen.map((x) => x.state).filter((x, i, all) => x !== all[i - 1])).toEqual(["missing", "installing", "starting", "ready"]);
    expect(progress.map((p) => p.phase)).toContain("done");
    // the status carries the download's size from the start and its whole when it is in; it is gone once it runs
    const installing = seen.filter((x) => x.state === "installing");
    expect(installing[0]?.install).toEqual({ receivedBytes: 0, totalBytes: tarball.length });
    expect(installing.at(-1)?.install).toMatchObject({ receivedBytes: tarball.length, totalBytes: tarball.length });
    expect(s.install).toBeUndefined();
    expect(existsSync(installedBinary(appDataDir, VERSION))).toBe(true);
    // Windows' fake release carries Node itself (about 90 MB) as ollama.exe.
  }, 30_000);

  it("a bad hash on first launch is an error with the install message, nothing installed", async () => {
    const tarball = buildFakeRelease(work);
    const release = await startReleaseServer(tarball);
    cleanups.push(() => release.close());
    const m = manifest({ url: release.url, sizeBytes: tarball.length });
    const { rt } = await makeRuntime({ externalBaseUrl: await nothingAt(), manifest: m, allowInstall: true });
    const s = await rt.ensure();
    expect(s.state).toBe("error");
    expect(s.detail).toContain("did not match its pinned checksum");
    // the status says the checksum is what failed, so no screen calls it a start or the network
    expect(s.failure).toBe("checksum");
    expect(existsSync(installedBinary(appDataDir, VERSION))).toBe(false);
  });

  it("Retry while the download has stalled ends that attempt and starts a new one, with no error between", async () => {
    const tarball = buildFakeRelease(work);
    const release = await startReleaseServer(tarball);
    cleanups.push(() => release.close());
    release.mode = "hang";
    const m = manifest({ url: release.url, sha256: createHash("sha256").update(tarball).digest("hex"), sizeBytes: tarball.length });
    const { rt, seen } = await makeRuntime({ externalBaseUrl: await nothingAt(), manifest: m, allowInstall: true, stallMs: 200 });
    const first = rt.ensure();
    // the status that says the download stalled, not the clock: a loaded machine only makes it later
    const stalled = await new Promise<RuntimeStatus>((resolve, reject) => {
      const said = seen.find((x) => x.install?.stalled === true);
      if (said !== undefined) return resolve(said);
      const bound = setTimeout(() => reject(new Error("no status said the download stalled within 20 s")), 20_000);
      const off = rt.onChange((x) => {
        if (x.install?.stalled !== true) return;
        clearTimeout(bound);
        off();
        resolve(x);
      });
    });
    // what has arrived so far is kept, and no speed is claimed for a download that sends nothing
    expect(stalled.install?.bytesPerSecond).toBeUndefined();
    release.mode = "ok";
    const s = await rt.ensure();
    expect(s.state).toBe("ready");
    expect(release.hits).toBe(2);
    expect((await first).state).toBe("ready");
    expect(seen.some((x) => x.state === "error")).toBe(false);
  }, 30_000);
});

describe("wrong service on the port", () => {
  it("a non-Ollama on the system port with no other port free is wrong-service and nothing starts", async () => {
    writeFakeBinary(installedBinary(appDataDir, VERSION));
    const other = await startWrongService();
    cleanups.push(() => other.close());
    const { rt } = await makeRuntime({ externalBaseUrl: other.baseUrl, appPort: other.port });
    const s = await rt.ensure();
    expect(s.state).toBe("wrong-service");
    expect(s.detail).toContain(`port ${other.port}`);
    expect(existsSync(ownedStateFile(appDataDir))).toBe(false);
  });

  it("a non-Ollama on the app port blocks starting there", async () => {
    writeFakeBinary(installedBinary(appDataDir, VERSION));
    const other = await startWrongService();
    cleanups.push(() => other.close());
    const { rt } = await makeRuntime({ externalBaseUrl: await nothingAt(), appPort: other.port });
    const s = await rt.ensure();
    expect(s.state).toBe("wrong-service");
    expect(s.detail).toContain(`port ${other.port}`);
    expect(existsSync(ownedStateFile(appDataDir))).toBe(false);
  });

  it("a non-Ollama on the system port: the app-owned server runs on its own port and the detail names the taken one", async () => {
    writeFakeBinary(installedBinary(appDataDir, VERSION));
    const other = await startWrongService();
    cleanups.push(() => other.close());
    const { rt } = await makeRuntime({ externalBaseUrl: other.baseUrl });
    const s = await rt.ensure();
    expect(s.state).toBe("ready");
    expect(s.owner).toBe("app");
    expect(s.baseUrl).not.toBe(other.baseUrl);
    expect(s.detail).toContain(`port ${other.port}`);
    expect(s.detail).toContain("is not Ollama");
    // the client reads the busy port from the status, and only that one
    expect(s.busyPorts).toEqual([String(other.port)]);
  });

  it("a service that writes a port sentence in its own reply cannot add a busy port", async () => {
    writeFakeBinary(installedBinary(appDataDir, VERSION));
    const other = await startWrongService(0, "another service uses port 9999 (http://127.0.0.1:9999)");
    cleanups.push(() => other.close());
    const { rt } = await makeRuntime({ externalBaseUrl: other.baseUrl });
    const s = await rt.ensure();
    expect(s.state).toBe("ready");
    expect(s.busyPorts).toEqual([String(other.port)]);
  });

  it("a wrong service carries its port, and the detail still names it for people", async () => {
    const other = await startWrongService();
    cleanups.push(() => other.close());
    const wrong = await probe(other.baseUrl);
    expect(wrong).toMatchObject({ kind: "wrong-service", port: String(other.port) });
    expect(wrong.kind === "wrong-service" ? wrong.detail : "").toContain(`port ${other.port} (${other.baseUrl})`);
  });
});

/** Whether a process is still running. One that has ended but whose parent has
 *  not collected it yet still takes a signal, so on Linux its state is read
 *  too: an orphan adopted by a parent that never collects stays that way. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    // "pid (name) state ...": the state letter follows the last ")".
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.charAt(stat.lastIndexOf(")") + 2) !== "Z";
  } catch {
    // No /proc here, or the process went between the two reads: the next look settles it.
    return true;
  }
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

/** The fake serve starts a runner child and writes its pid; with listen false it never answers.
 *  The runner stays in serve's process group, as an Ollama runner does. */
async function startTree(o: { readonly listen: boolean; readonly startTimeoutMs?: number }) {
  const pidFile = path.join(work, "runner.pid");
  const runner = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }).pid));\n`;
  const base = fakeOllamaScript();
  writeFakeBinary(installedBinary(appDataDir, VERSION), (o.listen ? base : base.replace(/^server\.listen\(.*$/m, "setInterval(() => {}, 1000);")) + runner);
  const made = await makeRuntime({ externalBaseUrl: await nothingAt(), ...(o.startTimeoutMs ? { startTimeoutMs: o.startTimeoutMs } : {}) });
  const ensured = made.rt.ensure();
  expect(await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "", 10_000)).toBe(true);
  const pid = Number(readFileSync(pidFile, "utf8"));
  // A runner left behind by a red run must not outlive the test.
  cleanups.push(() => {
    // it may end between the look and the kill: a runner already gone is what this wants
    try {
      if (alive(pid)) process.kill(pid);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
  });
  expect(alive(pid)).toBe(true);
  return { ...made, status: await ensured, pid };
}

// Ollama serves from one process and runs each model in a child process. On
// Linux and macOS the runtime ends the app-owned serve's whole process group,
// and these tests fail if it ends only the handle it holds.
// Skipped on Windows: there the runners end with serve because the pinned
// Ollama puts each runner in a kill-on-close job object of its own, which the
// runtime neither creates nor touches. A fake runner here would only show
// Node's job object (a non-detached child dies with its parent) or, detached,
// a tree no real Ollama makes; neither is the runtime's doing.
describe.skipIf(process.platform === "win32")("process tree: the app-owned Ollama's runners end with it", () => {
  it("stop ends the runner too", async () => {
    const { rt, status, pid } = await startTree({ listen: true });
    expect(status.state).toBe("ready");
    expect((await rt.stop()).stopped).toBe(true);
    expect(await until(() => !alive(pid), 3000)).toBe(true);
  });

  it("killNow (a shutdown out of time) ends the runner too", async () => {
    const { rt, status, pid } = await startTree({ listen: true });
    expect(status.state).toBe("ready");
    rt.killNow();
    expect(await until(() => !alive(pid), 3000)).toBe(true);
  });

  it("a start that never answers ends the runner too", async () => {
    const { status, pid } = await startTree({ listen: false, startTimeoutMs: 3000 });
    expect(status.state).toBe("error");
    expect(await until(() => !alive(pid), 3000)).toBe(true);
  });
});

describe("what an install failure is called", () => {
  it("each install error has its own kind: network, checksum, disk, or the install itself", () => {
    expect(failureOf(new InstallError("download-failed", "x"))).toBe("download");
    expect(failureOf(new InstallError("interrupted", "x"))).toBe("download");
    expect(failureOf(new InstallError("hash-mismatch", "x"))).toBe("checksum");
    expect(failureOf(new InstallError("disk-full", "Needs 2.4 GB free; 0.5 GB is free on this drive."))).toBe("disk");
    expect(failureOf(new InstallError("extract-failed", "x"))).toBe("install");
    expect(failureOf(new InstallError("move-failed", "x"))).toBe("install");
    expect(failureOf(new Error("anything else"))).toBe("install");
  });
});

describe("status listener", () => {
  it("before the first look the status is looking, never a stopped Ollama nobody saw", async () => {
    const { rt } = await makeRuntime({ externalBaseUrl: await nothingAt() });
    expect(rt.status()).toMatchObject({ state: "starting", owner: "none", detail: "Looking for Ollama." });
  });

  it("emits only when the status changes", async () => {
    const fake = await startFakeOllama();
    cleanups.push(() => fake.close());
    const { rt, seen } = await makeRuntime({ externalBaseUrl: fake.baseUrl });
    await rt.discover();
    await rt.discover();
    expect(seen).toHaveLength(1);
    await fake.close();
    cleanups.pop();
    await rt.discover();
    expect(seen.map((s) => s.state)).toEqual(["ready", "missing"]);
  });
});
