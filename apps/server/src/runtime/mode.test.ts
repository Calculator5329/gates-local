// Runtime modes (system / app), the switch between them, and the Windows
// paths with the platform injected. Fakes only: a fake Ollama server, a
// fake `ollama` binary, a fake PowerShell runner.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { RuntimeStatus } from "@gates-local/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { json, startFakeServer } from "../fit/fake-http.ts";
import { httpGet } from "./http.ts";
import { clearRecord, readLinuxListenerPid, readProc, readRecord, readWindowsProc, stopOwned, windowsProcQuery, writeRecord, type SyncRunner } from "./ownership.ts";
import { appModelsDir, defaultAppDataDir, findOnPath, findSystemOllama, installDir, installedBinary, ownedStateFile, serveLogFile } from "./paths.ts";
import { ADOPTED_WINDOWS_DETAIL, WINDOWS_APP_MODE_DETAIL, createOllamaRuntime, windowsAutomaticDetail, type OllamaRuntime, type RuntimeOptions } from "./runtime.ts";
import { PINNED_OLLAMA_WINDOWS, pinnedOllamaFor } from "./manifest.ts";
import { createRuntimeSwitch } from "./switch.ts";
import {
  type FakeOllama,
  FAKE_RELEASE_FORMAT,
  buildFakeRelease,
  freePort,
  freePortRun,
  removeDir,
  startFakeOllama,
  startReleaseServer,
  startWrongService,
  tmpDir,
  writeFakeBinary,
} from "./test-fakes.ts";

const VERSION = "9.9.9-test";
let work: string;
let appDataDir: string;
let home: string;
let system: FakeOllama | undefined;
const runtimes: OllamaRuntime[] = [];

beforeEach(() => {
  work = tmpDir("mode");
  appDataDir = path.join(work, "data");
  home = path.join(work, "home");
});

afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.stop();
  await system?.close();
  system = undefined;
  removeDir(work);
});

async function runtime(over: Partial<RuntimeOptions>): Promise<OllamaRuntime> {
  const rt = createOllamaRuntime({
    appDataDir,
    home,
    appPort: await freePort(),
    env: { PATH: path.join(work, "empty"), HOME: home },
    systemModelsDirs: [],
    allowInstall: false,
    probeTimeoutMs: 500,
    startTimeoutMs: 10_000,
    manifest: { version: VERSION, url: "http://127.0.0.1:1/never", sha256: "0".repeat(64), sizeBytes: 1, format: "tar.zst", verified: true, source: "test" },
    ...over,
  });
  runtimes.push(rt);
  return rt;
}

const nothingAt = async () => `http://127.0.0.1:${await freePort()}`;
const isUp = async (baseUrl: string) => (await httpGet(`${baseUrl}/api/version`, 500)).kind === "response";

/**
 * PowerShell answers from this machine's process table and /proc/net: CIM
 * identity for whatever PID is asked, Get-NetTCPConnection's OwningProcess
 * for a listening port. Every call is logged.
 */
function cimFake(calls: string[]): SyncRunner {
  return (file_, args) => {
    calls.push(file_);
    const listen = /-LocalPort (\d+)/.exec(args.at(-1) ?? "")?.[1];
    if (listen !== undefined) {
      const owner = readLinuxListenerPid(Number(listen));
      return owner === undefined ? "" : JSON.stringify({ OwningProcess: owner });
    }
    const pid = Number(/ProcessId=(\d+)/.exec(args.at(-1) ?? "")?.[1]);
    try {
      process.kill(pid, 0);
    } catch {
      return "";
    }
    return JSON.stringify({ ProcessId: pid, CreationDate: "/Date(1)/", CommandLine: "ollama.exe serve" });
  };
}

