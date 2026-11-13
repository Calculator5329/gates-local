// Packaged Linux upgrade probes. Run only on the test machine, with a display.
// No real Ollama/ComfyUI or model downloads.
//
//   node apps/desktop/scripts/packaged-upgrade.ts <older> <newer> [output]
//     Build-to-build persistence: a person replaces the AppImage by hand.
//
//   node apps/desktop/scripts/packaged-upgrade.ts --installed-update <N> <N+1> [output] [--only=IU-03,IU-05] [--cases=W1.before,earlier-failure] [--parallel=4]
//     The installed copy's own update (docs/design/installed-updates.md,
//     section 10), from two test builds (GATES_LOCAL_TEST_BUILD=1) named
//     Gates-Local-<version>-x86_64.AppImage:
//       IU-03  N to N+1 in extract mode and mounted: the result carries T1's
//              token, the old file is gone, no client before the result, the
//              note shows once.
//       IU-04  N to a broken N+1 (its server never says ready and has raised
//              the store's version): it goes back, the store is restored, the
//              result carries T2's token, the words.
//       IU-05  every named stop point, then an ordinary launch finishes it;
//              a double-click during an update; a dead watcher during L2.
//       IU-06  APPIMAGE set in both modes; each refusal's sentence; the
//              earlier-failure row; a moved copy starts past row C's leftovers.
//     The feed is a loopback server on a free port with a fresh test key that
//     exists only in this process. Each copy gets its own home folder, removed
//     at the end with every process it started. report.json and the
//     screenshots go to output; a failing test exits 1.
import { _electron, chromium, expect, type Browser, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { decodeResult, decodeServerMessage, encodeRequest, type MethodName, type Params, type ResultOf } from "@gates-local/contracts";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultSettings, SETTINGS_FILE_NAME, SETTINGS_FILE_VERSION } from "../../server/src/settings/store.ts";
import { openThreadStore } from "../../server/src/threads/store.ts";
import { encodeManifest, signManifest } from "../../server/src/update/release-manifest.ts";
import type { GatesLocalBridge } from "../src/bridge.ts";
import { WATCH_FLAG } from "../src/installed-update/launch-kinds.ts";
import { rowOf, STOP_POINTS, type Row, type StopPoint } from "../src/installed-update/stop-points.ts";
import { approve, INSTALLED_APPROVAL_MS, transactionFile, UPDATES_FOLDER, writeIntent } from "../src/installed-update/transaction.ts";
import { writeResult } from "../src/installed-update/results.ts";
import { cannotReplace, earlierFailure, otherCopy, rolledBack, secondLaunch, startedTooLate, stuck, updated, watcherDied, type CannotReplace } from "../src/installed-update/words.ts";
import { findFreePort } from "../src/supervisor.ts";

function digest(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function rpc<M extends MethodName>(page: Page, method: M, params: Params<M>): Promise<ResultOf<M>> {
  const url = await page.evaluate(() => (globalThis as unknown as { gatesLocal: GatesLocalBridge }).gatesLocal.getServerUrl());
  if (!url) throw new Error("Server is not ready");
  const request = encodeRequest("upgrade-probe", method, params);
  if (!request.ok) throw new Error("Invalid probe request");
  const result = await new Promise<unknown>((resolve, reject) => {
    // No Origin is sent by Node. Renderer-origin admission is checked by packaged-smoke.
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.close(); reject(new Error(`Timed out: ${method}`)); }, 10_000);
    const finish = () => { clearTimeout(timer); ws.close(); };
    ws.addEventListener("open", () => ws.send(request.value));
    ws.addEventListener("error", () => { finish(); reject(new Error(`Connection failed: ${method}`)); });
    ws.addEventListener("message", event => {
      const message = decodeServerMessage(String(event.data));
      if (!message.ok || message.value.type !== "response" || message.value.id !== "upgrade-probe") return;
      finish();
      if (!message.value.ok) reject(new Error(`Request failed: ${method}`));
      else resolve(message.value.result);
    });
  });
  const decoded = decodeResult(method, result);
  if (!decoded.ok) throw new Error(`Invalid result: ${method}`);
  return decoded.value;
}

async function buildToBuild(argv: readonly string[]): Promise<void> {
const [before, after] = argv;
if (!before || !after) throw new Error("Pass the older and newer AppImage paths.");
const output = path.resolve(argv[2] ?? "dist/packaged-upgrade");
mkdirSync(output, { recursive: true });
const cache = path.join(homedir(), ".cache", "gates-local-upgrade");
mkdirSync(cache, { recursive: true });
const work = mkdtempSync(path.join(cache, "run-"));
const installed = path.join(work, "install", "Gates-Local.AppImage");
mkdirSync(path.dirname(installed));
const dataHome = path.join(work, "data");
const configHome = path.join(work, "config");
const expectedData = path.join(dataHome, "gates-local-installed");
const developerData = path.join(dataHome, "gates-local");
const expectedProfile = path.join(configHome, "gates-local-installed");
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && !key.startsWith("GATES_LOCAL_") && !key.startsWith("APPIMAGE") && key !== "ELECTRON_RUN_AS_NODE") env[key] = value;
}
Object.assign(env, {
  TMPDIR: work, XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: configHome,
  GATES_LOCAL_RUNTIME: "discover-only", GATES_LOCAL_OLLAMA_BINARY: "none",
  GATES_LOCAL_OLLAMA_URL: "http://127.0.0.1:19750", GATES_LOCAL_COMFY_URL: "http://127.0.0.1:1",
});
expect(digest(before)).not.toBe(digest(after));

async function launch(): Promise<ElectronApplication> {
  return _electron.launch({
    executablePath: installed,
    args: ["--no-sandbox", "--disable-gpu"],
    env: { ...env, APPIMAGE_EXTRACT_AND_RUN: "1" },
    artifactsDir: output, timeout: 20_000,
  });
}

async function bridge(page: Page, expected = expectedData): Promise<string> {
  const folder = await page.evaluate(() => (globalThis as unknown as { gatesLocal: GatesLocalBridge }).gatesLocal.dataFolder());
  expect(folder).toBe(expected);
  return folder;
}

async function checkUpgrade(developerPage: Page, olderArtifact: string, newerArtifact: string): Promise<void> {
  cpSync(olderArtifact, installed);
  chmodSync(installed, 0o755);
  expect(existsSync(expectedData)).toBe(false);
  let threadId: string;
  let olderVersion: string;
  const older = await launch();
  try {
    olderVersion = await older.evaluate(({ app }) => app.getVersion());
    expect(await older.evaluate(({ app }) => app.isPackaged)).toBe(true);
    expect(await older.evaluate(({ app }) => app.getPath("userData"))).toBe(expectedProfile);
    const page = await older.firstWindow();
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible({ timeout: 20_000 });
    await bridge(page);
    expect(await rpc(page, "threads.list", {})).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem("packaging-developer-probe"))).toBeNull();
    const thread = await rpc(page, "threads.create", { title: "Upgrade persistence probe" });
    threadId = thread.id;
    const saved = await rpc(page, "settings.update", { theme: "light", thinking: false, defaultNumCtx: 8192 });
    expect(saved.theme).toBe("light");
    await page.evaluate(() => localStorage.setItem("packaging-upgrade-probe", "profile persisted"));
  } finally {
    await older.close();
  }

  // A completed-message fixture avoids loading any model. The older app's
  // thread was created through its actual RPC; the newer app reads it via RPC/UI.
  const store = openThreadStore(path.join(expectedData, "threads.sqlite"));
  try { store.appendMessage({ threadId, role: "user", content: "Saved before replacing the AppImage." }); }
  finally { store.close(); }
  const modelFixture = path.join(expectedData, "models", "upgrade-fixture.bin");
  mkdirSync(path.dirname(modelFixture), { recursive: true });
  writeFileSync(modelFixture, "A preservation fixture, not an actual Ollama model.\n");
  const modelHash = digest(modelFixture);
  mkdirSync(path.join(work, "_archive"));
  renameSync(installed, path.join(work, "_archive", "older.AppImage"));
  cpSync(newerArtifact, installed);
  chmodSync(installed, 0o755);

  const newer = await launch();
  let newerVersion: string;
  try {
    newerVersion = await newer.evaluate(({ app }) => app.getVersion());
    expect(newerVersion).not.toBe(olderVersion);
    expect(await newer.evaluate(({ app }) => app.isPackaged)).toBe(true);
    expect(await newer.evaluate(({ app }) => app.getPath("userData"))).toBe(expectedProfile);
    const page = await newer.firstWindow();
    await expect(page.locator(".sidebar").or(page.getByText("Upgrade persistence probe", { exact: true })).first()).toBeVisible({ timeout: 20_000 });
    await bridge(page);
    const saved = await rpc(page, "settings.get", {});
    expect(saved).toMatchObject({ theme: "light", thinking: false, defaultNumCtx: 8192 });
    const thread = await rpc(page, "threads.get", { threadId });
    expect(thread.thread.title).toBe("Upgrade persistence probe");
    expect(thread.messages.map(message => message.content)).toContain("Saved before replacing the AppImage.");
    expect(await page.evaluate(() => localStorage.getItem("packaging-upgrade-probe"))).toBe("profile persisted");
    expect(await page.evaluate(() => localStorage.getItem("packaging-developer-probe"))).toBeNull();
    expect(digest(modelFixture)).toBe(modelHash);
    await page.evaluate(id => { (globalThis as unknown as { location: { hash: string } }).location.hash = `thread=${id}`; }, threadId);
    await expect(page.getByText("Saved before replacing the AppImage.", { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(output, "upgraded.png") });
  } finally {
    await newer.close();
  }
  expect((await rpc(developerPage, "threads.list", {})).map(thread => thread.title)).toEqual(["Developer-only thread"]);
  expect(await rpc(developerPage, "settings.get", {})).toMatchObject({ theme: "dark", defaultNumCtx: 32768 });
  expect(await developerPage.evaluate(() => localStorage.getItem("packaging-developer-probe"))).toBe("developer profile");
  expect(await developerPage.evaluate(() => localStorage.getItem("packaging-upgrade-probe"))).toBeNull();
  writeFileSync(path.join(output, "upgrade.json"), JSON.stringify({
    olderVersion, newerVersion, sameInstalledPath: true, uninstall: false,
    dataPath: "$XDG_DATA_HOME/gates-local-installed", profilePath: "$XDG_CONFIG_HOME/gates-local-installed", dataOverrides: false,
    simultaneousDeveloper: true, separateInstanceLocks: true,
    developerDataPath: "$XDG_DATA_HOME/gates-local", developerProfilePath: "$XDG_CONFIG_HOME/gates-local",
    developerStoreUnchanged: true, developerProfileUnchanged: true,
    settings: true, thread: true, completedMessageFixture: true,
    profileLocalStorage: true, modelFileFixture: true, realModel: false,
    extractionMode: true, chromiumSandboxDisabled: true,
  }, null, 2) + "\n");
  console.log(`Build-to-build persistence passed: ${olderVersion} -> ${newerVersion}.`);
}

