// Runtime modes (system / app), the switch between them, and the Windows
// paths with the platform injected. Fakes only: a fake Ollama server, a
// fake `ollama` binary, a fake PowerShell/taskkill runner.
import { existsSync } from "node:fs";
import path from "node:path";
import type { RuntimeStatus } from "@gates-local/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { httpGet } from "./http.ts";
import { readWindowsProc, stopOwned, windowsProcQuery, writeRecord, type SyncRunner } from "./ownership.ts";
import { appModelsDir, defaultAppDataDir, findOnPath, findSystemOllama, installedBinary, ownedStateFile } from "./paths.ts";
import { createOllamaRuntime, type OllamaRuntime, type RuntimeOptions } from "./runtime.ts";
import { createRuntimeSwitch } from "./switch.ts";
import { type FakeOllama, freePort, removeDir, startFakeOllama, tmpDir, writeFakeBinary } from "./test-fakes.ts";

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

  it("does not install the Linux build: with no Ollama anywhere it is missing", async () => {
    const rt = createOllamaRuntime({ appDataDir, home, appPort: await freePort(), externalBaseUrl: await nothingAt(), env: { PATH: "" }, systemModelsDirs: [], probeTimeoutMs: 500, platform: "win32" });
    expect(await rt.ensure()).toMatchObject({ state: "missing", detail: "No Ollama found on this machine." });
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

  it("stops its own recorded process with taskkill on the PID tree, and never one whose identity changed", async () => {
    const file = path.join(work, "owned.json");
    const rec = { pid: 4242, startTime: "/Date(1)/", command: "C:\\Tools\\ollama.exe serve", baseUrl: "http://127.0.0.1:11435", binary: "C:\\Tools\\ollama.exe", startedAt: 1 };
    let alive = true;
    const calls: string[] = [];
    const run: SyncRunner = (file_, args) => {
      if (file_ === "taskkill.exe") {
        calls.push(args.join(" "));
        alive = false;
        return "";
      }
      return alive ? JSON.stringify({ ProcessId: 4242, CreationDate: "/Date(1)/", CommandLine: rec.command }) : "";
    };
    writeRecord(file, rec);
    expect(await stopOwned(file, 500, { platform: "win32", run })).toEqual({ stopped: true, pid: 4242 });
    expect(calls).toEqual(["/PID 4242 /T"]);

    writeRecord(file, rec);
    const reused: SyncRunner = (file_, args) => {
      if (file_ === "taskkill.exe") calls.push(args.join(" "));
      return JSON.stringify({ ProcessId: 4242, CreationDate: "/Date(2)/", CommandLine: rec.command });
    };
    expect(await stopOwned(file, 500, { platform: "win32", run: reused })).toMatchObject({ stopped: false, reason: "not-ours" });
    expect(calls).toEqual(["/PID 4242 /T"]);
  });
});