describe("runtimeMode system", () => {
  it("uses the system Ollama and, when none answers, reports missing without starting the installed copy", async () => {
    system = await startFakeOllama({ version: "0.40.4" });
    const up = await runtime({ mode: "system", externalBaseUrl: system.baseUrl });
    expect(await up.ensure()).toMatchObject({ state: "ready", owner: "external", baseUrl: system.baseUrl });

    writeFakeBinary(installedBinary(appDataDir, VERSION));
    const down = await runtime({ mode: "system", externalBaseUrl: await nothingAt() });
    const s = await down.ensure();
    expect(s.state).toBe("missing");
    expect(s.detail).toMatch(/Start your Ollama, or choose the app's own copy in Settings › Runtime/);
    expect(existsSync(ownedStateFile(appDataDir))).toBe(false);
  });
});

describe("runtimeMode app", () => {
  it("ignores a system Ollama and runs its own copy on its own port with its own models folder", async () => {
    system = await startFakeOllama();
    writeFakeBinary(installedBinary(appDataDir, VERSION));
    const rt = await runtime({ mode: "app", externalBaseUrl: system.baseUrl });
    const s = await rt.ensure();
    expect(s).toMatchObject({ state: "ready", owner: "app" });
    expect(s.baseUrl).not.toBe(system.baseUrl);
    expect(system.requests).toEqual([]);
    const env = await httpGet(`${s.baseUrl}/fake/env`, 1000);
    expect(env.kind === "response" && JSON.parse(env.body)).toMatchObject({ OLLAMA_MODELS: appModelsDir(appDataDir) });
    expect(rt.startedByThisProcess()).toBe(true);
  });

  it("R-11: never reuses an Ollama it did not start on the app port: starts on the next free one, and a restart adopts it", async () => {
    const base = await freePortRun(2);
    const other = await startFakeOllama({ port: base });
    try {
      writeFakeBinary(installedBinary(appDataDir, VERSION));
      const rt = await runtime({ mode: "app", appPort: base, externalBaseUrl: await nothingAt() });
      const s = await rt.ensure();
      expect(s).toMatchObject({ state: "ready", owner: "app", baseUrl: `http://127.0.0.1:${base + 1}` });
      expect(s.detail).toContain(`Another Ollama, not started by this app, is on port ${base}; the app uses port ${base + 1}.`);
      // an Ollama is not a busy port: the client says nothing about ports here
      expect(s.busyPorts).toBeUndefined();
      expect(readRecord(ownedStateFile(appDataDir))?.baseUrl).toBe(`http://127.0.0.1:${base + 1}`);
      expect(other.requests.every((r) => r.startsWith("GET "))).toBe(true);

      // A server restart: the record is ours and names the port to adopt.
      const pid = readRecord(ownedStateFile(appDataDir))?.pid;
      const again = await runtime({ mode: "app", appPort: base, externalBaseUrl: await nothingAt() });
      expect(await again.ensure()).toMatchObject({ state: "ready", owner: "app", baseUrl: `http://127.0.0.1:${base + 1}` });
      expect(again.startedByThisProcess()).toBe(false);
      expect(readRecord(ownedStateFile(appDataDir))?.pid).toBe(pid);
    } finally {
      await other.close();
    }
  });

  it("R-11: with all ten ports held by other programs it is blocked and starts nothing", async () => {
    const base = await freePortRun(10);
    const others = await Promise.all(Array.from({ length: 10 }, (_, i) => startFakeOllama({ port: base + i })));
    try {
      writeFakeBinary(installedBinary(appDataDir, VERSION));
      const rt = await runtime({ mode: "app", appPort: base, externalBaseUrl: await nothingAt() });
      const s = await rt.ensure();
      expect(s).toMatchObject({
        state: "wrong-service",
        owner: "none",
        detail: `Ports ${base} to ${base + 9} are all in use by other programs, so the app cannot start its own Ollama.`,
      });
      expect(existsSync(ownedStateFile(appDataDir))).toBe(false);
    } finally {
      await Promise.all(others.map((o) => o.close()));
    }
  });

  it("S-04: a recorded copy that is alive but no longer holds its port is not adopted; the foreign Ollama there is skipped", async () => {
    const base = await freePortRun(2);
    const foreign = await startFakeOllama({ port: base });
    const recorded = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      const p = readProc(recorded.pid ?? 0);
      if (!p) throw new Error("no /proc entry for the recorded process");
      writeRecord(ownedStateFile(appDataDir), { pid: p.pid, startTime: p.startTime, command: p.command, baseUrl: foreign.baseUrl, binary: "/fake/ollama", startedAt: 1 });
      const app = await runtime({ mode: "app", appPort: base, externalBaseUrl: await nothingAt() });
      expect(await app.discover()).toMatchObject({ owner: "none", baseUrl: `http://127.0.0.1:${base + 1}` });
      const full = await runtime({ appPort: base, externalBaseUrl: await nothingAt() });
      expect(await full.discover()).toMatchObject({ state: "ready", owner: "external", baseUrl: foreign.baseUrl });
    } finally {
      recorded.kill("SIGKILL");
      clearRecord(ownedStateFile(appDataDir));
      await foreign.close();
    }
  });

  it("S-04: a recorded process that is gone once the probe returns is not adopted", async () => {
    let alive = true;
    const foreign = await startFakeServer({
      "GET /api/version": (_b, res) => {
        // The recorded Ollama exits while this answer is on its way.
        alive = false;
        json(res, 200, { version: "0.0.1-foreign" });
      },
      "GET /": (_b, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("Ollama is running");
      },
    });
    try {
      const rec = { pid: 4242, startTime: "/Date(1)/", command: "C:\\Tools\\ollama.exe serve", baseUrl: foreign.baseUrl, binary: "C:\\Tools\\ollama.exe", startedAt: 1 };
      writeRecord(ownedStateFile(appDataDir), rec);
      const run: SyncRunner = (_file, args) => {
        const command = args.at(-1) ?? "";
        if (command.includes("Get-NetTCPConnection")) return JSON.stringify({ OwningProcess: 4242 });
        return alive ? JSON.stringify({ ProcessId: 4242, CreationDate: rec.startTime, CommandLine: rec.command }) : "";
      };
      const port = Number(new URL(foreign.baseUrl).port);
      const rt = await runtime({ mode: "app", platform: "win32", procRun: run, appPort: port, externalBaseUrl: await nothingAt() });
      const s = await rt.discover();
      expect(s.owner).not.toBe("app");
      expect(s.baseUrl).not.toBe(foreign.baseUrl);
    } finally {
      await foreign.close();
    }
  });

  it("R-14: two data dirs keep separate ownership records and logs but share the install and the models folder", async () => {
    const base = await freePortRun(2);
    writeFakeBinary(installedBinary(appDataDir, VERSION));
    const stateA = path.join(work, "instance-a");
    const stateB = path.join(work, "instance-b");
    const a = await runtime({ mode: "app", appPort: base, stateDir: stateA, externalBaseUrl: await nothingAt() });
    const b = await runtime({ mode: "app", appPort: base, stateDir: stateB, externalBaseUrl: await nothingAt() });
    const sa = await a.ensure();
    const sb = await b.ensure();
    expect(sa).toMatchObject({ state: "ready", owner: "app" });
    expect(sb).toMatchObject({ state: "ready", owner: "app" });
    const recA = readRecord(ownedStateFile(stateA));
    const recB = readRecord(ownedStateFile(stateB));
    expect(recA?.baseUrl).toBe(sa.baseUrl);
    expect(recB?.baseUrl).toBe(sb.baseUrl);
    expect(recA?.pid).not.toBe(recB?.pid);
    expect(existsSync(ownedStateFile(appDataDir))).toBe(false);
    expect(existsSync(serveLogFile(stateA)) && existsSync(serveLogFile(stateB))).toBe(true);
    for (const s of [sa, sb]) {
      const env = await httpGet(`${s.baseUrl}/fake/env`, 1000);
      expect(env.kind === "response" && JSON.parse(env.body)).toMatchObject({ OLLAMA_MODELS: appModelsDir(appDataDir) });
    }
  });
});