// Same launch as the clone's desktop entry, with no Gates path overrides.
// Keeping it open catches the real single-instance collision, not just a
// pair of different strings returned by path helpers.
const developer = await _electron.launch({
  executablePath: createRequire(import.meta.url)("electron") as string,
  args: [path.resolve(import.meta.dirname, ".."), "--no-sandbox", "--disable-gpu"],
  env, artifactsDir: output, timeout: 30_000,
});
try {
  expect(await developer.evaluate(({ app }) => app.isPackaged)).toBe(false);
  expect(await developer.evaluate(({ app }) => app.getPath("userData"))).toBe(path.join(configHome, "gates-local"));
  const page = await developer.firstWindow();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible({ timeout: 20_000 });
  await bridge(page, developerData);
  expect(await rpc(page, "threads.list", {})).toEqual([]);
  await rpc(page, "threads.create", { title: "Developer-only thread" });
  await rpc(page, "settings.update", { theme: "dark", defaultNumCtx: 32768 });
  await page.evaluate(() => localStorage.setItem("packaging-developer-probe", "developer profile"));
  await checkUpgrade(page, before, after);
} finally {
  await developer.close();
}
}

// ---------------------------------------------------------------------------
// The installed copy's own update.

type IuName = "IU-03" | "IU-04" | "IU-05" | "IU-06";
const IU_NAMES: readonly IuName[] = ["IU-03", "IU-04", "IU-05", "IU-06"];
// The test-build switches (installed-update/handoff.ts and the server's main.ts),
// spelled out so this script also runs against a build that lacks them.
const STOP_AT_ENV = "GATES_LOCAL_UPDATE_TEST_STOP_AT";
const DEBUG_PORT_ENV = "GATES_LOCAL_UPDATE_TEST_DEBUG_PORT";
const FAULT_ENV = "GATES_LOCAL_UPDATE_TEST_FAULT";
const TOKEN_ENV = "GATES_LOCAL_UPDATE_STARTUP_TOKEN";
/** Every process a copy starts inherits this, so the probe can find and end them all. */
const RIG_ENV = "IU_PROBE_RIG";
const PROGRAM = "Gates-Local.AppImage";
const EXECUTABLE = "gates-local";
const RESULT_FILE = "update-result.json";
// Ports the runtime and ComfyUI own on a real machine; nothing here uses them.
const FORBIDDEN_PORTS = new Set([8188, ...Array.from({ length: 11 }, (_, i) => 11434 + i)]);
/** The forward path's rows (watch-matrix.test.ts); a point on no forward row is reached only by going back. */
const FORWARD_ROWS: readonly Row[] = ["H", "W1", "W2", "S1", "S2", "S3", "L1", "L2", "A", "C"];
const SEEDED_THREAD = "Kept across the update";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const sha512Of = (bytes: Uint8Array) => createHash("sha512").update(bytes).digest("hex");
const fileName = (version: string) => `Gates-Local-${version}-x86_64.AppImage`;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";

