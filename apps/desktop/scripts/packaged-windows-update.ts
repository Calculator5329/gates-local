// Restart to update on an installed Windows copy, for real (docs/releasing.md,
// "Restart to update on Windows: IU-W rounds"). Run ON Windows, from the
// source folder, with node, against test builds (GATES_LOCAL_TEST_BUILD=1)
// named Gates-Local-<version>-Setup-x64.exe. No real Ollama, ComfyUI or model
// download: the copy is told where they are not.
//
//   node apps/desktop/scripts/packaged-windows-update.ts --round IU-W1 --install <N Setup.exe> --newer <N+1 Setup.exe> --output <dir>
//   node apps/desktop/scripts/packaged-windows-update.ts --round IU-W3 --newer <N+1 Setup.exe> --output <dir>
//   node apps/desktop/scripts/packaged-windows-update.ts --round IU-W2 --newer <broken N+1 Setup.exe> --output <dir>
//
// Each round starts the installed copy (installing N first with --install),
// serves N+1 on a loopback feed signed with a key made in this process, waits
// for "downloaded and checked", clicks Restart to update, and watches the app
// exit, the installer run and N+1 open on the same data folder: the thread and
// the setting made under N, the result "Updated to version N+1." in the update
// status once (no banner: a successful update is silent), the kept installer
// in updates\.
//   IU-W1  also makes the thread and the setting.
//   IU-W3  first copies the install to <Programs>\gates-local-old and starts
//          that copy on a data folder of its own; it is still running after.
//   IU-W2  N+1's server exits at start (a test fault for that version): the
//          status page names N's kept installer; the round runs it silently
//          and starts the copy: N is back with the data kept.
// report-<round>.json and the screenshots go to output; a failing round exits 1.
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GatesLocalBridge } from "../src/bridge.ts";
import { PENDING_FILE, UNINSTALLER } from "../src/installed-update/windows.ts";
import { artifactFor, cleanEnv, watchGit } from "./packaged-copy.ts";
import { Checks, freePort, message, openUpdates, pause, publicKeyBase64, restartButton, rpc, seedData, shoot, startFeed, threadTitles, until, waitDownloaded } from "./installed-update-probe.ts";

type Round = "IU-W1" | "IU-W2" | "IU-W3";
const ROUNDS: readonly Round[] = ["IU-W1", "IU-W2", "IU-W3"];
const DEBUG_PORT_ENV = "GATES_LOCAL_UPDATE_TEST_DEBUG_PORT";
const FAULT_ENV = "GATES_LOCAL_UPDATE_TEST_FAULT";
const THREAD = "Made before Restart to update";
const SAFE = { GATES_LOCAL_RUNTIME: "discover-only", GATES_LOCAL_OLLAMA_BINARY: "none", GATES_LOCAL_OLLAMA_URL: "http://127.0.0.1:19750", GATES_LOCAL_COMFY_URL: "http://127.0.0.1:1" };

if (process.platform !== "win32") throw new Error("Run this on Windows.");
const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const round = arg("--round") as Round | undefined;
const newer = arg("--newer");
const install = arg("--install");
const outArg = arg("--output");
if (round === undefined || !ROUNDS.includes(round) || newer === undefined || outArg === undefined) {
  throw new Error("Pass --round IU-W1|IU-W2|IU-W3, --newer <N+1 Setup.exe> and --output <dir> (and --install <N Setup.exe> for IU-W1).");
}
const versionOf = (file: string) => /Gates-Local-(\d+\.\d+\.\d+)-Setup-x64\.exe$/i.exec(path.basename(file))?.[1];
const newerVersion = versionOf(newer);
if (newerVersion === undefined) throw new Error("Name the installers Gates-Local-<version>-Setup-x64.exe.");
const output = path.resolve(outArg);
mkdirSync(output, { recursive: true });