describe("runtime switch", () => {
  it("app -> system stops the copy this process started, never the system one, and reports the change", async () => {
    system = await startFakeOllama({ version: "0.40.4" });
    writeFakeBinary(installedBinary(appDataDir, VERSION));
    const appPort = await freePort();
    const externalBaseUrl = system.baseUrl;
    const sw = createRuntimeSwitch({
      initialMode: "app",
      make: (mode) => {
        const rt = createOllamaRuntime({ appDataDir, home, appPort, externalBaseUrl, mode, env: { PATH: "" }, systemModelsDirs: [], allowInstall: false, probeTimeoutMs: 500 });
        runtimes.push(rt);
        return rt;
      },
    });
    const seen: RuntimeStatus[] = [];
    sw.onChange((s) => seen.push(s));
    const own = await sw.ensure();
    expect(own.owner).toBe("app");

    const after = await sw.setMode("system");
    expect(after).toMatchObject({ state: "ready", owner: "external", baseUrl: system.baseUrl });
    expect(sw.baseUrl()).toBe(system.baseUrl);
    expect(await isUp(own.baseUrl)).toBe(false);
    expect(await isUp(system.baseUrl)).toBe(true);
    expect(seen.at(-1)).toEqual(after);
    expect(sw.mode()).toBe("system");
    // Same mode again: nothing happens.
    const count = seen.length;
    await sw.setMode("system");
    expect(seen.length).toBe(count);
  });

  it("busyPorts audit: automatic mode keeps the system port's busyPorts when it adopts or reuses the Ollama on the app port", async () => {
    const other = await startWrongService();
    try {
      writeFakeBinary(installedBinary(appDataDir, VERSION));
      const appPort = await freePort();
      const busy = [String(other.port)];
      const first = await runtime({ appPort, externalBaseUrl: other.baseUrl });
      const started = await first.ensure();
      expect(started).toMatchObject({ state: "ready", owner: "app", busyPorts: busy });
      const record = readRecord(ownedStateFile(appDataDir));
      expect(record).toBeDefined();
      try {
        // A restart adopts the recorded copy: the system port is still held by the same program.
        const adopted = await (await runtime({ appPort, externalBaseUrl: other.baseUrl })).ensure();
        expect(adopted).toMatchObject({ state: "ready", owner: "app", baseUrl: started.baseUrl });
        expect(adopted.busyPorts).toEqual(busy);
        // Not ours (record cleared): reused as an external Ollama, busy port still named.
        clearRecord(ownedStateFile(appDataDir));
        const reused = await (await runtime({ appPort, externalBaseUrl: other.baseUrl })).ensure();
        expect(reused).toMatchObject({ state: "ready", owner: "external", baseUrl: started.baseUrl });
        expect(reused.busyPorts).toEqual(busy);
      } finally {
        // The record of the live fake serve comes back, so the first runtime stops it here,
        // before its fixture folder goes (cleared, every later stop() said no-record).
        writeRecord(ownedStateFile(appDataDir), record!);
        expect(await first.stop()).toMatchObject({ stopped: true });
      }
      expect(await isUp(started.baseUrl)).toBe(false);
    } finally {
      await other.close();
    }
  });

  it("busyPorts audit (R3-04): a start that fails and an install that fails keep the system port's busyPorts", async () => {
    const other = await startWrongService();
    try {
      const busy = [String(other.port)];
      // An executable that exits at once: the start fails.
      writeFakeBinary(installedBinary(appDataDir, VERSION), "#!/bin/sh\nexit 3\n");
      const failedStart = await (await runtime({ externalBaseUrl: other.baseUrl })).ensure();
      expect(failedStart).toMatchObject({ state: "error", owner: "none" });
      expect(failedStart.busyPorts).toEqual(busy);
      // No install and a release URL that never answers: the install fails.
      removeDir(installDir(appDataDir, VERSION));
      expect(existsSync(installedBinary(appDataDir, VERSION))).toBe(false);
      const failedInstall = await (await runtime({ externalBaseUrl: other.baseUrl, allowInstall: true })).ensure();
      expect(failedInstall).toMatchObject({ state: "error", owner: "none" });
      expect(failedInstall.busyPorts).toEqual(busy);
    } finally {
      await other.close();
    }
  });

  it("a copy adopted from an earlier run is not this process's to stop", async () => {
    writeFakeBinary(installedBinary(appDataDir, VERSION));
    const appPort = await freePort();
    const externalBaseUrl = await nothingAt();
    const opts = { appDataDir, home, appPort, externalBaseUrl, env: { PATH: "" }, systemModelsDirs: [], allowInstall: false, probeTimeoutMs: 500 } as const;
    const earlier = createOllamaRuntime({ ...opts, mode: "app" });
    runtimes.push(earlier);
    const started = await earlier.ensure();

    const sw = createRuntimeSwitch({ initialMode: "app", make: (mode) => createOllamaRuntime({ ...opts, mode }) });
    expect((await sw.ensure()).owner).toBe("app");
    expect(sw.startedByThisProcess()).toBe(false);
    await sw.setMode("system");
    await sw.stopIfStartedHere();
    expect(await isUp(started.baseUrl)).toBe(true);
  });
});