async function until<T>(what: string, timeoutMs: number, probe: () => T | null | undefined | false | Promise<T | null | undefined | false>, everyMs = 200): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() >= end) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}`);
    await pause(everyMs);
  }
}

const handedPorts = new Set<number>();
async function freePort(): Promise<number> {
  for (;;) {
    const port = await findFreePort();
    if (!FORBIDDEN_PORTS.has(port) && !handedPorts.has(port)) {
      handedPorts.add(port);
      return port;
    }
  }
}

interface IuFeed { readonly url: string; readonly requests: string[]; stop(): Promise<void> }

/** The release page: the signed list for N+1 and its artifact, the real N+1 file. */
async function startFeed(version: string, artifact: Buffer, key: KeyObject): Promise<IuFeed> {
  const file = fileName(version);
  const list = encodeManifest({ schema: 1, version, commit: "b".repeat(40), artifacts: [{ platform: "linux", arch: "x64", kind: "appimage", file, size: artifact.length, sha512: sha512Of(artifact) }] });
  const sig = signManifest(list, key);
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    requests.push(url);
    if (url === "/latest/download/release.json") { res.writeHead(200).end(list); return; }
    if (url === "/latest/download/release.json.sig") { res.writeHead(200).end(sig); return; }
    if (url === `/download/v${version}/${file}`) {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(artifact.length) });
      res.end(artifact);
      return;
    }
    res.writeHead(404).end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === "string") throw new Error("The loopback feed has no port.");
  if (FORBIDDEN_PORTS.has(address.port)) throw new Error(`The loopback feed got a reserved port ${address.port}; run again.`);
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    stop: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

interface Proc { readonly pid: number; readonly args: readonly string[]; readonly exe: string; readonly env: ReadonlyMap<string, string> }

function readProc(pid: string): Proc | null {
  try {
    const env = new Map<string, string>();
    for (const pair of readFileSync(`/proc/${pid}/environ`, "latin1").split("\0")) {
      const at = pair.indexOf("=");
      if (at > 0) env.set(pair.slice(0, at), pair.slice(at + 1));
    }
    // Chromium rewrites its processes' titles into one space-joined string; no argument here holds a space.
    const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split(/[\0 ]/).filter(a => a !== "");
    let exe = "";
    try { exe = readlinkSync(`/proc/${pid}/exe`); } catch { /* a zombie */ }
    return { pid: Number(pid), args, exe, env };
  } catch {
    return null;
  }
}

/**
 * This probe's processes, by rig: by the marker in their environment, or, for
 * the Electron processes whose title rewrite hides it, by an executable inside
 * the rig's folder (the program file, or its extraction or mount under TMPDIR).
 */
function scanProcesses(): Map<string, Proc[]> {
  const homes = [...activeRigs].map(r => [r.marker, `${r.home}/`] as const);
  const byRig = new Map<string, Proc[]>();
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    const proc = readProc(pid);
    if (proc === null) continue;
    const exe = proc.exe.replace(/ \(deleted\)$/, "");
    const rig = proc.env.get(RIG_ENV) ?? homes.find(([, home]) => exe.startsWith(home))?.[0];
    if (rig === undefined) continue;
    byRig.set(rig, [...(byRig.get(rig) ?? []), proc]);
  }
  return byRig;
}

const exeName = (p: Proc) => path.basename(p.exe.replace(/ \(deleted\)$/, ""));
const isServer = (p: Proc) => p.env.get("ELECTRON_RUN_AS_NODE") === "1";
/** An Electron main process: the program's executable, not a Chromium helper, not a server. */
const isMain = (p: Proc) => exeName(p) === EXECUTABLE && !isServer(p) && !p.args.some(a => a.startsWith("--type="));
const isWatcher = (p: Proc) => isMain(p) && p.args.some(a => a.startsWith(`${WATCH_FLAG}=`));
const isClient = (url: string) => !url.startsWith("data:") && !url.startsWith("devtools:") && url !== "about:blank" && url !== "";

type Mode = "extract" | "mounted";
interface RigSpec {
  readonly name: string;
  readonly mode: Mode;
  readonly stopAt?: StopPoint;
  /** N+1's server never says ready, after raising the store's version. */
  readonly fault?: boolean;
}

interface Nav { readonly at: number; readonly port: number; readonly target: string; readonly url: string }
interface Launched { readonly child: ChildProcess; readonly exited: Promise<number | null>; readonly port: number | undefined }
interface Final {
  readonly program: "older" | "newer" | "other" | "missing";
  readonly installFolder: string[];
  readonly transaction: boolean;
  readonly downloads: string[];
  readonly storeCopies: string[];
  readonly storeVersion: number | null;
  readonly threads: string[];
  readonly record: { readonly outcome?: string; readonly installed?: { readonly token?: string; readonly text?: string; readonly shown?: boolean } } | null;
}

interface Run {
  readonly older: string;
  readonly newer: string;
  readonly olderVersion: string;
  readonly newerVersion: string;
  readonly olderSha: string;
  readonly newerSha: string;
  readonly output: string;
  readonly work: string;
  readonly feed: IuFeed;
  readonly key: string;
  readonly bin: string;
  readonly baseEnv: Readonly<Record<string, string>>;
  readonly id: string;
}

const activeRigs = new Set<Rig>();
let rigCount = 0;
let ticking: NodeJS.Timeout | undefined;
function tick(): void {
  const byRig = scanProcesses();
  for (const rig of activeRigs) rig.observe(byRig.get(rig.marker) ?? []);
  for (const rig of activeRigs) void rig.pollPages();
}

class Rig {
  readonly marker: string;
  readonly home: string;
  readonly install: string;
  readonly program: string;
  readonly data: string;
  readonly tmp: string;
  readonly env: Record<string, string>;
  readonly ports: { readonly first: number; readonly launched: number; readonly extra: number };
  readonly navs: Nav[] = [];
  readonly intents: string[] = [];
  readonly tokens = new Map<number, string>();
  /** What the probe had to work around, said in the report. */
  readonly notes: string[] = [];
  maxWatchers = 0;
  maxServers = 0;
  maxMains = 0;
  storeBefore: number | null = null;
  private launches = 0;
  private logRead = 0;
  private readonly pageUrls = new Map<string, string>();
  private readonly browsers: Browser[] = [];

  readonly run: Run;
  readonly spec: RigSpec;

  private constructor(run: Run, spec: RigSpec, ports: Rig["ports"]) {
    this.run = run;
    this.spec = spec;
    this.marker = `${run.id}/${spec.name}`;
    // Short on purpose: Chromium's socket lives under TMPDIR, and a Unix socket path holds 108 bytes.
    this.home = path.join(run.work, `r${++rigCount}`);
    this.install = path.join(this.home, "install");
    this.program = path.join(this.install, PROGRAM);
    this.data = path.join(this.home, "data", "gates-local-installed");
    this.tmp = path.join(this.home, "t");
    this.ports = ports;
    this.env = {
      ...run.baseEnv,
      [RIG_ENV]: this.marker,
      TMPDIR: this.tmp,
      PATH: `${run.bin}:${run.baseEnv["PATH"] ?? "/usr/bin:/bin"}`,
      XDG_DATA_HOME: path.join(this.home, "data"), XDG_CONFIG_HOME: path.join(this.home, "config"),
      GATES_LOCAL_RUNTIME: "discover-only", GATES_LOCAL_OLLAMA_BINARY: "none",
      GATES_LOCAL_OLLAMA_URL: "http://127.0.0.1:19750", GATES_LOCAL_COMFY_URL: "http://127.0.0.1:1",
      GATES_LOCAL_UPDATE_FEED: run.feed.url,
      GATES_LOCAL_UPDATE_TEST_KEYS: run.key,
      [DEBUG_PORT_ENV]: String(ports.launched),
      ...(spec.mode === "extract" ? { APPIMAGE_EXTRACT_AND_RUN: "1" } : {}),
      ...(spec.fault === true ? { [FAULT_ENV]: `server-never-ready@${run.newerVersion}` } : {}),
    };
  }

  static async create(run: Run, spec: RigSpec): Promise<Rig> {
    const rig = new Rig(run, spec, { first: await freePort(), launched: await freePort(), extra: await freePort() });
    mkdirSync(rig.install, { recursive: true });
    mkdirSync(rig.tmp, { recursive: true });
    mkdirSync(rig.data, { recursive: true });
    // As if the person had turned on automatic checks: N downloads N+1 by itself.
    writeFileSync(path.join(rig.data, SETTINGS_FILE_NAME), `${JSON.stringify({ version: SETTINGS_FILE_VERSION, settings: { ...defaultSettings("app"), updateAutomatic: true } }, null, 2)}\n`);
    const store = openThreadStore(path.join(rig.data, "threads.sqlite"));
    try { store.createThread({ title: SEEDED_THREAD }); } finally { store.close(); }
    rig.storeBefore = storeVersionOf(path.join(rig.data, "threads.sqlite"));
    copyFileSync(run.older, rig.program);
    chmodSync(rig.program, 0o755);
    activeRigs.add(rig);
    return rig;
  }

  launch(o: { readonly port?: number; readonly stop?: boolean; readonly command?: readonly string[]; readonly env?: Readonly<Record<string, string | undefined>> } = {}): Launched {
    const n = ++this.launches;
    const logPath = path.join(this.home, `launch-${n}.log`);
    const env: Record<string, string> = { ...this.env };
    if (o.stop === true && this.spec.stopAt !== undefined) env[STOP_AT_ENV] = this.spec.stopAt;
    for (const [k, v] of Object.entries(o.env ?? {})) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    const args = ["--no-sandbox", "--disable-gpu", ...(o.port === undefined ? [] : [`--remote-debugging-port=${o.port}`])];
    const [command, ...pre] = o.command ?? [this.program];
    if (command === undefined) throw new Error("no command");
    const shown = Object.entries(env).filter(([k]) => k.startsWith("GATES_LOCAL_") || k.startsWith("APPIMAGE") || k === "TMPDIR").map(([k, v]) => `${k}=${v}`);
    writeFileSync(logPath, `${new Date().toISOString()} ${[...shown, command, ...pre, ...args].join(" ")}\n`);
    const out = openSync(logPath, "a");
    const child = spawn(command, [...pre, ...args], { env, detached: true, stdio: ["ignore", out, out] });
    closeSync(out);
    // A launch can outlive its rig's folder (one left running when the rig is put away): the log line is a help, not a step.
    const note = (line: string) => { try { appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`); } catch { /* the folder is gone */ } };
    const exited = new Promise<number | null>((resolve) => {
      child.once("exit", (code, signal) => {
        note(`exited ${String(code)} ${String(signal)}`);
        resolve(code);
      });
      child.once("error", (error) => {
        note(`did not start: ${error.message}`);
        resolve(-1);
      });
    });
    return { child, exited, port: o.port };
  }

  observe(procs: readonly Proc[]): void {
    this.maxWatchers = Math.max(this.maxWatchers, procs.filter(isWatcher).length);
    this.maxServers = Math.max(this.maxServers, procs.filter(isServer).length);
    this.maxMains = Math.max(this.maxMains, procs.filter(p => isMain(p) && !isWatcher(p)).length);
    const log = this.log();
    if (log.length > this.logRead) {
      for (const match of log.slice(this.logRead).matchAll(/token launch started \(pid (\d+)\)/g)) {
        const pid = Number(match[1]);
        const token = readProc(String(pid))?.env.get(TOKEN_ENV);
        if (token !== undefined) this.tokens.set(pid, token);
      }
      this.logRead = log.lastIndexOf("\n") + 1;
    }
    const intent = this.intent();
    if (intent !== null && this.intents.at(-1) !== intent) this.intents.push(intent);
  }

  async pollPages(): Promise<void> {
    for (const port of [this.ports.first, this.ports.launched, this.ports.extra]) {
      let list: { id: string; type: string; url: string }[];
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(400) });
        list = await res.json() as typeof list;
      } catch {
        continue;
      }
      for (const t of list) {
        if (t.type !== "page") continue;
        const key = `${port}/${t.id}`;
        if (this.pageUrls.get(key) === t.url) continue;
        this.pageUrls.set(key, t.url);
        this.navs.push({ at: Date.now(), port, target: t.id, url: t.url.startsWith("data:") ? "data:" : t.url });
      }
    }
  }

  log(): string {
    try { return readFileSync(path.join(this.data, UPDATES_FOLDER, "update.log"), "utf8"); } catch { return ""; }
  }

  intent(): string | null {
    try { return String((JSON.parse(readFileSync(transactionFile(this.data), "utf8")) as { intent?: unknown }).intent); } catch { return null; }
  }

  record(): Final["record"] {
    try { return JSON.parse(readFileSync(path.join(this.data, RESULT_FILE), "utf8")) as Final["record"]; } catch { return null; }
  }

  processes(): Proc[] {
    return scanProcesses().get(this.marker) ?? [];
  }

  /** Connects to the window on this DevTools port. */
  async connect(port: number, timeoutMs = 90_000): Promise<Page> {
    await until(`DevTools on the copy's port`, timeoutMs, async () => {
      try { return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
    });
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    this.browsers.push(browser);
    const page = await until("a window", 30_000, () => browser.contexts()[0]?.pages()[0]);
    page.on("dialog", (dialog) => void dialog.accept());
    return page;
  }

  /** Each window this probe still reaches, as it looks now, with its URL kind and whether it is painted and focused. */
  async shootPages(dir: string): Promise<string[]> {
    mkdirSync(dir, { recursive: true });
    const seen: string[] = [];
    for (const [b, browser] of this.browsers.entries()) {
      for (const [p, page] of browser.contexts().flatMap(ctx => ctx.pages()).entries()) {
        const file = path.join(dir, `failed-${b}-${p}.png`);
        try {
          const state = await page.evaluate(() => {
            const doc = (globalThis as unknown as { document: PageDocument }).document;
            return `${doc.visibilityState}, focus ${String(doc.hasFocus())}`;
          }, undefined).catch(() => "unreadable");
          await page.screenshot({ path: file, timeout: 5_000 });
          seen.push(`${path.basename(file)}: ${page.url().startsWith("data:") ? "data:" : page.url()} (${state})`);
        } catch (error) {
          seen.push(`${path.basename(file)}: no screenshot (${message(error)})`);
        }
      }
    }
    return seen;
  }

  /** Every process this copy started: asked to end, then killed, then any FUSE mount left under its home taken down. */
  async stopAll(): Promise<void> {
    for (const browser of this.browsers.splice(0)) await browser.close().catch(() => undefined);
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      const left = this.processes();
      if (left.length === 0) break;
      for (const p of left) { try { process.kill(p.pid, signal); } catch { /* gone */ } }
      await until("the copy's processes to end", signal === "SIGTERM" ? 10_000 : 5_000, () => this.processes().length === 0).catch(() => undefined);
    }
    for (const line of readFileSync("/proc/self/mounts", "utf8").split("\n")) {
      const at = line.split(" ")[1];
      if (at !== undefined && at.startsWith(this.home)) spawnSync("fusermount", ["-u", "-z", at]);
    }
  }

  final(): Final {
    const sha = existsSync(this.program) ? sha512Of(readFileSync(this.program)) : null;
    const updates = path.join(this.data, UPDATES_FOLDER);
    const copies = path.join(this.data, "store-copies");
    let threads: string[] = [];
    let storeVersion: number | null = null;
    try {
      const db = new DatabaseSync(path.join(this.data, "threads.sqlite"), { readOnly: true });
      try {
        storeVersion = Number(db.prepare("PRAGMA user_version").get()?.["user_version"]);
        threads = db.prepare("SELECT title FROM threads").all().map(r => String(r["title"]));
      } finally { db.close(); }
    } catch { /* reported as missing */ }
    return {
      program: sha === null ? "missing" : sha === this.run.olderSha ? "older" : sha === this.run.newerSha ? "newer" : "other",
      installFolder: readdirSync(this.install).toSorted(),
      transaction: existsSync(transactionFile(this.data)),
      downloads: existsSync(updates) ? readdirSync(updates).filter(n => statSync(path.join(updates, n)).isDirectory()) : [],
      storeCopies: existsSync(copies) ? readdirSync(copies) : [],
      storeVersion,
      threads,
      record: this.record(),
    };
  }

  /** Keeps the copy's logs in the output, then removes its home. */
  async dispose(): Promise<void> {
    await this.stopAll();
    activeRigs.delete(this);
    const keep = path.join(this.run.output, "rigs", this.spec.name);
    mkdirSync(keep, { recursive: true });
    for (const name of readdirSync(this.home)) if (name.startsWith("launch-")) copyFileSync(path.join(this.home, name), path.join(keep, name));
    writeFileSync(path.join(keep, "update.log"), this.log());
    // What the watcher, T1 and T2 printed (test builds keep it).
    try { copyFileSync(path.join(this.data, UPDATES_FOLDER, "spawned.log"), path.join(keep, "spawned.log")); } catch { /* nothing was started */ }
    writeFileSync(path.join(keep, "seen.json"), `${JSON.stringify({ intents: this.intents, navs: this.navs, maxWatchers: this.maxWatchers, maxServers: this.maxServers, maxMains: this.maxMains }, null, 2)}\n`);
    try { rmSync(this.home, { recursive: true, force: true }); } catch { /* a mount still busy; the run's folder goes at the end */ }
  }
}

