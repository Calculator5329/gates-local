// How the installed-copy probes start a packaged copy, on Linux and Windows.
// Run on the test machine only.
//
// Linux: the argument is an AppImage. Each launch copies it into its own home
// under the work folder, with XDG data and config there too, and a fake git
// first on PATH that records any call.
// Windows: the argument is the installed program (Gates Local.exe under
// %LOCALAPPDATA%\Programs), which stays where the installer put it. Its
// profile and data folders are pinned inside the work folder, and PATH must
// hold no git at all, so a git call cannot start anything (there is no fake
// git.exe to record it; the report says which check ran).
import { _electron, type ElectronApplication } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const windows = process.platform === "win32";

/** This copy's own entry in a release list: Windows reads the installer, Linux the AppImage. */
export const ownPlatform = windows ? "win32" : "linux";
export const otherPlatform = windows ? "linux" : "win32";

export function artifactFor(platform: "linux" | "win32", version: string): { platform: "linux" | "win32"; arch: "x64"; kind: "appimage" | "nsis"; file: string } {
  return platform === "linux"
    ? { platform, arch: "x64", kind: "appimage", file: `Gates-Local-${version}-x86_64.AppImage` }
    : { platform, arch: "x64", kind: "nsis", file: `Gates-Local-${version}-Setup-x64.exe` };
}

/** A fresh work folder. PROBE_CACHE moves it (the Windows round keeps everything in its own folder). */
export function workFolder(name: string): string {
  const cache = process.env["PROBE_CACHE"] ?? path.join(homedir(), ".cache", name);
  mkdirSync(cache, { recursive: true });
  return mkdtempSync(path.join(cache, "run-"));
}

/** The probe's environment without anything that would steer the copy. */
export function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("GATES_LOCAL_") && !key.startsWith("APPIMAGE") && key !== "ELECTRON_RUN_AS_NODE" && key !== "PROBE_CACHE") env[key] = value;
  }
  return env;
}

export interface GitWatch {
  /** Prepended to PATH on Linux; empty on Windows. */
  readonly bin: string | null;
  /** "recorded": a fake git logged every call. "absent": no git on PATH at all. */
  readonly how: "recorded" | "absent";
  calls(): string;
}

export function watchGit(work: string, env: Record<string, string>): GitWatch {
  if (windows) {
    const found = spawnSync("where.exe", ["git"], { env, encoding: "utf8", windowsHide: true }).status === 0;
    if (found) throw new Error("git is on PATH; run the Windows probe with a PATH that holds no git.");
    return { bin: null, how: "absent", calls: () => "" };
  }
  const bin = path.join(work, "bin");
  const log = path.join(work, "git-calls.log");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "git"), `#!/bin/sh\necho "$@" >> '${log}'\nexit 1\n`);
  chmodSync(path.join(bin, "git"), 0o755);
  return { bin, how: "recorded", calls: () => (existsSync(log) ? readFileSync(log, "utf8") : "") };
}

/** Where the copy keeps its data: the folder a probe seeds settings into before launch. */
export const dataFolderIn = (home: string) => path.join(home, "data", "gates-local-installed");

/** Start one copy with its own home under work. extra holds the runtime and feed variables. */
export async function launchCopy(artifact: string, home: string, base: Record<string, string>, git: GitWatch, extra: Record<string, string>): Promise<ElectronApplication> {
  mkdirSync(home, { recursive: true });
  if (windows) {
    return _electron.launch({
      executablePath: artifact,
      args: [],
      env: {
        ...base, ...extra, TEMP: home, TMP: home,
        GATES_LOCAL_USER_DATA: path.join(home, "profile"),
        GATES_LOCAL_DATA_DIR: dataFolderIn(home),
      },
      timeout: 30_000,
    });
  }
  const installed = path.join(home, "Gates-Local.AppImage");
  writeFileSync(installed, readFileSync(artifact));
  chmodSync(installed, 0o755);
  return _electron.launch({
    executablePath: installed,
    args: ["--no-sandbox", "--disable-gpu"],
    env: {
      ...base, ...extra, APPIMAGE_EXTRACT_AND_RUN: "1", TMPDIR: home,
      PATH: `${git.bin}:${base["PATH"] ?? "/usr/bin:/bin"}`,
      XDG_DATA_HOME: path.join(home, "data"), XDG_CONFIG_HOME: path.join(home, "config"),
    },
    timeout: 30_000,
  });
}
