import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { httpGet } from "./http.ts";
import { readProc, readRecord } from "./ownership.ts";
import { installedBinary, ownedStateFile } from "./paths.ts";
import { type OllamaRuntime, type RuntimeOptions, createOllamaRuntime } from "./runtime.ts";
import type { InstallManifest } from "./schemas.ts";
import {
  buildFakeTarball,
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
  format: "tar.zst",
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
    const tarball = buildFakeTarball(work);
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
  });

  it("a bad hash on first launch is an error with the install message, nothing installed", async () => {
    const tarball = buildFakeTarball(work);
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
