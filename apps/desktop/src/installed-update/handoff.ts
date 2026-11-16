import { spawn } from "node:child_process";
import { appendFileSync, closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmdirSync, statfsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir, uptime } from "node:os";
import path from "node:path";
import { processRecord, startOf, treeGone, type ProcessRecord } from "@gates-local/update/identity";
import { endTree } from "@gates-local/update/run";
import { STARTUP_TOKEN_ENV } from "@gates-local/update/startup";
import { processAlive } from "@gates-local/update/process-state";
import { relaunchEnv } from "../update-launch.ts";
import { waitForAck } from "./ack.ts";
import { WATCH_FLAG } from "./launch-kinds.ts";
import { readResult, writeResult } from "./results.ts";
import { STOP_POINTS, type StopPoint } from "./stop-points.ts";
import { UPDATES_FOLDER } from "@gates-local/update/installed/transaction";
import type { WatcherEffects } from "./watch.ts";
import type { Words } from "@gates-local/update/installed/words";

export const TEST_STOP_AT_ENV = "GATES_LOCAL_UPDATE_TEST_STOP_AT";
export const TEST_DEBUG_PORT_ENV = "GATES_LOCAL_UPDATE_TEST_DEBUG_PORT";
export const LOG_NAME = "update.log";

const KEPT_SWITCHES = new Set(["--no-sandbox", "--disable-gpu"]);
// external: on Linux the AppImage runtime sets these for the run that set them; the program sets them again.
const RUNTIME_ENV = ["APPIMAGE", "APPDIR", "ARGV0", "OWD"];
const POLL_MS = 100;

export function forwardedArgs(argv: readonly string[], env: NodeJS.ProcessEnv, testBuild: boolean): string[] {
  const kept = [...new Set(argv.slice(1).filter(a => KEPT_SWITCHES.has(a)))];
  const port = env[TEST_DEBUG_PORT_ENV] ?? "";
  if (testBuild && /^\d{2,5}$/.test(port)) kept.push(`--remote-debugging-port=${port}`);
  return kept;
}

export const PERSON_TMPDIR_ENV = "GATES_LOCAL_UPDATE_TMPDIR";
// external: Chromium's socket sits under this folder, and a Linux socket path holds 108 bytes.
export const OWN_TMP_PREFIX = "gl-update-";

// external: Linux AppImage extract-and-run (no FUSE) unpacks into TMPDIR/appimage_extracted_<file digest>.
const extracted = (env: NodeJS.ProcessEnv) => path.basename(env["APPDIR"] ?? "").startsWith("appimage_extracted_");

const ownTmpFolder = (base: string) => mkdtempSync(path.join(base, OWN_TMP_PREFIX));

// external: Linux AppImage extract-and-run removes that folder when its app exits, so two runs of one file share it.
export function launchEnv(env: NodeJS.ProcessEnv, token: string | null, ownTmp: (base: string) => string = ownTmpFolder): NodeJS.ProcessEnv {
  const next = relaunchEnv(env);
  if (extracted(env)) {
    const base = env[PERSON_TMPDIR_ENV] || env["TMPDIR"] || tmpdir();
    next["APPIMAGE_EXTRACT_AND_RUN"] = "1";
    next[PERSON_TMPDIR_ENV] = base;
    next["TMPDIR"] = ownTmp(base);
  }
  for (const name of RUNTIME_ENV) delete next[name];
  delete next[STARTUP_TOKEN_ENV];
  if (token !== null) next[STARTUP_TOKEN_ENV] = token;
  return next;
}

export function sweepOwnTmp(env: NodeJS.ProcessEnv): void {
  const base = env[PERSON_TMPDIR_ENV];
  if (base === undefined || base === "") return;
  let names: string[];
  try { names = readdirSync(base); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(OWN_TMP_PREFIX)) continue;
    try { rmdirSync(path.join(base, name)); } catch {}
  }
}

export const spawnedOutput = (dataDir: string, testBuild: boolean): string | undefined =>
  testBuild ? path.join(dataDir, UPDATES_FOLDER, "spawned.log") : undefined;

