import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { httpGet } from "./http.ts";
import { probe } from "./probe.ts";
import { readProc, readRecord } from "./ownership.ts";
import { installedBinary, ownedStateFile } from "./paths.ts";
import { type OllamaRuntime, type RuntimeOptions, createOllamaRuntime } from "./runtime.ts";
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
    expect(env.kind === "response" && JSON.parse(env.body)).toEqual({ OLLAMA_MODELS: modelsDir, OLLAMA_HOST: new URL(s.baseUrl).host });
    // the folder the status reports is the one the Ollama was really given
    expect(s.modelsDir).toBe(modelsDir);

    const rec = readRecord(ownedStateFile(appDataDir));
    expect(rec?.baseUrl).toBe(s.baseUrl);
    expect(readProc(rec!.pid)?.startTime).toBe(rec!.startTime);

    // A second runtime instance (server restart) recognises it as ours.
    const again = createOllamaRuntime({ appDataDir, home, appPort: Number(new URL(s.baseUrl).port), externalBaseUrl: d.baseUrl.replace(/:\d+$/, ":1"), env: { PATH: emptyPathDir }, allowInstall: false });
    expect((await again.discover()).owner).toBe("app");

    const stop = await rt.stop();
    expect(stop).toEqual({ stopped: true, pid: rec!.pid });
    expect(readProc(rec!.pid)).toBeUndefined();
    expect(await isUp(s.baseUrl)).toBe(false);
    expect(rt.status().state).toBe("stopped");
  });

  it("falls back to an ollama on PATH and runs it as app-owned", async () => {
    const binDir = path.join(work, "bin");
    writeFakeBinary(path.join(binDir, "ollama"));
    const { rt } = await makeRuntime({ externalBaseUrl: await nothingAt(), env: { PATH: binDir } });
    const s = await rt.ensure();
    expect(s.state).toBe("ready");
    expect(s.owner).toBe("app");
    expect(s.detail).toContain("from PATH");
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
    expect(existsSync(ownedStateFile(appDataDir))).toBe(false);
  });
});

describe("missing", () => {
  it("reports missing when no install, nothing on PATH and installs are off", async () => {
    const { rt } = await makeRuntime({ externalBaseUrl: await nothingAt() });
    const s = await rt.ensure();
    expect(s.state).toBe("missing");
    expect(s.owner).toBe("none");
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
    expect(seen.map((x) => x.state)).toEqual(["missing", "installing", "starting", "ready"]);
    expect(progress.map((p) => p.phase)).toContain("done");
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
    expect(existsSync(installedBinary(appDataDir, VERSION))).toBe(false);
  });
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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
    if (alive(pid)) process.kill(pid);
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

describe("status listener", () => {
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