function storeVersionOf(file: string): number | null {
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try { return Number(db.prepare("PRAGMA user_version").get()?.["user_version"]); } finally { db.close(); }
  } catch {
    return null;
  }
}

/** Collects what is wrong instead of stopping at the first. */
class Checks {
  readonly problems: string[] = [];
  /** A failed step's whole message: Playwright's call log says what it waited for. */
  readonly full: string[] = [];
  that(ok: boolean, what: string): void { if (!ok) this.problems.push(what); }
  async step<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      this.full.push(`${what}: ${(error instanceof Error ? error.message : String(error)).split("\n").filter(l => l.trim() !== "").slice(0, 12).join(" | ")}`);
      throw new Error(`${what}: ${message(error)}`, { cause: error });
    }
  }
}

const updatesGroup = (page: Page) => page.locator(".grp").filter({ has: page.locator(".grp-t", { hasText: /^Updates$/ }) });

/**
 * A click a person could make. Playwright's click waits for animation frames,
 * which a window the X server does not paint never gives; then, and only when
 * the element is the topmost one at its centre (nothing covers it), the click
 * is sent as an event, and the notes say so with why Playwright's stalled.
 */
/** The page's document, as far as these checks read it (this script is typed without the DOM). */
interface PageDocument {
  readonly visibilityState: string;
  hasFocus(): boolean;
  elementFromPoint(x: number, y: number): { readonly tagName: string; readonly className: unknown } | null;
}

async function personClick(target: Locator, notes: string[]): Promise<void> {
  try {
    await target.click({ timeout: 10_000 });
  } catch (error) {
    const seen = await target.evaluate((el) => {
      const doc = (globalThis as unknown as { document: PageDocument }).document;
      const r = el.getBoundingClientRect();
      const top = doc.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { topmost: top !== null && (top === (el as unknown) || el.contains(top as never)), at: top === null ? "nothing" : `${top.tagName.toLowerCase()}.${String(top.className)}`, visibility: doc.visibilityState, focused: doc.hasFocus() };
    }, undefined, { timeout: 5_000 }).catch(() => null);
    const why = (error instanceof Error ? error.message : String(error)).split("\n").filter(l => l.trim() !== "").slice(0, 8).join(" | ");
    notes.push(`click on ${String(target)}: ${seen === null ? "no such element" : JSON.stringify(seen)}; ${why}`);
    if (seen === null || !seen.topmost) throw error;
    await target.dispatchEvent("click");
  }
}

/**
 * Settings › General › Updates (no Ollama here, so the runtime's Retry shows):
 * from the first-run screen's Settings link before the first thread, from the
 * sidebar gear once a thread exists (after the update, the seeded one does).
 */
async function openUpdates(page: Page, notes: string[], timeoutMs = 90_000): Promise<Locator> {
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible({ timeout: timeoutMs });
  const firstRun = page.locator(".fr-cta").getByRole("button", { name: "Settings", exact: true });
  await personClick((await firstRun.count()) > 0 ? firstRun : page.locator("button.ibtn[aria-label^='Settings']"), notes);
  await personClick(page.locator(".snav").getByRole("button", { name: "General", exact: true }), notes);
  const group = updatesGroup(page);
  await expect(group).toBeVisible({ timeout: 15_000 });
  return group;
}

/** The download of N+1 is checked: either Restart to update, or the words for a copy that cannot use it. */
async function waitDownloaded(group: Locator): Promise<string> {
  // The state is row 2 (its label and its control) and the block under it.
  await expect(group.locator(".box")).toContainText(/Restart to update|cannot install it by itself|cannot replace its own file|cannot update itself/, { timeout: 180_000 });
  return await group.locator(".box").innerText();
}

const restartButton = (group: Locator) => group.getByRole("button", { name: "Restart to update", exact: true });

/** The Updates group at one fixed crop, the result line outlined; and the footer's update icon when the sidebar shows it. */
async function shoot(page: Page, group: Locator, output: string, name: string): Promise<string[]> {
  const files: string[] = [];
  await page.addStyleTag({ content: ".grp .srow:nth-child(2), .ibtn.upd { outline: 3px solid #e5484d !important; outline-offset: -3px; }" });
  const box = await group.boundingBox();
  if (box !== null) {
    const file = path.join(output, `${name}-settings.png`);
    await page.screenshot({ path: file, clip: { x: Math.max(0, box.x - 12), y: Math.max(0, box.y - 12), width: box.width + 24, height: 340 } });
    files.push(file);
  }
  const icon = page.locator(".ibtn.upd").first();
  const iconBox = await icon.isVisible() ? await icon.boundingBox() : null;
  if (iconBox !== null) {
    const file = path.join(output, `${name}-footer.png`);
    await page.screenshot({ path: file, clip: { x: Math.max(0, iconBox.x - 120), y: Math.max(0, iconBox.y - 40), width: 280, height: iconBox.height + 80 } });
    files.push(file);
  }
  return files;
}

/** The update note in the client's main area, outlined, at one fixed crop: its words, and the shot. */
async function shootNote(page: Page, output: string, name: string): Promise<{ line: string; shot: string | null }> {
  const note = page.locator(".upd-note").first();
  await expect(note).toBeVisible({ timeout: 60_000 });
  const line = await note.locator(".bm").first().innerText();
  await page.addStyleTag({ content: ".upd-note { outline: 3px solid #e5484d !important; outline-offset: 2px; }" });
  const box = await note.boundingBox();
  if (box === null) return { line, shot: null };
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file, clip: { x: Math.max(0, box.x - 12), y: Math.max(0, box.y - 12), width: box.width + 24, height: 180 } });
  return { line, shot: path.relative(output, file) };
}