describe("Windows (platform injected)", () => {
  const winEnv = { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local", PATH: "C:\\Windows\\System32;C:\\Tools", PATHEXT: ".COM;.EXE;.BAT" };
  /** Windows arm64 with no manifest injected: no build is pinned for it. */
  const noPin = { arch: "arm64", manifest: undefined } as const;

  it("keeps app data in %LOCALAPPDATA%\\GatesLocal and the app's models under it", () => {
    expect(defaultAppDataDir(winEnv, "C:\\Users\\Ada", "win32")).toBe("C:\\Users\\Ada\\AppData\\Local\\GatesLocal");
    expect(defaultAppDataDir({}, "C:\\Users\\Ada", "win32")).toBe("C:\\Users\\Ada\\AppData\\Local\\GatesLocal");
    expect(appModelsDir("C:\\Users\\Ada\\AppData\\Local\\GatesLocal", "win32")).toBe("C:\\Users\\Ada\\AppData\\Local\\GatesLocal\\models");
  });

  it("finds ollama.exe on a ;-separated PATH through PATHEXT, else in the installer's per-user folder", () => {
    const files = new Set(["C:\\Tools\\ollama.exe"]);
    expect(findOnPath(winEnv, "ollama", "win32", (f) => files.has(f))).toBe("C:\\Tools\\ollama.exe");
    const installed = new Set(["C:\\Users\\Ada\\AppData\\Local\\Programs\\Ollama\\ollama.exe"]);
    expect(findSystemOllama(winEnv, "C:\\Users\\Ada", "win32", (f) => installed.has(f))).toBe("C:\\Users\\Ada\\AppData\\Local\\Programs\\Ollama\\ollama.exe");
    expect(findSystemOllama(winEnv, "C:\\Users\\Ada", "win32", () => false)).toBeUndefined();
  });

  it("win32 arm64 (nothing pinned) installs nothing, not even the Linux build, even with allowInstall true: with no Ollama anywhere it is missing", async () => {
    const external = await nothingAt();
    for (const allowInstall of [undefined, true] as const) {
      const rt = createOllamaRuntime({
        appDataDir,
        home,
        appPort: await freePort(),
        externalBaseUrl: external,
        env: { PATH: "" },
        systemModelsDirs: [],
        probeTimeoutMs: 500,
        platform: "win32",
        arch: "arm64",
        ...(allowInstall === undefined ? {} : { allowInstall }),
      });
      runtimes.push(rt);
      expect(await rt.ensure()).toMatchObject({ state: "missing", detail: windowsAutomaticDetail(external) });
      expect(existsSync(installDir(appDataDir, PINNED_OLLAMA_WINDOWS.version))).toBe(false);
    }
  });

  it("R2-05 (win32 arm64, nothing pinned): app mode says in words that the app's own Ollama is not on Windows yet; never a start or an install", async () => {
    for (const allowInstall of [false, true]) {
      const rt = await runtime({ mode: "app", platform: "win32", ...noPin, procRun: cimFake([]), externalBaseUrl: await nothingAt(), allowInstall });
      const s = await rt.ensure();
      expect(s).toMatchObject({ state: "missing", owner: "none", detail: WINDOWS_APP_MODE_DETAIL });
      expect(s.detail).toMatch(/not available on Windows yet/);
      expect(s.detail).toMatch(/choose Automatic or System in Settings › Runtime/);
      expect(s.detail).not.toMatch(/install|start/i);
      expect(rt.startedByThisProcess()).toBe(false);
    }
  });

  it("busyPorts audit (win32 arm64, nothing pinned): automatic with a non-Ollama on the system port names the busy port and never claims the app runs its own copy", async () => {
    const other = await startWrongService();
    try {
      const rt = await runtime({ platform: "win32", ...noPin, procRun: cimFake([]), externalBaseUrl: other.baseUrl });
      const s = await rt.ensure();
      expect(s).toMatchObject({ state: "missing", owner: "none" });
      expect(s.detail).not.toMatch(/runs its own Ollama/);
      expect(s.detail).toBe(windowsAutomaticDetail(other.baseUrl));
      expect(s.busyPorts).toEqual([String(other.port)]);
    } finally {
      await other.close();
    }
  });

  it("R2-05: automatic and system modes on Windows still use a running Ollama at the system port", async () => {
    system = await startFakeOllama({ version: "0.9.9-win" });
    for (const mode of ["system", undefined] as const) {
      const rt = await runtime({ ...(mode ? { mode } : {}), platform: "win32", procRun: cimFake([]), externalBaseUrl: system.baseUrl });
      expect(await rt.ensure()).toMatchObject({ state: "ready", owner: "external", baseUrl: system.baseUrl });
    }
  });

  it("S-07 (win32 arm64, nothing pinned): a PATH ollama.exe is never launched (path.win32 finds it; no older install in the fixture)", async () => {
    const exe = "C:\\Tools\\ollama.exe";
    const isExecutable = (file: string) => file === exe;
    // The fixture is not hollow: the Windows PATH search, joining with path.win32, finds this file.
    expect(findSystemOllama(winEnv, "C:\\Users\\Ada", "win32", isExecutable)).toBe(exe);
    const calls: string[] = [];
    for (const mode of ["app", undefined] as const) {
      const rt = await runtime({ ...(mode ? { mode } : {}), platform: "win32", ...noPin, procRun: cimFake(calls), externalBaseUrl: await nothingAt(), env: winEnv, isExecutable });
      const s = await rt.ensure();
      expect(s).toMatchObject({ state: "missing", owner: "none" });
      expect(s.detail).not.toContain(exe);
      expect(rt.startedByThisProcess()).toBe(false);
      expect(existsSync(ownedStateFile(appDataDir))).toBe(false);
    }
  });

  it("S-07: with the pinned app install present, app mode launches it over an older one (a POSIX fake run on Linux: proves only the selection rule, not a native Windows start)", async () => {
    writeFakeBinary(installedBinary(appDataDir, "0.1.0"));
    const calls: string[] = [];
    const older = await runtime({ mode: "app", platform: "win32", arch: "x64", procRun: cimFake(calls), externalBaseUrl: await nothingAt() });
    expect(await older.ensure()).toMatchObject({ state: "missing", owner: "none", detail: "No Ollama found on this machine." });
    expect(older.startedByThisProcess()).toBe(false);
    // The pinned build is the one it launches.
    writeFakeBinary(installedBinary(appDataDir, VERSION));
    const rt = await runtime({ mode: "app", platform: "win32", arch: "x64", procRun: cimFake(calls), externalBaseUrl: await nothingAt() });
    expect(await rt.ensure()).toMatchObject({ state: "ready", owner: "app" });
    expect(readRecord(ownedStateFile(appDataDir))?.binary).toBe(installedBinary(appDataDir, VERSION));
  });

  it("win32 x64 with a PATH ollama.exe and no pinned install never launches the PATH one (system mode only reads it, to say stopped)", async () => {
    const exe = "C:\\Tools\\ollama.exe";
    const isExecutable = (file: string) => file === exe;
    expect(findSystemOllama(winEnv, "C:\\Users\\Ada", "win32", isExecutable)).toBe(exe);
    for (const mode of ["app", "system", undefined] as const) {
      const rt = await runtime({ ...(mode ? { mode } : {}), platform: "win32", arch: "x64", procRun: cimFake([]), externalBaseUrl: await nothingAt(), env: winEnv, isExecutable });
      const s = await rt.ensure();
      expect({ mode, state: s.state, owner: s.owner }).toEqual({ mode, state: mode === "system" ? "stopped" : "missing", owner: "none" });
      if (mode !== "system") expect(s.detail).not.toContain(exe);
      expect(rt.startedByThisProcess()).toBe(false);
      expect(existsSync(ownedStateFile(appDataDir))).toBe(false);
    }
  });

  it("win32 x64 with allowInstall true and no PATH Ollama installs the pinned release and launches it (this host's fake release: a real ZIP only on a Windows host)", async () => {
    // With no manifest injected, the build it would install is the pinned Windows ZIP.
    const plain = await runtime({ platform: "win32", arch: "x64", manifest: undefined, allowInstall: true, externalBaseUrl: await nothingAt() });
    expect(await plain.discover()).toMatchObject({ state: "missing", detail: expect.stringContaining("will install Ollama into") });
    const asset = buildFakeRelease(work);
    const release = await startReleaseServer(asset);
    try {
      const sha256 = createHash("sha256").update(asset).digest("hex");
      const manifest = { version: VERSION, url: release.url, sha256, sizeBytes: asset.length, format: FAKE_RELEASE_FORMAT, verified: true, source: "test" };
      const rt = await runtime({ platform: "win32", arch: "x64", manifest, allowInstall: true, procRun: cimFake([]), externalBaseUrl: await nothingAt() });
      const s = await rt.ensure();
      expect(s).toMatchObject({ state: "ready", owner: "app" });
      expect(release.hits).toBe(1);
      expect(rt.startedByThisProcess()).toBe(true);
      expect(readRecord(ownedStateFile(appDataDir))?.binary).toBe(installedBinary(appDataDir, VERSION));
      expect(await rt.stop()).toMatchObject({ stopped: true });
    } finally {
      await release.close();
    }
  });

  it("pins the Windows ZIP, never the Linux build, and installs only on x64", async () => {
    expect(pinnedOllamaFor("win32", "x64")).toMatchObject({ format: "zip", url: expect.stringMatching(/\/ollama-windows-amd64\.zip$/) });
    expect(pinnedOllamaFor("linux", "x64")).toMatchObject({ format: "tar.zst", url: expect.stringMatching(/\/ollama-linux-amd64\.tar\.zst$/) });
    expect(pinnedOllamaFor("win32", "arm64")).toBeUndefined();
    expect(pinnedOllamaFor("darwin", "x64")).toBeUndefined();
    const base = { appDataDir, home, externalBaseUrl: await nothingAt(), env: { PATH: "" }, systemModelsDirs: [], probeTimeoutMs: 500, platform: "win32" } as const;
    // discover() only reports; nothing is downloaded here.
    const x64 = createOllamaRuntime({ ...base, appPort: await freePort(), arch: "x64" });
    expect(await x64.discover()).toMatchObject({ state: "missing", detail: expect.stringContaining("will install Ollama into") });
    const arm = createOllamaRuntime({ ...base, appPort: await freePort(), arch: "arm64" });
    // R2-05's words, which hold only where nothing is pinned.
    expect(await arm.ensure()).toMatchObject({ state: "missing", detail: windowsAutomaticDetail(base.externalBaseUrl) });
  });

  it("system mode with nothing answering: installed but quit says stopped, not missing, and starts nothing", async () => {
    const exe = "C:\\Users\\Ada\\AppData\\Local\\Programs\\Ollama\\ollama.exe";
    const base = { mode: "system", platform: "win32", home: "C:\\Users\\Ada", env: winEnv, externalBaseUrl: await nothingAt() } as const;
    const quit = await runtime({ ...base, isExecutable: (f) => f === exe });
    const s = await quit.ensure();
    expect(s).toMatchObject({ state: "stopped", owner: "none" });
    expect(s.detail).toContain(exe);
    expect(s.detail).toMatch(/Start Ollama from the Start menu/);
    expect(existsSync(ownedStateFile(appDataDir))).toBe(false);
    const none = await runtime({ ...base, isExecutable: () => false });
    expect(await none.ensure()).toMatchObject({ state: "missing" });
  });

  it("reads process identity from PowerShell CIM instead of /proc", () => {
    const calls: string[][] = [];
    const run: SyncRunner = (file, args) => {
      calls.push([file, ...args]);
      return '{"ProcessId":4242,"CreationDate":"/Date(1762500000000)/","CommandLine":"C:\\\\Tools\\\\ollama.exe serve"}';
    };
    expect(readWindowsProc(4242, run)).toEqual({ pid: 4242, startTime: "/Date(1762500000000)/", command: "C:\\Tools\\ollama.exe serve", state: "R" });
    expect(calls[0]).toEqual(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", windowsProcQuery(4242)]);
    expect(readWindowsProc(4242, () => "")).toBeUndefined();
    expect(readWindowsProc(4242, () => '{"ProcessId":7,"CreationDate":"x","CommandLine":"y"}')).toBeUndefined();
  });

  it("R-12: a recorded PID is never killed by number: a live record is adopted, a reused PID is not ours", async () => {
    const file = path.join(work, "owned.json");
    const rec = { pid: 4242, startTime: "/Date(1)/", command: "C:\\Tools\\ollama.exe serve", baseUrl: "http://127.0.0.1:11435", binary: "C:\\Tools\\ollama.exe", startedAt: 1 };
    const calls: string[] = [];
    const run: SyncRunner = (file_) => {
      calls.push(file_);
      return JSON.stringify({ ProcessId: 4242, CreationDate: "/Date(1)/", CommandLine: rec.command });
    };
    writeRecord(file, rec);
    expect(await stopOwned(file, 500, { platform: "win32", run })).toEqual({ stopped: false, reason: "adopted" });
    expect(existsSync(file)).toBe(true);

    const reused: SyncRunner = (file_) => {
      calls.push(file_);
      return JSON.stringify({ ProcessId: 4242, CreationDate: "/Date(2)/", CommandLine: rec.command });
    };
    expect(await stopOwned(file, 500, { platform: "win32", run: reused })).toMatchObject({ stopped: false, reason: "not-ours" });
    expect(calls.every((c) => c === "powershell.exe")).toBe(true);
  });

  it("R-12: a child this process spawned is unloaded, then killed through its handle; no taskkill", async () => {
    writeFakeBinary(installedBinary(appDataDir, VERSION));
    const calls: string[] = [];
    const rt = await runtime({ mode: "app", platform: "win32", procRun: cimFake(calls), externalBaseUrl: await nothingAt(), env: { PATH: "", FAKE_LOADED: "m:latest,n:7b" } });
    const s = await rt.ensure();
    expect(s).toMatchObject({ state: "ready", owner: "app" });
    expect(rt.startedByThisProcess()).toBe(true);
    const r = await rt.stop();
    expect(r).toMatchObject({ stopped: true });
    expect(await isUp(s.baseUrl)).toBe(false);
    const log = readFileSync(serveLogFile(appDataDir), "utf8");
    expect(log.indexOf("unloaded m:latest")).toBeGreaterThan(0);
    expect(log.indexOf("unloaded n:7b")).toBeGreaterThan(0);
    // On a POSIX host the handle kill arrives as SIGTERM, which the fake logs
    // after the unloads. On real Windows it is TerminateProcess, which runs no
    // handler: there the unloads logged before the server went down are the evidence.
    if (process.platform !== "win32") {
      const term = log.indexOf("got SIGTERM");
      expect(term).toBeGreaterThan(0);
      expect(log.indexOf("unloaded m:latest")).toBeLessThan(term);
      expect(log.indexOf("unloaded n:7b")).toBeLessThan(term);
    }
    expect(existsSync(ownedStateFile(appDataDir))).toBe(false);
    expect(calls.every((c) => c === "powershell.exe")).toBe(true);
  });

  it("R-12: an app Ollama adopted from an earlier run is left running with a plain reason", async () => {
    writeFakeBinary(installedBinary(appDataDir, VERSION));
    const calls: string[] = [];
    const appPort = await freePort();
    const opts = { mode: "app", platform: "win32", procRun: cimFake(calls), appPort, externalBaseUrl: await nothingAt() } as const;
    const earlier = await runtime(opts);
    const s = await earlier.ensure();
    const later = await runtime(opts);
    expect(await later.ensure()).toMatchObject({ state: "ready", owner: "app", baseUrl: s.baseUrl });
    expect(await later.stop()).toEqual({ stopped: false, reason: "adopted" });
    expect(later.status().detail).toBe(ADOPTED_WINDOWS_DETAIL);
    expect(await isUp(s.baseUrl)).toBe(true);
    expect(existsSync(ownedStateFile(appDataDir))).toBe(true);
    expect(calls.every((c) => c === "powershell.exe")).toBe(true);
  });
});