export function spawnProgram(program: string, args: readonly string[], env: NodeJS.ProcessEnv, output?: string): number {
  let fd: number | undefined;
  // why: the output is a help, not a step, so a file that cannot open is skipped.
  try { fd = output === undefined ? undefined : openSync(output, "a"); } catch {}
  try {
    const child = spawn(program, [...args], { env, detached: true, stdio: fd === undefined ? "ignore" : ["ignore", fd, fd] });
    child.on("error", () => undefined);
    const pid = child.pid;
    if (pid === undefined) throw new Error(`${program} did not start`);
    child.unref();
    return pid;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function processGone(record: ProcessRecord): boolean {
  if (!treeGone(record)) return false;
  if (!processAlive(record.pid)) return true;
  const now = startOf(record.pid);
  return now !== null && now !== record.start;
}

export function testStopAt(env: NodeJS.ProcessEnv, testBuild: boolean, kill: () => void = () => process.kill(process.pid, "SIGKILL")): ((point: StopPoint) => void) | undefined {
  const named = env[TEST_STOP_AT_ENV] ?? "";
  if (!testBuild || !STOP_POINTS.includes(named as StopPoint)) return undefined;
  return (point) => { if (point === named) kill(); };
}

export function loggedStopAt(dataDir: string, env: NodeJS.ProcessEnv, testBuild: boolean, kill: () => void = () => process.kill(process.pid, "SIGKILL")): ((point: StopPoint) => void) | undefined {
  return testStopAt(env, testBuild, () => {
    logLine(dataDir, `test stop at ${env[TEST_STOP_AT_ENV] ?? ""}`);
    kill();
  });
}

export const logFile = (dataDir: string): string => path.join(dataDir, UPDATES_FOLDER, LOG_NAME);

export function logLine(dataDir: string, line: string): void {
  // why: the log is a help, not a step, so a line that cannot be written is dropped.
  try { appendFileSync(logFile(dataDir), `${new Date().toISOString()} [${process.pid}] ${line}\n`); } catch {}
}

export function bootId(): string {
  try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch { return ""; }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export interface HandoffSetup {
  readonly program: string;
  readonly dataDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly argv: readonly string[];
  readonly testBuild: boolean;
  readonly trustedKeys: readonly string[];
  readonly showPage: (words: Words) => void;
}

export function spawnWatcher(s: HandoffSetup): (transactionFile: string) => void {
  return (file) => {
    const pid = spawnProgram(s.program, [...forwardedArgs(s.argv, s.env, false), `${WATCH_FLAG}=${file}`], launchEnv(s.env, null), spawnedOutput(s.dataDir, s.testBuild));
    logLine(s.dataDir, `watcher started (pid ${pid}) for ${file}`);
  };
}

export function watcherEffects(s: HandoffSetup): WatcherEffects {
  const args = () => forwardedArgs(s.argv, s.env, s.testBuild);
  const stopAt = loggedStopAt(s.dataDir, s.env, s.testBuild);
  return {
    spawn: (token) => {
      const pid = spawnProgram(s.program, args(), launchEnv(s.env, token), spawnedOutput(s.dataDir, s.testBuild));
      logLine(s.dataDir, `token launch started (pid ${pid})`);
      return processRecord(pid);
    },
    waitForExit: async (record, timeoutMs) => {
      const end = performance.now() + timeoutMs;
      for (;;) {
        if (processGone(record)) return true;
        if (performance.now() >= end) return false;
        await sleep(POLL_MS);
      }
    },
    treeGone: processGone,
    stopTree: async (record) => processGone(record) || await endTree(record.pid) && processGone(record),
    waitForAck: async (token, record, timeoutMs) => {
      const ack = await waitForAck({ dataDir: s.dataDir, token, record, timeoutMs, treeGone: processGone });
      logLine(s.dataDir, `token launch ${record.pid}: ${ack}`);
      return ack;
    },
    writeResult: (result) => {
      writeResult(s.dataDir, result);
      logLine(s.dataDir, `result: ${result.outcome} (${result.from} to ${result.to})`);
    },
    readResult: (id) => readResult(s.dataDir, id),
    uptime,
    bootId,
    showPage: (words) => {
      logLine(s.dataDir, `page: ${words.text}`);
      s.showPage(words);
    },
    log: (line) => logLine(s.dataDir, line),
    freeBytes: (dir) => {
      const fs = statfsSync(dir);
      return Number(fs.bavail) * Number(fs.bsize);
    },
    trustedKeys: s.trustedKeys,
    // why: the server's setting is out of reach here; the retry sentence holds either way.
    automaticChecks: true,
    newToken: randomUUID,
    startOrdinary: () => {
      const pid = spawnProgram(s.program, args(), launchEnv(s.env, null), spawnedOutput(s.dataDir, s.testBuild));
      logLine(s.dataDir, `ordinary launch started (pid ${pid})`);
    },
    ...(stopAt === undefined ? {} : { stopAt }),
  };
}