const local = process.env["LOCALAPPDATA"] ?? "";
const programs = path.join(local, "Programs");
const installDir = path.join(programs, "gates-local");
const appExe = path.join(installDir, "Gates Local.exe");
const dataDir = path.join(local, "GatesLocalInstalled");
const updates = path.join(dataDir, "updates");
const oldDir = path.join(programs, "gates-local-old");
const powershell = path.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const under = (dir: string, file: string | null | undefined) => typeof file === "string" && file.toLowerCase().startsWith(`${dir.toLowerCase()}\\`);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const secs = (a: number | null, b: number | null) => (a === null || b === null ? null : Math.round(b - a) / 1000);

/** One PowerShell script, sent encoded (no quoting, no execution policy change). */
function ps(script: string): string {
  const run = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
  if (run.status !== 0) throw new Error(`PowerShell failed (${String(run.status)}): ${run.stderr.trim().split("\n")[0] ?? ""}`);
  return run.stdout.trim();
}
const productVersion = (exe: string) => ps(`(Get-Item -LiteralPath '${exe.replaceAll("'", "''")}').VersionInfo.ProductVersion`);

// ---------------------------------------------------------------------------
// What runs: every Gates process (the app, its server, the installer), the old
// uninstaller and any taskkill, sampled by one PowerShell about every 250 ms.

interface Proc { readonly pid: number; readonly ppid: number; readonly name: string; readonly path: string | null; readonly cmd: string | null; readonly created: number }
interface Sample { readonly t: number; readonly p: readonly Proc[] }

class Watcher {
  readonly samples: Sample[] = [];
  private readonly child: ChildProcess;
  private buffer = "";
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
    const script = [
      "$f = \"Name LIKE 'Gates%' OR Name LIKE 'Un_%' OR Name = 'taskkill.exe'\"",
      "while ($true) {",
      "  $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
      "  $p = @(Get-CimInstance Win32_Process -Filter $f | ForEach-Object { @{ pid=$_.ProcessId; ppid=$_.ParentProcessId; name=$_.Name; path=$_.ExecutablePath; cmd=$_.CommandLine; created=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } })",
      "  [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 4 -InputObject @{ t=$t; p=$p }))",
      "  Start-Sleep -Milliseconds 150",
      "}",
    ].join("\n");
    this.child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line === "") continue;
        try {
          const s = JSON.parse(line) as { t: number; p: Proc[] | Proc | null };
          this.samples.push({ t: s.t, p: s.p === null ? [] : Array.isArray(s.p) ? s.p : [s.p] });
        } catch { /* a torn line */ }
      }
    });
  }
  last(): Sample | undefined { return this.samples.at(-1); }
  /** The first sample taken after now. */
  async next(): Promise<Sample> {
    const n = this.samples.length;
    return until("a process sample", 10_000, () => this.samples[n], 50);
  }
  stop(): void {
    this.child.kill();
    writeFileSync(this.file, this.samples.map(s => JSON.stringify(s)).join("\n") + "\n");
  }
}

// ---------------------------------------------------------------------------
// The copy, through DevTools on a port this probe chose.

async function connect(port: number, browsers: Browser[], timeoutMs: number): Promise<Page> {
  await until(`DevTools on port ${port}`, timeoutMs, async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
  }, 250);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  browsers.push(browser);
  const page = await until("a window", 30_000, () => browser.contexts()[0]?.pages()[0]);
  page.on("dialog", (dialog) => void dialog.accept());
  return page;
}