/** N starts, downloads N+1 by itself, and shows Restart to update; the person clicks it. */
async function startAndRestart(rig: Rig, c: Checks, shots?: string): Promise<{ first: Launched; page: Page; shots: string[]; footer: string | null }> {
  const first = rig.launch({ port: rig.ports.first, stop: true });
  const page = await c.step("N's window", () => rig.connect(rig.ports.first));
  const group = await c.step("Settings › Updates in N", () => openUpdates(page, rig.notes));
  await c.step("N+1 downloaded and checked", () => waitDownloaded(group));
  const files = shots === undefined ? [] : await shoot(page, group, rig.run.output, shots);
  const footer = await page.locator(".ibtn.upd").first().getAttribute("aria-label", { timeout: 2_000 }).catch(() => null);
  await c.step("Restart to update in Settings", () => expect(restartButton(group)).toBeVisible({ timeout: 5_000 }));
  await personClick(restartButton(group), rig.notes);
  return { first, page, shots: files, footer };
}

/** The update has ended: no transaction, a result on disk (or taken by the start that showed it), and a client window. */
async function waitEnded(rig: Rig, since: number, timeoutMs: number): Promise<void> {
  await until("the transaction to end", timeoutMs, () => rig.intent() === null && existsSync(path.join(rig.data, UPDATES_FOLDER)));
  await until("a client window after the update", 120_000, () => rig.navs.some(n => n.at >= since && isClient(n.url)));
}

/** The common end state: the right program, nothing left over, the thread kept, at most one watcher and one server at a time. */
type Ending = "updated" | "rolled-back" | "stopped";