/** A page call that may never settle (a renderer mid-navigation, a bridge that does not answer) fails after ms instead. */
function within<T>(ms: number, what: string, run: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([run, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not answer in ${ms / 1000} s`)), ms); })]).finally(() => clearTimeout(timer));
}
const serverUrl = (page: Page) => within(10_000, "the bridge", page.evaluate(() => (globalThis as unknown as { gatesLocal: GatesLocalBridge }).gatesLocal.getServerUrl())).catch(() => null);
const dataFolder = (page: Page) => within(10_000, "the bridge", page.evaluate(() => (globalThis as unknown as { gatesLocal: GatesLocalBridge }).gatesLocal.dataFolder()));

/** Closes the app the way its window's close button does; the processes under `dir` end. */
async function closeApp(page: Page | null, watcher: Watcher, dir: string, notes: string[]): Promise<boolean> {
  const gone = async (ms: number) => until(`the processes under ${path.basename(dir)} to end`, ms, async () => (await watcher.next()).p.every(p => !under(dir, p.path))).then(() => true, () => false);
  if (page !== null) {
    await page.evaluate(() => (globalThis as unknown as { close(): void }).close()).catch(() => undefined);
    if (await gone(30_000)) return true;
    notes.push(`closing the window left processes under ${path.basename(dir)} running`);
  }
  const pids = (watcher.last()?.p ?? []).filter(p => under(dir, p.path) && p.name.toLowerCase() === "gates local.exe").map(p => p.pid);
  if (pids.length > 0) ps(`foreach ($id in @(${pids.join(",")})) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p) { [void]$p.CloseMainWindow() } }`);
  if (await gone(30_000)) return true;
  notes.push(`still running under ${path.basename(dir)} after closing its windows; the round's cleanup stops it`);
  return false;
}

// ---------------------------------------------------------------------------

const c = new Checks();
const notes: string[] = [];
const browsers: Browser[] = [];
const report: Record<string, unknown> = { round, newerVersion, started: new Date().toISOString() };
const watcher = new Watcher(path.join(output, `${round}-processes.jsonl`));
// One signing key for every round in this output folder, as one release key signs every version: a
// kept installer is checked against its list's signature, so a key per round would leave N's kept
// installer untrusted by N+1 and nothing to go back with.
const keyFile = path.join(output, "feed-key.pem");
const key = existsSync(keyFile)
  ? (() => { const privateKey = createPrivateKey(readFileSync(keyFile)); return { privateKey, publicKey: createPublicKey(privateKey) }; })()
  : (() => { const made = generateKeyPairSync("ed25519"); writeFileSync(keyFile, made.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 }); return made; })();
const newerBytes = readFileSync(newer);
const feed = await startFeed(newerVersion, newerBytes, key.privateKey, "win32");
const base = cleanEnv();
watchGit(output, base);
let n1Page: Page | null = null;
let copy: { readonly child: ChildProcess; page: Page | null } | null = null;
/** The installed copy this round started itself (N, or N again after going back), until it exits. */
let started: { readonly child: ChildProcess; page: Page | null } | null = null;
let failed: unknown = null;
const reportFile = path.join(output, `report-${round}.json`);
const phases: { readonly at: string; readonly phase: string }[] = [];
report["phases"] = phases;
/** Each phase goes to the log as it starts, so a round that stops says where. */
const phase = (what: string) => { phases.push({ at: new Date().toISOString(), phase: what }); console.log(`${round} | ${what}`); };
// No round outlives its deadline: the report is written, the copies this round started are stopped.
const DEADLINE_MS = 15 * 60_000;
setTimeout(() => {
  c.problems.push(`the round passed its ${DEADLINE_MS / 60_000}-minute deadline during: ${phases.at(-1)?.phase ?? "the start"}`);
  for (const child of [started?.child, copy?.child]) if (child !== undefined && child.exitCode === null) child.kill();
  watcher.stop();
  Object.assign(report, { passed: false, problems: c.problems, stepFailures: c.full, notes, ended: new Date().toISOString() });
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${round} FAILED: ${c.problems.join("; ")}`);
  process.exit(1);
}, DEADLINE_MS).unref();

try {
  // N: installed now (IU-W1), or left by the round before.
  if (install !== undefined) {
    phase("installing N");
    for (const p of [installDir, dataDir, path.join(process.env["APPDATA"] ?? "", "gates-local-installed")]) if (existsSync(p)) throw new Error(`${p} exists before the install; this round makes it, so it stops.`);
    const t = Date.now();
    const run = spawnSync(install, ["/S", "--no-desktop-shortcut"], { windowsHide: true, timeout: 180_000 });
    report["install"] = { installer: path.basename(install), exitCode: run.status, seconds: secs(t, Date.now()) };
    if (run.status !== 0) throw new Error(`the silent install of N ended ${String(run.status)}`);
    // As if the person had turned on automatic checks: N downloads N+1 by itself.
    seedData(dataDir, { automatic: true });
  }
  c.that(existsSync(path.join(installDir, UNINSTALLER)), "the install has no uninstaller beside the app");
  const olderVersion = productVersion(appExe).replace(/\.0$/, "");
  report["olderVersion"] = olderVersion;

  // IU-W3: a copy of the install in a sibling folder, on a data folder of its own, left running.
  if (round === "IU-W3") {
    phase("starting the copy in gates-local-old");
    if (existsSync(oldDir)) throw new Error(`${oldDir} exists; this round makes it, so it stops.`);
    cpSync(installDir, oldDir, { recursive: true });
    const home = path.join(output, "copy-home");
    seedData(path.join(home, "data"), { automatic: false });
    const port = await freePort();
    const child = spawn(path.join(oldDir, "Gates Local.exe"), [`--remote-debugging-port=${port}`], {
      env: { ...base, ...SAFE, GATES_LOCAL_USER_DATA: path.join(home, "profile"), GATES_LOCAL_DATA_DIR: path.join(home, "data") },
      stdio: "ignore", windowsHide: false,
    });
    copy = { child, page: null };
    copy.page = await c.step("the copy in gates-local-old opens", () => connect(port, browsers, 60_000));
    const copyPage = copy.page;
    await c.step("the copy's server is ready", () => until("the copy's server", 60_000, () => serverUrl(copyPage)));
    report["copy"] = { folder: oldDir, pid: child.pid, port };
  }

  // N starts as a person starts it, with this probe's feed and key.
  const firstPort = await freePort();
  const nextPort = await freePort();
  const env = {
    ...base, ...SAFE,
    GATES_LOCAL_UPDATE_FEED: feed.url,
    GATES_LOCAL_UPDATE_TEST_KEYS: publicKeyBase64(key.publicKey),
    [DEBUG_PORT_ENV]: String(nextPort),
    ...(round === "IU-W2" ? { [FAULT_ENV]: `server-exits@${newerVersion}` } : {}),
  };
  const nPids = new Set<number>();
  phase("starting N");
  const n = spawn(appExe, [`--remote-debugging-port=${firstPort}`], { env, stdio: "ignore", windowsHide: false });
  started = { child: n, page: null };
  let nExit: { at: number; code: number | null } | null = null;
  n.once("exit", (code) => { nExit = { at: Date.now(), code }; });
  const page = await c.step("N's window", () => connect(firstPort, browsers, 90_000));
  started.page = page;
  phase("N's window open; waiting for its server");
  await c.step("N's server is ready", () => until("N's server", 90_000, () => serverUrl(page)));
  const folder = await dataFolder(page);
  c.that(folder.toLowerCase() === dataDir.toLowerCase(), `N's data folder is ${folder}, not the installer's default`);

  phase(round === "IU-W1" ? "making a thread and a setting" : "checking the round before's result is not said again");
  if (round === "IU-W1") {
    await c.step("a thread and a setting made under N", async () => {
      await rpc(page, "threads.create", { title: THREAD });
      const saved = await rpc(page, "settings.update", { theme: "light" });
      expect(saved.theme).toBe("light");
    });
  } else {
    // The round before's result was said once; this start says nothing.
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible({ timeout: 60_000 });
    await pause(5_000);
    const again = (await rpc(page, "update.status", {})).result;
    report["resultAgainAtStart"] = again;
    c.that(again === null && (await page.locator(".upd-note").count()) === 0, `the round before's update result shows again at the next start: ${JSON.stringify(again)}`);
  }

  phase("opening Settings › Updates in N");
  const group = await c.step("Settings › Updates in N", () => openUpdates(page, notes));
  phase("waiting for N+1 to download");
  const box = await c.step("N+1 downloaded and checked", () => waitDownloaded(group));
  report["beforeClick"] = box;
  // The row's further lines are its tooltip; the server's lines are the words.
  const lines = await rpc(page, "update.status", {}).then(s => (s.lastCheck?.state === "newer" ? s.lastCheck.lines : []));
  report["beforeClickLines"] = lines;
  const goBackLine = round === "IU-W1"
    ? `To go back, download version ${olderVersion} from` // N was installed by hand: no kept installer of N
    : `To go back, run ${path.join(updates, olderVersion, artifactFor("win32", olderVersion).file)}.`;
  c.that(lines.some(l => l.includes(goBackLine)), `before the click, Updates does not say "${goBackLine}": ${JSON.stringify(lines)}`);
  phase("before shots");
  const before = await shoot(page, group, output, `${round}-before`);
  await page.screenshot({ path: path.join(output, `${round}-before.png`) });
  await c.step("Restart to update in Settings", () => expect(restartButton(group)).toBeVisible({ timeout: 5_000 }));
  for (const p of (await watcher.next()).p) if (under(installDir, p.path)) nPids.add(p.pid);

  // The click. From here: N exits, the installer runs, N+1 opens.
  const pending = { firstSeen: null as number | null, note: null as Record<string, unknown> | null, gone: null as number | null };
  const pendingPath = path.join(updates, PENDING_FILE);
  phase("the click");
  const clickAt = Date.now();
  await restartButton(group).click({ timeout: 10_000 });
  const pendingWatch = setInterval(() => {
    const there = existsSync(pendingPath);
    if (there && pending.firstSeen === null) {
      pending.firstSeen = Date.now();
      try { pending.note = JSON.parse(readFileSync(pendingPath, "utf8")) as Record<string, unknown>; } catch { /* mid-rename */ }
    }
    if (!there && pending.firstSeen !== null && pending.gone === null) pending.gone = Date.now();
  }, 50);

  phase("waiting for N to exit, the installer, N+1");
  await c.step("N exits", () => until("N to exit", 60_000, () => nExit !== null));
  const allGone = await c.step("N's processes end", () => until("N's processes to end", 120_000, async () => {
    const s = await watcher.next();
    return s.p.some(p => nPids.has(p.pid)) ? false : s.t;
  }));
  const isInstaller = (p: Proc) => /^Gates-Local-.*-Setup-x64\.exe$/i.test(p.name) && p.created >= clickAt - 1_000;
  const installer = await c.step("the installer runs", () => until("the installer", 30_000, () => watcher.samples.flatMap(s => s.p).find(isInstaller)));
  const installerEnd = await c.step("the installer ends", () => until("the installer to end", 240_000, async () => {
    const s = await watcher.next();
    return s.p.some(p => p.pid === installer.pid) ? false : s.t;
  }));
  const lastSeen = watcher.samples.filter(s => s.p.some(p => p.pid === installer.pid)).at(-1)?.t ?? null;
  const seen = watcher.samples.flatMap(s => s.p);
  const n1 = await c.step("N+1 starts from the install folder", () => until("N+1's process", 60_000, () => watcher.samples.flatMap(s => s.p).find(p => under(installDir, p.path) && p.name.toLowerCase() === "gates local.exe" && p.created >= clickAt && !nPids.has(p.pid))));
  const parent = seen.find(p => p.pid === n1.ppid);

  // N+1's window, if it carries this probe's port (the installer passed N's environment on).
  phase("connecting to N+1");
  let windowAt: number | null = null;
  let readyAt: number | null = null;
  try {
    n1Page = await connect(nextPort, browsers, 60_000);
    windowAt = Date.now();
  } catch (error) {
    notes.push(`N+1 opened no DevTools on the probe's port (${message(error)}): it did not get N's environment`);
  }
  clearInterval(pendingWatch);
  const n1PageNow = n1Page;
  report["n1"] = { pid: n1.pid, created: iso(n1.created), args: n1.cmd, parent: parent === undefined ? { pid: n1.ppid, seen: false } : { pid: parent.pid, name: parent.name, isInstaller: parent.pid === installer.pid }, devtools: n1PageNow !== null };
  report["killSeen"] = seen.filter(p => p.name.toLowerCase() === "taskkill.exe").map(p => p.cmd);
  c.that((report["killSeen"] as unknown[]).length === 0, "a taskkill ran during the update");
  report["nExitCode"] = nExit === null ? null : (nExit as { code: number | null }).code;
  c.that(report["nExitCode"] === 0, `N exited with ${String(report["nExitCode"])}, not 0`);
  report["installer"] = { pid: installer.pid, name: installer.name, cmd: installer.cmd, parentIsN: nPids.has(installer.ppid), started: iso(installer.created), lastSeen: iso(lastSeen), goneBy: iso(installerEnd) };
  c.that(installer.cmd !== null && installer.cmd.includes("/S") && installer.cmd.includes("--updated"), "the installer did not run silent as an update");
  c.that(under(updates, installer.path), `the installer ran from ${String(installer.path)}, not the checked download in updates\\`);
  report["pending"] = { firstSeen: iso(pending.firstSeen), at: pending.note?.["at"] ?? null, to: pending.note?.["to"] ?? null, goneBy: iso(pending.gone), beforeInstaller: typeof pending.note?.["at"] === "number" && (pending.note["at"] as number) <= installer.created };
  c.that(typeof pending.note?.["at"] === "number" && (pending.note["at"] as number) <= installer.created, "the pending note was not written before the installer started");

  const nExitAt = nExit === null ? null : (nExit as { at: number }).at;
  if (round === "IU-W2") {
    // N+1's server exits at start: nothing goes back by itself; the status page names N's kept installer.
    const keptN = path.join(updates, olderVersion, artifactFor("win32", olderVersion).file);
    phase("reading the status page");
    let pageText = "";
    if (n1PageNow !== null) {
      // Kept whether or not the line comes: what the page said is the evidence either way.
      await until("To go back on the status page", 120_000, async () => {
        pageText = await n1PageNow.evaluate(() => (globalThis as unknown as { document: { body: { innerText: string } } }).document.body.innerText).catch(() => pageText);
        return pageText.includes("To go back, run");
      }, 500).catch(() => undefined);
      await n1PageNow.screenshot({ path: path.join(output, `${round}-after.png`) });
    }
    report["statusPage"] = pageText;
    c.that(pageText.includes(`To go back, run ${keptN}.`), `the status page does not say "To go back, run ${keptN}."`);
    c.that(productVersion(appExe).startsWith(newerVersion), "the installed app is not N+1 after the update (it went back by itself)");
    report["times"] = { clickToExit: secs(clickAt, nExitAt), clickToProcessesEnded: secs(clickAt, allGone), installerStartAfterClick: secs(clickAt, installer.created), exitToInstallerEnd: secs(nExitAt, installerEnd), clickToWindow: secs(clickAt, windowAt) };
    await closeApp(n1PageNow, watcher, installDir, notes);
    n1Page = null;
    // The person runs it: N is back, with the data kept.
    phase("going back with the kept installer");
    const t = Date.now();
    const back = spawnSync(keptN, ["/S", "--no-desktop-shortcut"], { windowsHide: true, timeout: 240_000 });
    report["goBack"] = { installer: keptN, exitCode: back.status, seconds: secs(t, Date.now()), version: productVersion(appExe) };
    c.that(back.status === 0, `the kept installer ended ${String(back.status)}`);
    const backPort = await freePort();
    // N again, on this probe's feed and key as before: it never asks the real feed.
    const again = spawn(appExe, [`--remote-debugging-port=${backPort}`], { env: { ...base, ...SAFE, GATES_LOCAL_UPDATE_FEED: feed.url, GATES_LOCAL_UPDATE_TEST_KEYS: publicKeyBase64(key.publicKey) }, stdio: "ignore", windowsHide: false });
    started = { child: again, page: null };
    phase("starting N after going back");
    const backPage = await c.step("N's window after going back", () => connect(backPort, browsers, 90_000));
    started.page = backPage;
    await c.step("N's server after going back", () => until("the server", 90_000, () => serverUrl(backPage)));
    const ua = await backPage.evaluate(() => (globalThis as unknown as { navigator: { userAgent: string } }).navigator.userAgent);
    const threads = (await rpc(backPage, "threads.list", {})).map(x => x.title);
    const settings = await rpc(backPage, "settings.get", {});
    await expect(backPage.getByRole("button", { name: "Retry", exact: true })).toBeVisible({ timeout: 60_000 });
    await pause(5_000);
    const note = await backPage.locator(".upd-note").first().locator(".bm").first().innerText({ timeout: 1_000 }).catch(() => null);
    const backStatus = await rpc(backPage, "update.status", {});
    await backPage.screenshot({ path: path.join(output, `${round}-back.png`) });
    report["afterGoingBack"] = { version: productVersion(appExe), userAgent: ua, dataFolder: await dataFolder(backPage), threads, theme: settings.theme, note, result: backStatus.result, serverVersion: backStatus.version };
    c.that(productVersion(appExe).startsWith(olderVersion), "the kept installer did not put N back");
    c.that(threads.includes(THREAD) && settings.theme === "light", "the thread or the setting is gone after going back");
    c.that(note === null || !note.includes(newerVersion), `after going back to ${olderVersion}, the note says: ${String(note)}`);
    c.that(backStatus.result === null || !backStatus.result.line.includes(newerVersion), `after going back to ${olderVersion}, the update result says: ${JSON.stringify(backStatus.result)}`);
    phase("closing N");
    await closeApp(backPage, watcher, installDir, notes);
    started = null;
  } else {
    if (n1PageNow !== null) {
      phase("checking N+1");
      readyAt = await c.step("N+1's server is ready", () => until("N+1's server", 90_000, () => serverUrl(n1PageNow).then(u => (u ? Date.now() : false))));
      const n1Folder = await dataFolder(n1PageNow);
      c.that(n1Folder.toLowerCase() === folder.toLowerCase(), `N+1's data folder is ${n1Folder}, not N's ${folder}`);
      const threads = (await rpc(n1PageNow, "threads.list", {})).map(x => x.title);
      const settings = await rpc(n1PageNow, "settings.get", {});
      c.that(threads.includes(THREAD), "the thread made under N is gone under N+1");
      c.that(settings.theme === "light", "the setting made under N is gone under N+1");
      // The note becomes the update result, said once at this start. A successful update shows no banner
      // (2026-11-12: successful updates stay silent; the version in Settings says it).
      const status = await rpc(n1PageNow, "update.status", {});
      c.that(status.result?.outcome === "updated" && status.result.line.includes(`Updated to version ${newerVersion}.`), `N+1's update result is ${JSON.stringify(status.result)}, not "Updated to version ${newerVersion}."`);
      c.that(status.version.kind === "installed" && status.version.version === newerVersion, `N+1's server says it is ${JSON.stringify(status.version)}`);
      await expect(n1PageNow.getByRole("button", { name: "Retry", exact: true })).toBeVisible({ timeout: 60_000 });
      const banner = await n1PageNow.locator(".upd-note").count();
      c.that(banner === 0, "a successful update left a banner");
      const after = await c.step("Settings › Updates in N+1", () => openUpdates(n1PageNow, notes));
      await expect(after).toContainText(newerVersion, { timeout: 15_000 });
      const afterBox = await after.locator(".box").innerText();
      await shoot(n1PageNow, after, output, `${round}-after`);
      await n1PageNow.screenshot({ path: path.join(output, `${round}-after.png`) });
      report["after"] = { dataFolder: n1Folder, threads, theme: settings.theme, result: status.result, version: status.version, banner, updates: afterBox, ua: await n1PageNow.evaluate(() => (globalThis as unknown as { navigator: { userAgent: string } }).navigator.userAgent) };
    } else {
      // Without DevTools, what the files say.
      report["after"] = { threads: threadTitles(dataDir) };
    }
    c.that(!existsSync(pendingPath), "the pending note is still there after N+1 started");
    c.that(productVersion(appExe).startsWith(newerVersion), "the installed app is not N+1");
    const kept = path.join(updates, newerVersion, artifactFor("win32", newerVersion).file);
    report["kept"] = { file: kept, there: existsSync(kept), updates: existsSync(updates) ? readdirSync(updates).filter(x => statSync(path.join(updates, x)).isDirectory()) : [] };
    c.that(existsSync(kept), `N+1's installer is not kept at ${kept}`);
    report["times"] = { clickToExit: secs(clickAt, nExitAt), clickToProcessesEnded: secs(clickAt, allGone), installerStartAfterClick: secs(clickAt, installer.created), exitToInstallerEnd: secs(nExitAt, installerEnd), clickToWindow: secs(clickAt, windowAt), clickToReady: secs(clickAt, readyAt), installerRun: secs(installer.created, installerEnd) };
    if (round === "IU-W3" && copy !== null) {
      const live = copy.child.exitCode === null && (watcher.last()?.p ?? []).some(p => p.pid === copy?.child.pid);
      const copyPage = copy.page;
      const answers = copyPage === null ? null : await serverUrl(copyPage);
      report["copyAfter"] = { running: live, serverAnswers: answers !== null };
      c.that(live && answers !== null, "the copy in gates-local-old is not running after the update");
    }
    phase("closing N+1");
    await closeApp(n1PageNow, watcher, installDir, notes);
    n1Page = null;
  }
  phase("done");
  report["shots"] = [...before, ...readdirSync(output).filter(f => f.startsWith(round) && f.endsWith(".png")).map(f => path.join(output, f))];
} catch (error) {
  failed = error;
  c.problems.push(message(error));
} finally {
  phase("cleaning up");
  // N, if the round stopped before the click (or after going back): its window, then the process this round started.
  if (started !== null && started.child.exitCode === null) {
    if (!(await closeApp(started.page, watcher, installDir, notes).catch(() => false)) && started.child.exitCode === null) started.child.kill();
  }
  if (n1Page !== null) await closeApp(n1Page, watcher, installDir, notes).catch(() => undefined);
  if (copy !== null) await closeApp(copy.page, watcher, oldDir, notes).catch(() => undefined);
  for (const b of browsers) await b.close().catch(() => undefined);
  await within(5_000, "the feed", feed.stop()).catch(() => notes.push("the loopback feed did not close in 5 s"));
  report["feedRequests"] = feed.requests;
  watcher.stop();
  report["passed"] = c.problems.length === 0;
  report["problems"] = c.problems;
  report["stepFailures"] = c.full;
  report["notes"] = notes;
  report["ended"] = new Date().toISOString();
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${round} ${c.problems.length === 0 ? "passed" : "FAILED"}${c.problems.length === 0 ? "" : `: ${c.problems.join("; ")}`}`);
  if (failed !== null && !(failed instanceof Error)) console.error(failed);
}
process.exit(c.problems.length === 0 ? 0 : 1);