/** The last result the watcher wrote, from its log: an ordinary start that shows a result takes the file. */
const lastResult = (log: string): string | undefined => [...log.matchAll(/result: ([a-z-]+) \(/g)].at(-1)?.[1];
/** When the watcher wrote that result, by the log line's own time. */
const lastResultAt = (log: string): number | null => {
  const line = log.split("\n").filter(l => / result: [a-z-]+ \(/.test(l)).at(-1);
  return line === undefined ? null : Date.parse(line.slice(0, line.indexOf(" ")));
};

function checkEnd(rig: Rig, c: Checks, expected: Ending, outcome: string | undefined): Final {
  const end = rig.final();
  c.that(outcome === expected, `the update ended ${outcome ?? "with no result"}, expected ${expected}`);
  c.that(end.program === (expected === "updated" ? "newer" : "older"), `the program file holds ${end.program}, expected ${expected === "updated" ? "N+1" : "N"}`);
  c.that(end.installFolder.length === 1 && end.installFolder[0] === PROGRAM, `the program's folder holds ${JSON.stringify(end.installFolder)}`);
  c.that(!end.transaction, "the transaction file is still there");
  // Row C deletes this update's download; the version now running may check and download again (D6 (a)), which is a new folder.
  const resultAt = lastResultAt(rig.log());
  const born = (name: string) => { const s = statSync(path.join(rig.data, UPDATES_FOLDER, name)); return s.birthtimeMs > 0 ? s.birthtimeMs : s.ctimeMs; };
  const left = end.downloads.filter(n => resultAt === null || born(n) <= resultAt);
  if (left.length < end.downloads.length) rig.notes.push(`downloaded again after the result: ${JSON.stringify(end.downloads.filter(n => !left.includes(n)))}`);
  c.that(left.length === 0, `download folders left: ${JSON.stringify(left)}`);
  // B2a moves the broken version's store aside and nothing deletes it (the updater copies and deletes no data); no other ending makes one.
  const asides = end.storeCopies.filter(n => n.startsWith("aside-")).length;
  c.that(asides === (expected === "rolled-back" ? 1 : 0), `${asides} store aside folders, expected ${expected === "rolled-back" ? 1 : 0}: ${JSON.stringify(end.storeCopies)}`);
  c.that(end.threads.includes(SEEDED_THREAD), "the thread made before the update is gone");
  c.that(end.storeVersion === rig.storeBefore, `the store is at version ${String(end.storeVersion)}, was ${String(rig.storeBefore)}`);
  c.that(rig.maxWatchers <= 1, `${rig.maxWatchers} watchers ran at once`);
  c.that(rig.maxServers <= 1, `${rig.maxServers} servers ran at once`);
  return end;
}

const logIndex = (log: string, pattern: RegExp) => log.search(pattern);
const logTime = (log: string, pattern: RegExp): number | null => {
  const line = log.split("\n").find(l => pattern.test(l));
  return line === undefined ? null : Date.parse(line.slice(0, line.indexOf(" ")));
};

function tokensInOrder(rig: Rig): string[] {
  return [...rig.tokens.entries()].toSorted(([a], [b]) => rig.log().indexOf(`(pid ${a})`) - rig.log().indexOf(`(pid ${b})`)).map(([, t]) => t);
}

interface Outcome { readonly passed: boolean; readonly problems: readonly string[]; readonly details: Record<string, unknown> }

async function withRig(run: Run, spec: RigSpec, body: (rig: Rig, c: Checks, details: Record<string, unknown>) => Promise<void>): Promise<Outcome> {
  const c = new Checks();
  const details: Record<string, unknown> = { rig: spec.name, mode: spec.mode };
  let rig: Rig | undefined;
  try {
    rig = await Rig.create(run, spec);
    await body(rig, c, details);
  } catch (error) {
    c.problems.push(message(error));
  } finally {
    if (rig !== undefined) {
      if (c.problems.length > 0) details["failure shots"] = await rig.shootPages(path.join(run.output, "rigs", spec.name));
      if (c.full.length > 0) details["failed steps in full"] = c.full;
      if (rig.notes.length > 0) details["notes"] = rig.notes;
      details["log"] = rig.log().split("\n").filter(l => l !== "").map(l => l.replace(/^\S+ /, ""));
      details["intents"] = rig.intents;
      details["most at once"] = { watchers: rig.maxWatchers, servers: rig.maxServers, appMains: rig.maxMains };
      await rig.dispose();
    }
  }
  return { passed: c.problems.length === 0, problems: c.problems, details };
}

/** IU-03: N to N+1 in one mode. */
function forwardUpdate(run: Run, mode: Mode): Promise<Outcome> {
  return withRig(run, { name: `iu03-${mode}`, mode }, async (rig, c, details) => {
    const { first, page, shots, footer } = await startAndRestart(rig, c, `iu03-${mode}`);
    details["screenshots"] = shots.map(f => path.relative(run.output, f));
    details["footer before the click"] = footer;
    // U1 (IU-06): the runtime set APPIMAGE for N's main, in this mode. The main's own
    // environment is hidden by Chromium's title rewrite; its server was started with a copy.
    const server = rig.processes().find(isServer);
    const appimage = server?.env.get("APPIMAGE");
    details["APPIMAGE"] = appimage === realpathSync(rig.program) ? "the program file" : appimage ?? (server === undefined ? "no server seen" : "unset");
    const clicked = Date.now();
    await c.step("N to close", () => until("N to close", 30_000, async () => (await Promise.race([first.exited.then(() => true), pause(100).then(() => false)]))));
    await page.context().browser()?.close().catch(() => undefined);
    await c.step("the update to end", () => waitEnded(rig, clicked, 240_000));
    const t1 = await c.step("T1's window", () => rig.connect(rig.ports.launched, 30_000));
    const group = await c.step("Settings › Updates in T1", () => openUpdates(t1, rig.notes));
    void group;
    await c.step("the note in T1", () => expect(t1.locator(".upd-note .bm").first()).toHaveText(updated(run.newerVersion).text, { timeout: 15_000 }));
    const record = rig.record();
    const tokens = tokensInOrder(rig);
    const log = rig.log();
    c.that(tokens.length === 1, `${tokens.length} token launches`);
    c.that(record?.installed?.token === tokens[0], "the result does not carry T1's token");
    c.that(record?.installed?.shown === true, "T1 did not mark the result shown");
    // The watcher's line once T1's ack is read (installed-update/ack.ts says "ready").
    const acked = logIndex(log, /token launch \d+: ready/);
    const result = logIndex(log, /result: updated/);
    c.that(acked >= 0 && result > acked, "the log does not show the ack before the result");
    const resultAt = logTime(log, /result: updated/);
    const client = rig.navs.find(n => n.port === rig.ports.launched && isClient(n.url));
    const finishing = rig.navs.find(n => n.port === rig.ports.launched && n.url === "data:");
    c.that(finishing !== undefined && client !== undefined && finishing.at <= client.at, "T1 showed no page before its client");
    c.that(resultAt !== null && client !== undefined && client.at >= resultAt, `T1 showed its client ${client === undefined || resultAt === null ? "with no result time" : `${resultAt - client.at} ms before the result`}`);
    details["T1 pages"] = rig.navs.filter(n => n.port === rig.ports.launched).map(n => ({ url: n.url.startsWith("http") ? "client" : n.url, msAfterResult: resultAt === null ? null : n.at - resultAt }));
    await rig.stopAll();
    const end = checkEnd(rig, c, "updated", record?.outcome);
    details["end"] = end;
    // The next start does not say it again.
    const again = Date.now();
    rig.launch({ port: rig.ports.extra });
    const next = await c.step("the next start's window", () => rig.connect(rig.ports.extra));
    await c.step("Settings › Updates in the next start", () => openUpdates(next, rig.notes));
    await pause(2_000);
    c.that(await next.locator(".upd-note").count() === 0, "the next start shows the note again");
    details["next start ms"] = Date.now() - again;
  });
}

/** IU-04: N to a broken N+1; it goes back. */
function brokenUpdate(run: Run): Promise<Outcome> {
  return withRig(run, { name: "iu04", mode: "extract", fault: true }, async (rig, c, details) => {
    const { first } = await startAndRestart(rig, c);
    const clicked = Date.now();
    await c.step("N to close", () => first.exited);
    await c.step("the update to end", () => waitEnded(rig, clicked, 300_000));
    const t2 = await c.step("T2's window", () => rig.connect(rig.ports.launched, 30_000));
    const group = await c.step("Settings › Updates in T2", () => openUpdates(t2, rig.notes));
    const words = rolledBack(run.newerVersion, run.olderVersion).text;
    await c.step("the note in T2", () => expect(t2.locator(".upd-note .bm").first()).toHaveText(words, { timeout: 15_000 }));
    // U6: the older version read the settings the broken one wrote, unknown key and all.
    const automatic = await group.getByRole("switch", { name: "Check for updates automatically" }).getAttribute("aria-checked").catch(() => null);
    c.that(automatic === "true", `the older version's settings read automatic checks as ${String(automatic)}`);
    const saved = JSON.parse(readFileSync(path.join(rig.data, SETTINGS_FILE_NAME), "utf8")) as { settings: Record<string, unknown> };
    details["settings key the broken version added"] = "testFaultNewerKey" in saved.settings ? "still in the file" : "dropped";
    const tokens = tokensInOrder(rig);
    const record = rig.record();
    c.that(tokens.length === 2, `${tokens.length} token launches, expected T1 and T2`);
    c.that(record?.installed?.token === tokens[1], "the result does not carry T2's token");
    details["words"] = words;
    await rig.stopAll();
    const end = checkEnd(rig, c, "rolled-back", record?.outcome);
    // The broken version migrated (its pre-migration copy is there) and the store is back at N's version (checkEnd).
    c.that(end.storeCopies.includes(`threads.v${String(rig.storeBefore)}.sqlite`), `the broken version made no store copy: ${JSON.stringify(end.storeCopies)}`);
    details["end"] = end;
  });
}

/**
 * How a run killed at this point ends after the person's next launch, by the
 * recovery column of its row (docs/design/installed-updates.md, section 2).
 * - H.after: only the old main died; the watcher it spawned carries the
 *   update through by itself: `updated`, with no launch by the person.
 * - H.before and W1: the transaction still says `approved`, and a resumed launch
 *   cannot tell a watcher that never started from one that died, so the
 *   approval deadline (uptime + 30 s) decides. The probe starts the next launch
 *   once it has passed: `stopped`, nothing moved.
 * - L1.before and L1.spawned, B4.before and B4.spawned: no process record was
 *   saved, so the resumed watcher cannot rule out a T1 (T2) still running:
 *   `stuck` until the boot id changes ("when the watcher dies", step 2).
 * - Every other forward point ends `updated`; every other go-back point `rolled-back`.
 */
const DEADLINE_ROWS: readonly Row[] = ["H", "W1"];
/** Past the approval deadline (row H's uptime + INSTALLED_APPROVAL_MS), with room for a loaded machine's clock reads. */
const PAST_DEADLINE_MS = INSTALLED_APPROVAL_MS + 2_000;

function endingsAt(point: StopPoint): readonly (Ending | "stuck")[] {
  if (point === "H.after") return ["updated"];
  if (DEADLINE_ROWS.includes(rowOf(point))) return ["stopped"];
  if (["L1.before", "L1.spawned", "B4.before", "B4.spawned"].includes(point)) return ["stuck"];
  return FORWARD_ROWS.includes(rowOf(point)) ? ["updated"] : ["rolled-back"];
}

/** IU-05, one stop point: killed there, then the person's next launch takes the update to its ending. */
function stopPoint(run: Run, point: StopPoint): Promise<Outcome> {
  const forward = FORWARD_ROWS.includes(rowOf(point));
  const endings = endingsAt(point);
  return withRig(run, { name: `iu05-${point}`, mode: "extract", stopAt: point, fault: !forward }, async (rig, c, details) => {
    details["point"] = point;
    details["row"] = rowOf(point);
    details["path"] = forward ? "forward" : "go-back";
    details["expected"] = endings.join(" or ");
    await startAndRestart(rig, c);
    // The named point is logged once, when reached; an update that ends first never reaches it.
    await c.step(`the stop at ${point}`, () => until(`the stop at ${point}`, forward ? 180_000 : 300_000, () => rig.log().includes(`test stop at ${point}`) || rig.log().includes("watcher ended:")));
    if (!rig.log().includes(`test stop at ${point}`)) {
      // A stop before the point is a red, never retried; W1 logs why it stopped.
      const w1 = /W1 stopped: (.+)/.exec(rig.log())?.[1];
      if (w1 !== undefined) details["W1 stop"] = w1;
      throw new Error(`the update ended ${lastResult(rig.log()) ?? "with no result"} before reaching ${point}${w1 === undefined ? "" : ` (W1 stopped: ${w1})`}`);
    }
    const stoppedAt = Date.now();
    if (point === "H.after") {
      await c.step("the spawned watcher to finish by itself", () => waitEnded(rig, stoppedAt, 300_000));
      const outcome = lastResult(rig.log());
      await rig.stopAll();
      details["end"] = { ...checkEnd(rig, c, "updated", outcome), ending: outcome };
      return;
    }
    await pause(1_500);
    // The person closes whatever is left and starts Gates Local again.
    await rig.stopAll();
    if (DEADLINE_ROWS.includes(rowOf(point))) await pause(Math.max(0, stoppedAt + PAST_DEADLINE_MS - Date.now()));
    const intentBefore = rig.intent();
    const resumed = Date.now();
    const logBefore = rig.log().length;
    rig.launch({ port: rig.ports.extra });
    if (endings.includes("stuck")) {
      const version = rowOf(point) === "B4" ? run.olderVersion : run.newerVersion;
      await c.step("the resumed watcher to end", () => until("the resumed watcher to end", 120_000, () => rig.log().slice(logBefore).includes("watcher ended:")));
      const after = rig.log().slice(logBefore);
      c.that(after.includes("watcher ended: stuck"), `the resumed watcher ended ${/watcher ended: (\S+)/.exec(after)?.[1] ?? "without saying"}, expected stuck`);
      c.that(after.includes(`page: ${stuck(version).text}`), `the resumed watcher did not say: ${stuck(version).text}`);
      c.that(!after.includes("token launch started") && !after.includes("ordinary launch started"), "the resumed watcher started something");
      await until("the page in a window", 30_000, () => rig.navs.some(n => n.at >= resumed && n.port === rig.ports.extra && n.url === "data:")).catch(() => c.problems.push("the page was not shown in a window"));
      await rig.stopAll();
      const end = rig.final();
      c.that(end.transaction && rig.intent() === intentBefore, `the transaction is ${end.transaction ? `at ${String(rig.intent())}` : "gone"}, expected kept at ${String(intentBefore)}`);
      c.that(end.program === (rowOf(point) === "B4" ? "older" : "newer"), `the program file holds ${end.program}`);
      c.that(end.storeVersion === rig.storeBefore, `the store is at version ${String(end.storeVersion)}, was ${String(rig.storeBefore)}`);
      c.that(end.threads.includes(SEEDED_THREAD), "the thread made before the update is gone");
      details["end"] = { ...end, ending: "stuck", intent: intentBefore };
      return;
    }
    await c.step("the update to end after the next launch", () => waitEnded(rig, resumed, 300_000));
    const outcome = lastResult(rig.log());
    const w1 = /W1 stopped: (.+)/.exec(rig.log().slice(logBefore))?.[1];
    if (w1 !== undefined) details["W1 stop"] = w1;
    if (point === "W1.before") {
      // The old app had closed and only the deadline passed: the reopened app never says it did not close.
      // The watcher started it, so it took the port of launches the watcher starts.
      const page = await c.step("the reopened window", () => rig.connect(rig.ports.launched));
      const note = await c.step("the update note", () => shootNote(page, run.output, `iu05-${point}-note`));
      c.that(note.line === startedTooLate().text, `the update note says: ${note.line}`);
      details["note"] = note;
    }
    await rig.stopAll();
    const ending = endings.find(e => e === outcome) ?? endings[0];
    details["end"] = { ...checkEnd(rig, c, ending as Ending, outcome), ending: outcome };
  });
}

/** IU-05: a double-click while the watcher works, and another while T1 holds the profile. */
function doubleClick(run: Run): Promise<Outcome> {
  return withRig(run, { name: "iu05-double-click", mode: "extract" }, async (rig, c, details) => {
    const { first } = await startAndRestart(rig, c);
    const clicked = Date.now();
    await c.step("N to close", () => first.exited);
    await c.step("the watcher at work", () => until("the transaction", 10_000, () => rig.intent() !== null));
    const second = rig.launch({ port: rig.ports.extra });
    const said = await Promise.race([
      second.exited.then(code => ({ kind: "exited" as const, code })),
      until("the second launch's page", 30_000, () => rig.navs.find(n => n.port === rig.ports.extra && n.url === "data:")).then(() => ({ kind: "page" as const })),
    ]).catch((error: unknown) => ({ kind: "neither" as const, error: message(error) }));
    if (said.kind === "page") {
      const page = await rig.connect(rig.ports.extra, 10_000);
      const text = await page.locator("main").innerText();
      c.that(text.includes(secondLaunch().text), `the second launch said: ${text}`);
      details["second launch"] = text.split("\n")[0];
      await page.close();
      const code = await Promise.race([second.exited, pause(15_000).then(() => "still running" as const)]);
      c.that(code !== "still running", "the second launch did not exit when its page closed");
    } else {
      details["second launch"] = said;
      c.that(said.kind === "exited", "the second launch neither said anything nor exited");
    }
    await c.step("T1 running", () => until("T1", 120_000, () => rig.tokens.size > 0));
    const third = rig.launch();
    const thirdExit = await Promise.race([third.exited, pause(20_000).then(() => "still running" as const)]);
    c.that(thirdExit !== "still running", "a launch while T1 held the profile did not exit");
    details["launch while T1 runs"] = thirdExit === "still running" ? "still running" : "exited";
    await c.step("the update to end", () => waitEnded(rig, clicked, 240_000));
    const record = rig.record();
    c.that(rig.tokens.size === 1, `${rig.tokens.size} token launches`);
    c.that(rig.maxMains <= 2, `${rig.maxMains} app windows' main processes at once`);
    await rig.stopAll();
    details["end"] = checkEnd(rig, c, "updated", record?.outcome);
  });
}

/** IU-05: the watcher dies during L2; T1 says so; closing it and starting again finishes the update (U14: T1's server ends with it). */
function deadWatcher(run: Run): Promise<Outcome> {
  return withRig(run, { name: "iu05-dead-watcher", mode: "extract", stopAt: "L2.before" }, async (rig, c, details) => {
    await startAndRestart(rig, c);
    await c.step("the watcher killed at L2", () => until("the stop at L2.before", 180_000, () => rig.log().includes("test stop at L2.before")));
    const t1 = await c.step("T1's window", () => rig.connect(rig.ports.launched, 60_000));
    const words = watcherDied().text;
    await c.step("T1's words", () => expect(t1.locator("main")).toContainText(words, { timeout: 30_000 }));
    details["T1 said"] = words;
    await until("T1's server to stop", 20_000, () => !rig.processes().some(isServer)).catch(() => c.problems.push("T1's server still runs after the watcher died"));
    const t1Pid = [...rig.tokens.keys()][0];
    await t1.close({ runBeforeUnload: false });
    const closed = await until("T1 to exit when its window closed", 20_000, () => rig.processes().every(p => !isMain(p))).then(() => true, () => false);
    c.that(closed, "T1 did not exit when its window closed");
    details["T1 pid"] = t1Pid;
    await rig.stopAll();
    const resumed = Date.now();
    rig.launch({ port: rig.ports.extra });
    await c.step("the update to end after the next launch", () => waitEnded(rig, resumed, 240_000));
    const record = rig.record();
    await rig.stopAll();
    details["end"] = checkEnd(rig, c, "updated", record?.outcome);
  });
}

/** The extracted program run by its AppRun with APPIMAGE unset: a launch with no program file to replace. */
function appRun(rig: Rig): { command: string[]; env: Record<string, string | undefined> } {
  const extracted = spawnSync(rig.program, ["--appimage-extract"], { cwd: rig.home, env: { ...rig.env, APPIMAGE_EXTRACT_AND_RUN: undefined }, stdio: "ignore" });
  if (extracted.status !== 0) throw new Error("--appimage-extract failed");
  return { command: [path.join(rig.home, "squashfs-root", "AppRun")], env: { APPIMAGE_EXTRACT_AND_RUN: undefined, APPIMAGE: undefined, APPDIR: undefined } };
}

/** IU-06: a copy that cannot replace its file says why and where to go instead, and offers no Restart to update. */
function refusal(run: Run, reason: CannotReplace): Promise<Outcome> {
  return withRig(run, { name: `iu06-${reason}`, mode: "extract" }, async (rig, c, details) => {
    let command: string[] | undefined;
    let env: Record<string, string | undefined> = {};
    if (reason === "no-permission") chmodSync(rig.install, 0o555);
    if (reason === "not-appimage") ({ command, env } = appRun(rig));
    if (reason === "read-only") {
      const probe = spawnSync("unshare", ["-rm", "sh", "-c", 'mount --bind "$1" "$1" && mount -o remount,bind,ro "$1"', "sh", rig.install]);
      if (probe.status !== 0) {
        details["reachable"] = false;
        details["why not"] = `unshare: ${probe.stderr.toString().trim()}`;
        return;
      }
      command = ["unshare", "-rm", "sh", "-c", 'mount --bind "$1" "$1" && mount -o remount,bind,ro "$1" && shift && exec "$@"', "sh", rig.install, rig.program];
    }
    details["reachable"] = true;
    try {
      await refusalSeen(rig, c, details, reason, command, env);
    } finally {
      if (reason === "no-permission") chmodSync(rig.install, 0o755);
    }
  });
}

/**
 * IU-06, an earlier failure: an undismissed rollback-failed note. The earlier
 * failure page comes first; once N+1 is downloaded and checked, the Updates
 * row offers no Restart and says why, once, and the footer offers no restart.
 */
function earlierFailureRow(run: Run): Promise<Outcome> {
  return withRig(run, { name: "iu06-earlier-failure", mode: "extract" }, async (rig, c, details) => {
    writeResult(rig.data, { id: "earlier", from: run.olderVersion, to: run.newerVersion, outcome: "rollback-failed", keeps: [], words: { text: `Version ${run.newerVersion} did not start, and Gates Local could not go back.` } });
    rig.launch({ port: rig.ports.first });
    const page = await c.step("the window", () => rig.connect(rig.ports.first));
    await c.step("the earlier failure page", () => expect(page.locator("main")).toContainText(earlierFailure().text, { timeout: 60_000 }));
    await personClick(page.getByRole("link", { name: "Start Gates Local", exact: true }), rig.notes);
    const group = await c.step("Settings › Updates", () => openUpdates(page, rig.notes));
    await c.step("N+1 downloaded and checked", () => expect(group.locator(".box")).toContainText(/An earlier update did not finish|is downloaded and checked/, { timeout: 180_000 }));
    const text = await group.locator(".box").innerText();
    c.that(text.split(earlierFailure().text).length - 1 === 1, `the Updates row says: ${text.split("\n").join(" / ")}`);
    c.that(await restartButton(group).count() === 0, "Restart to update is offered while the earlier failure is undismissed");
    const footer = await page.locator(".ibtn.upd").first().getAttribute("aria-label", { timeout: 2_000 }).catch(() => null);
    c.that(footer !== "Restart to update", "the footer offers Restart to update");
    details["row"] = text.split("\n");
    details["footer"] = footer;
    details["screenshots"] = (await shoot(page, group, run.output, "iu06-earlier-failure")).map(f => path.relative(run.output, f));
  });
}

/**
 * IU-06, a moved copy (UW-09): row C's leftovers from a copy at another path,
 * a transaction at `cleanup` with update.lock free. A launch with no program
 * to replace (AppRun, APPIMAGE unset) and a routed launch of a file moved from
 * that path both start the app, and leave the transaction for its copy.
 */
function movedCleanup(run: Run, launched: "unrouted" | "routed"): Promise<Outcome> {
  return withRig(run, { name: `iu06-moved-${launched}`, mode: "extract" }, async (rig, c, details) => {
    const before = path.join(rig.install, `Gates-Local-${run.olderVersion}-moved-away.AppImage`);
    const record = { pid: 1, start: "s", uptime: 1 };
    const tx = approve({ id: "moved", copy: { program: before, dataDir: rig.data }, from: run.olderVersion, to: run.newerVersion, listDigest: "b".repeat(128), artifact: { platform: "linux", arch: "x64", kind: "appimage", file: path.basename(run.newer), size: 1, sha512: run.newerSha }, uptime: 1, boot: "b", main: record, server: record });
    mkdirSync(path.join(rig.data, UPDATES_FOLDER), { recursive: true });
    writeIntent(transactionFile(rig.data), { ...tx, old: { size: 1, sha512: run.olderSha }, new: { size: 1, sha512: run.newerSha }, storeBefore: 0, intent: "cleanup", ending: "updated" });
    rig.launch({ port: rig.ports.first, ...(launched === "unrouted" ? appRun(rig) : {}) });
    const page = await c.step("the window", () => rig.connect(rig.ports.first));
    const stranded = otherCopy(before).text;
    await c.step("the app or a page", () => expect(page.locator("body")).toContainText(/Retry|is in the middle of an update/, { timeout: 90_000 }));
    const said = await page.locator("body").innerText();
    details["said"] = said.split("\n").slice(0, 3);
    c.that(!said.includes(stranded), `the launch said: ${stranded}`);
    if (said.includes(stranded)) return;
    await c.step("Settings › Updates", () => openUpdates(page, rig.notes));
    c.that(existsSync(transactionFile(rig.data)), "the leftover transaction was removed by a copy that does not own it");
  });
}

async function refusalSeen(rig: Rig, c: Checks, details: Record<string, unknown>, reason: CannotReplace, command: string[] | undefined, env: Record<string, string | undefined>): Promise<void> {
  rig.launch({ port: rig.ports.first, ...(command === undefined ? {} : { command }), env });
  const page = await c.step("the window", () => rig.connect(rig.ports.first));
  const group = await c.step("Settings › Updates", () => openUpdates(page, rig.notes));
  const text = await c.step("N+1 downloaded or offered", () => waitDownloaded(group));
  const words = cannotReplace(reason, rig.run.newerVersion).text;
  c.that(text.includes(words), `the Updates group says: ${text.split("\n").join(" / ")}`);
  c.that(await restartButton(group).count() === 0, "Restart to update is offered");
  c.that(await group.getByRole("link", { name: "Open the release page" }).count() === 1, "no release page link: no next step");
  details["footer"] = await page.locator(".ibtn.upd").first().getAttribute("aria-label", { timeout: 2_000 }).catch(() => null);
  details["words"] = words;
}

function fuseProblem(): string | null {
  if (!existsSync("/dev/fuse")) return "this machine has no /dev/fuse";
  const helper = ["fusermount3", "fusermount"].some(name => spawnSync("sh", ["-c", `command -v ${name}`]).status === 0);
  if (!helper) return "this machine has no fusermount";
  // The AppImage runtime loads libfuse.so.2 with dlopen: from the system's folders, or LD_LIBRARY_PATH.
  const folders = [...(process.env["LD_LIBRARY_PATH"] ?? "").split(":"), "/lib/x86_64-linux-gnu", "/usr/lib/x86_64-linux-gnu", "/lib64", "/usr/lib64", "/lib", "/usr/lib"];
  return folders.some(f => f !== "" && existsSync(path.join(f, "libfuse.so.2"))) ? null : "this machine has no libfuse.so.2 (Ubuntu: libfuse2t64)";
}

const versionOf = (file: string) => /Gates-Local-(\d+\.\d+\.\d+)-x86_64\.AppImage$/.exec(path.basename(file))?.[1];

/** Runs the jobs at most `limit` at a time, in order of start. */
async function pool<T>(limit: number, jobs: readonly (() => Promise<T>)[]): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    for (;;) {
      const i = next++;
      const job = jobs[i];
      if (job === undefined) return;
      results[i] = await job();
    }
  }));
  return results;
}

async function installedUpdate(argv: readonly string[]): Promise<void> {
  const flags = argv.filter(a => a.startsWith("--"));
  const [older, newer, out] = argv.filter(a => !a.startsWith("--"));
  if (older === undefined || newer === undefined) throw new Error("Pass N's and N+1's test-build AppImages.");
  const only = flags.find(f => f.startsWith("--only="))?.slice("--only=".length).split(",") ?? IU_NAMES;
  const parallel = Number(flags.find(f => f.startsWith("--parallel="))?.slice("--parallel=".length) ?? "4");
  const olderVersion = versionOf(older), newerVersion = versionOf(newer);
  if (olderVersion === undefined || newerVersion === undefined) throw new Error("Name the files Gates-Local-<version>-x86_64.AppImage.");
  const output = path.resolve(out ?? "dist/installed-update");
  mkdirSync(output, { recursive: true });
  // Short: each rig's TMPDIR, and Chromium's socket under it, sit inside this folder.
  const cache = path.join(homedir(), ".cache");
  mkdirSync(cache, { recursive: true });
  const work = mkdtempSync(path.join(cache, "iu-"));
  const key = generateKeyPairSync("ed25519");
  const newerBytes = readFileSync(newer);
  const bin = path.join(work, "bin");
  const gitCalls = path.join(work, "git-calls.log");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "git"), `#!/bin/sh\necho "$@" >> '${gitCalls}'\nexit 1\n`);
  chmodSync(path.join(bin, "git"), 0o755);
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("GATES_LOCAL_") && !k.startsWith("APPIMAGE") && k !== "APPDIR" && k !== "ELECTRON_RUN_AS_NODE") baseEnv[k] = v;
  }
  const feed = await startFeed(newerVersion, newerBytes, key.privateKey);
  const run: Run = {
    older: path.resolve(older), newer: path.resolve(newer), olderVersion, newerVersion,
    olderSha: sha512Of(readFileSync(older)), newerSha: sha512Of(newerBytes),
    output, work, feed, bin, baseEnv, id: path.basename(work),
    key: key.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
  ticking = setInterval(tick, 250);
  const report: Record<string, unknown> = { olderVersion, newerVersion, parallel };
  const started = Date.now();
  try {
    const jobs: { readonly test: IuName; readonly name: string; readonly run: () => Promise<Outcome> }[] = [];
    const fuse = fuseProblem();
    if (only.includes("IU-03")) {
      jobs.push({ test: "IU-03", name: "extract", run: () => forwardUpdate(run, "extract") });
      jobs.push({ test: "IU-03", name: "mounted", run: () => fuse === null ? forwardUpdate(run, "mounted") : Promise.resolve({ passed: false, problems: [`mounted mode: ${fuse}`], details: {} }) });
    }
    if (only.includes("IU-04")) jobs.push({ test: "IU-04", name: "broken", run: () => brokenUpdate(run) });
    if (only.includes("IU-05")) {
      jobs.push({ test: "IU-05", name: "double-click", run: () => doubleClick(run) });
      jobs.push({ test: "IU-05", name: "dead watcher", run: () => deadWatcher(run) });
      for (const point of STOP_POINTS) jobs.push({ test: "IU-05", name: point, run: () => stopPoint(run, point) });
    }
    if (only.includes("IU-06")) {
      for (const reason of ["no-permission", "not-appimage", "read-only"] as const) jobs.push({ test: "IU-06", name: reason, run: () => refusal(run, reason) });
      jobs.push({ test: "IU-06", name: "earlier-failure", run: () => earlierFailureRow(run) });
      for (const launched of ["unrouted", "routed"] as const) jobs.push({ test: "IU-06", name: `moved-${launched}`, run: () => movedCleanup(run, launched) });
    }
    // --cases=<name,…> keeps only those cases, for a run of a few against another build.
    const picked = flags.find(f => f.startsWith("--cases="))?.slice("--cases=".length).split(",");
    if (picked !== undefined) jobs.splice(0, jobs.length, ...jobs.filter(job => picked.includes(job.name)));
    const outcomes = await pool(parallel, jobs.map(job => async () => {
      const at = Date.now();
      const outcome = await job.run();
      console.log(`${job.test} ${job.name}: ${outcome.passed ? "pass" : `FAIL (${outcome.problems.join("; ")})`} in ${Math.round((Date.now() - at) / 1000)} s`);
      return { ...job, outcome, seconds: Math.round((Date.now() - at) / 1000) };
    }));
    const tests: Record<string, unknown> = {};
    for (const test of IU_NAMES.filter(t => only.includes(t))) {
      const mine = outcomes.filter(o => o.test === test);
      const cases: ({ case: string; passed: boolean; seconds: number; problems: readonly string[] } & Record<string, unknown>)[] =
        mine.map(o => ({ case: o.name, passed: o.outcome.passed, seconds: o.seconds, problems: o.outcome.problems, ...o.outcome.details }));
      let passed = mine.every(o => o.outcome.passed);
      if (test === "IU-06") {
        // U1: APPIMAGE named the program file in both modes, read from IU-03's copies.
        const appimage = outcomes.filter(o => o.test === "IU-03").map(o => ({ mode: o.name, APPIMAGE: o.outcome.details["APPIMAGE"] }));
        const both = appimage.length === 2 && appimage.every(a => a.APPIMAGE === "the program file");
        passed &&= both;
        tests[test] = { passed, appimageInBothModes: appimage, pinned: "not reachable in a test build: GATES_LOCAL_DATA_DIR is allowed there by design (replaceable.ts); covered by unit tests", cases };
        continue;
      }
      tests[test] = test === "IU-05"
        ? { passed, stopPoints: cases.filter(k => STOP_POINTS.includes(k.case as StopPoint)).map(k => ({ point: k.case, row: k["row"], path: k["path"], passed: k.passed, problems: k.problems })), cases }
        : { passed, cases };
    }
    report["tests"] = tests;
    report["feed requests"] = feed.requests.length;
    report["git calls"] = existsSync(gitCalls) ? readFileSync(gitCalls, "utf8").split("\n").filter(l => l !== "").length : 0;
    report["minutes"] = Math.round((Date.now() - started) / 6_000) / 10;
    report["passed"] = Object.values(tests).every(t => (t as { passed: boolean }).passed) && report["git calls"] === 0;
  } catch (error) {
    report["passed"] = false;
    report["error"] = message(error);
  } finally {
    clearInterval(ticking);
    // dispose() takes the copy out of the set; a Set allows that while it is iterated.
    for (const rig of activeRigs) await rig.dispose().catch(() => undefined);
    await feed.stop().catch(() => undefined);
    report["processes left"] = [...scanProcesses().entries()].filter(([rig]) => rig.startsWith(run.id)).length;
    try { rmSync(work, { recursive: true, force: true }); } catch (error) { report["left behind"] = `${work}: ${message(error)}`; }
  }
  writeFileSync(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Installed update: ${report["passed"] === true ? "passed" : "FAILED"}; report in ${output}/report.json`);
  if (report["passed"] !== true) process.exitCode = 1;
}

// Last, so every constant above is set before either probe runs.
if (process.argv[2] === "--installed-update") await installedUpdate(process.argv.slice(3));
else await buildToBuild(process.argv.slice(2));
