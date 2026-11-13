// Run only through the approved virtual-screen runner. Never targets a host clone.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";
import { createClient } from "@gates-local/contracts";
import { startFakeOllama } from "../fake-ollama/fake-ollama.ts";

assert.ok(process.env.DISPLAY, "A runner-owned virtual display is required");
const root = process.cwd();
const artifacts = path.join(root, "runtime-cache", "auto-update-proof");
if (existsSync(artifacts)) {
  const archive = path.join(root, "runtime-cache", "_archive");
  mkdirSync(archive, { recursive: true });
  renameSync(artifacts, path.join(archive, `auto-update-proof-${Date.now()}`));
}
mkdirSync(artifacts, { recursive: true });
const scratch = mkdtempSync(path.join(homedir(), ".cache", "gates-local-update-proof-"));
const seed = path.join(scratch, "seed");
const origin = path.join(scratch, "origin.git");
const clone = path.join(scratch, "clone");
const data = path.join(scratch, "data");
mkdirSync(data);
const run = promisify(execFile);
const results = { passed: 0, failed: 0, checks: [], timings: [], artifacts: [], isolated: true, localRemoteOnly: true };
const save = () => writeFileSync(path.join(artifacts, "result.json"), JSON.stringify(results, null, 2));
const within = (target) => target === scratch || target.startsWith(`${scratch}${path.sep}`);
// pnpm 11 writes JSON despite retaining the historical .yaml filename.
const modules = JSON.parse(readFileSync(path.join(root, "node_modules", ".modules.yaml"), "utf8"));
const store = typeof modules.storeDir === "string" ? modules.storeDir.replace(/[/\\]v\d+$/, "") : undefined;
assert.ok(store, "The runner's existing offline package store must be known");
const env = {
  ...process.env,
  GIT_ALLOW_PROTOCOL: "file", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
  GATES_LOCAL_UPDATE_TEST_ROOT: scratch,
  GATES_LOCAL_USER_DATA: path.join(scratch, "profile"), GATES_LOCAL_DATA_DIR: data,
  XDG_CONFIG_HOME: path.join(scratch, "config"), XDG_DATA_HOME: path.join(scratch, "xdg"),
  GATES_LOCAL_OLLAMA_BINARY: "none", GATES_LOCAL_RUNTIME: "discover-only",
  GATES_LOCAL_WEB_LISTEN: "", GATES_LOCAL_WEB_ORIGIN: "", GATES_LOCAL_WEB_USER: "", GATES_LOCAL_WEB_PEERS: "",
  ELECTRON_SKIP_BINARY_DOWNLOAD: "1", npm_config_offline: "true", npm_config_store_dir: store,
  npm_config_package_import_method: "copy",
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.GATES_LOCAL_SERVER_ENTRY;
delete env.GATES_LOCAL_WEB_URL;
delete env.GATES_LOCAL_WEB;
delete env.GATES_LOCAL_BACKGROUND;
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];

async function command(cwd, binary, args, name) {
  assert.ok(within(cwd), "Commands must stay in the throwaway fixture");
  try {
    const result = await run(binary, args, { cwd, env, timeout: 240_000, maxBuffer: 16 * 1024 * 1024 });
    if (name) writeFileSync(path.join(artifacts, `${name}.log`), result.stdout + result.stderr);
    return result.stdout.trim();
  } catch (error) {
    if (name) writeFileSync(path.join(artifacts, `${name}.log`), String(error.stdout) + String(error.stderr));
    throw error;
  }
}
const git = (cwd, ...args) => command(cwd, "git", args);
async function check(name, test) {
  try { await test(); results.passed++; results.checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { results.failed++; results.checks.push({ name, passed: false, error: error.message }); throw error; }
  finally { save(); }
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const pidFile = path.join(data, "desktop.pid.json");
const cdpFile = path.join(data, "proof-cdp.json");
function currentPid() {
  try { return JSON.parse(readFileSync(pidFile, "utf8")).pid; } catch { return null; }
}
let browser;
let page;
let fake;
let recorder;
let debugPort;
let executable;
let onboarded = false;
async function controlForWindow() {
  const url = await page.evaluate(() => window.gatesLocal.getServerUrl());
  assert.ok(url, "The real desktop bridge must expose its supervised server");
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  return createClient(socket);
}
async function connectWindow() {
  await expect.poll(async () => {
    try {
      const endpoint = JSON.parse(readFileSync(cdpFile, "utf8"));
      if (endpoint.pid !== currentPid()) return false;
      debugPort = endpoint.port;
      return (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok;
    } catch { return false; }
  }, { timeout: 60_000, intervals: [250, 500, 1000] }).toBe(true);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  page = browser.contexts()[0].pages()[0];
  if (!page) page = await browser.contexts()[0].waitForEvent("page");
  const start = page.getByRole("button", { name: "Start chatting", exact: true });
  const ready = page.locator(".main:not([inert]) .composer:not(.blocked)");
  if (!onboarded) {
    await expect(start).toBeVisible({ timeout: 60_000 });
    await start.click();
    onboarded = true;
  }
  await expect(page.locator(".first")).toHaveCount(0, { timeout: 60_000 });
  await expect(ready).toBeVisible({ timeout: 60_000 });
}
async function launch(manual = false) {
  const child = manual
    ? spawn("pnpm", ["start", "--no-sandbox", "--disable-gpu"], { cwd: clone, env, stdio: ["ignore", "pipe", "pipe"] })
    : spawn(executable, [path.join(clone, "apps/desktop"), "--no-sandbox", "--disable-gpu"], { cwd: clone, env, stdio: ["ignore", "pipe", "pipe"] });
  // pnpm forwards the test-only Chromium switches to the final Electron command.
  const log = path.join(artifacts, manual ? "manual-start.log" : "desktop.log");
  child.stdout.on("data", (chunk) => writeFileSync(log, chunk, { flag: "a" }));
  child.stderr.on("data", (chunk) => writeFileSync(log, chunk, { flag: "a" }));
  child.on("error", (error) => console.error(error.message));
  await connectWindow();
  return child;
}
async function closeApp() {
  const pid = currentPid();
  if (pid === null) return;
  // Electron handles SIGTERM through app.quit and its normal server drain.
  // CDP Browser.close does not reliably quit Electron's main process.
  assert.ok(within(readlinkSync(`/proc/${pid}/cwd`)));
  process.kill(pid, "SIGTERM");
  await expect.poll(currentPid, { timeout: 60_000, intervals: [250, 500, 1000] }).toBe(null);
  // The app owns this connection and has exited. Waiting for a CDP close
  // acknowledgement adds its timeout after Electron is already gone.
  browser = undefined;
}
async function shot(name) {
  await page.screenshot({ path: path.join(artifacts, `${name}.png`) });
  results.artifacts.push(`${name}.png`);
}
async function publish() {
  assert.equal(await git(seed, "remote", "get-url", "origin"), origin);
  await git(scratch, "--git-dir", origin, "fetch", "--quiet", seed, "refs/heads/main:refs/heads/main");
}
async function updatedWindow(name, expectedHead, outcome) {
  const oldPid = currentPid();
  let closedAt;
  const closing = page.waitForEvent("close", { timeout: 60_000 }).then(() => { closedAt = performance.now(); });
  void closing.catch(() => undefined); // A failed click must not leave an unhandled timeout during cleanup.
  const clickedAt = performance.now();
  await page.locator(".sb-update").click();
  await closing;
  await expect.poll(() => {
    if (currentPid() === null || currentPid() === oldPid || existsSync(path.join(clone, ".git", "gates-local-update.json"))) return false;
    return readFileSync(path.join(clone, ".git", "refs", "heads", "main"), "utf8").trim() === expectedHead;
  }, { timeout: 240_000, intervals: [250, 500, 1000] }).toBe(true);
  browser = undefined;
  await connectWindow();
  const readyAt = performance.now();
  assert.equal(await git(clone, "rev-parse", "HEAD"), expectedHead);
  await expect(page.getByText(outcome, { exact: false })).toBeVisible();
  results.timings.push({ name, clickToReadyMs: Math.round(readyAt - clickedAt), closedToReadyMs: Math.round(readyAt - closedAt) });
  await shot(name);
}

try {
  // The runner sends source without Git internals; seed a wholly new local history.
  const excluded = new Set([".git", "node_modules", "dist", "out", "runtime-cache", "_archive", ".local", ".ssh", ".gnupg"]);
  cpSync(root, seed, { recursive: true, filter: (source) => {
    const parts = path.relative(root, source).split(path.sep);
    return !parts.some((part) => excluded.has(part) || part === ".env" || part.startsWith(".env.")) && !lstatSync(source).isSymbolicLink();
  } });
  // Keep a test-only CDP endpoint available across the genuine detached
  // relaunch, independently of Chromium switches in main's argv. This fixture
  // entry loads the unchanged production main after setting the port.
  const desktopPackage = path.join(seed, "apps/desktop/package.json");
  const manifest = JSON.parse(readFileSync(desktopPackage, "utf8"));
  writeFileSync(desktopPackage, `${JSON.stringify({ ...manifest, main: "proof-main.cjs" }, null, 2)}\n`);
  writeFileSync(path.join(seed, "apps/desktop/proof-main.cjs"), `const fs = require("node:fs");
const { app } = require("electron");
const file = process.env.GATES_LOCAL_PROOF_CDP_FILE;
const ports = JSON.parse(process.env.GATES_LOCAL_PROOF_CDP_PORTS);
const next = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).next : 0;
const port = ports[next];
if (!Number.isInteger(port)) throw new Error("No fixture debugging port remains");
fs.writeFileSync(file, JSON.stringify({ next: next + 1, port, pid: process.pid, argv: process.argv }));
app.commandLine.appendSwitch("remote-debugging-port", String(port));
require("./out/main.cjs");
`);
  await git(seed, "init", "--quiet", "--initial-branch=main");
  await git(seed, "config", "user.name", "Update test");
  await git(seed, "config", "user.email", "update-test@example.invalid");
  await git(seed, "add", ".");
  await git(seed, "commit", "--quiet", "-m", "Source update fixture A");
  await git(scratch, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  await git(seed, "remote", "add", "origin", origin);
  await publish();
  await git(scratch, "clone", "--quiet", origin, clone);
  assert.equal(await git(clone, "remote", "get-url", "origin"), origin);
  await command(clone, "pnpm", ["install", "--offline", "--frozen-lockfile", "--store-dir", store, "--package-import-method=copy"], "initial-install");
  // Never download Electron. Verify the pre-provisioned archive and extract
  // into the independent fixture; this lane's dependency scripts may be skipped.
  const cloneRequire = createRequire(path.join(clone, "apps/desktop/package.json"));
  const cloneElectron = path.dirname(cloneRequire.resolve("electron/package.json"));
  assert.ok(within(cloneElectron));
  assert.equal(process.platform, "linux", "This runtime proof is Linux only");
  const version = cloneRequire("electron/package.json").version;
  const archiveName = `electron-v${version}-linux-${process.arch}.zip`;
  const cache = path.join(homedir(), ".cache", "electron");
  const archive = readdirSync(cache).map((entry) => path.join(cache, entry, archiveName)).find((entry) => existsSync(entry));
  assert.ok(archive, "The exact Electron archive must already be cached; downloads are forbidden");
  const checksums = JSON.parse(readFileSync(path.join(cloneElectron, "checksums.json"), "utf8"));
  assert.equal(createHash("sha256").update(readFileSync(archive)).digest("hex"), checksums[archiveName]);
  const electronRequire = createRequire(path.join(cloneElectron, "package.json"));
  await electronRequire("@electron-internal/extract-zip").extract(archive, { dir: path.join(cloneElectron, "dist") });
  writeFileSync(path.join(cloneElectron, "path.txt"), "electron");
  results.cachedElectronVersion = version;
  executable = cloneRequire("electron");
  assert.ok(within(executable));
  await command(clone, "pnpm", ["--filter", "@gates-local/web", "build"], "initial-build-web");
  await command(clone, "pnpm", ["--filter", "@gates-local/desktop", "build"], "initial-build-desktop");
  writeFileSync(path.join(data, "settings.json"), JSON.stringify({ version: 1, settings: { defaultNumCtx: 16384, thinking: true, theme: "dark", runtimeMode: "system", tools: true, imageGen: false, updateEveryChange: true } }));
  const gpuStateFile = path.join(scratch, "gpu-state.json");
  fake = await startFakeOllama({ port: 0, gpuStateFile });
  Object.assign(env, { GATES_LOCAL_OLLAMA_URL: fake.url, GATES_LOCAL_COMFY_URL: "http://127.0.0.1:1",GATES_LOCAL_NVIDIA_SMI: path.join(clone, "test/fake-ollama/nvidia-smi.ts"), GATES_LOCAL_FAKE_GPU_STATE: gpuStateFile, GATES_LOCAL_MEMINFO: path.join(clone, "test/fake-ollama/meminfo.txt") });
  const ports = new Set();
  while (ports.size < 12) ports.add(await freePort());
  env.GATES_LOCAL_PROOF_CDP_PORTS = JSON.stringify([...ports]);
  env.GATES_LOCAL_PROOF_CDP_FILE = cdpFile;
  writeFileSync(path.join(seed, "update-fixture.txt"), "A harmless newer commit\n");
  await git(seed, "add", "update-fixture.txt");
  await git(seed, "commit", "--quiet", "-m", "Source update fixture B");
  const good = await git(seed, "rev-parse", "HEAD");
  await publish();
  // Optional full-display recording includes the period with no application window.
  recorder = spawn("ffmpeg", ["-y", "-f", "x11grab", "-video_size", "1440x900", "-framerate", "5", "-i", process.env.DISPLAY, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path.join(artifacts, "update-journey.mp4")], { stdio: "ignore" });
  recorder.on("error", () => { recorder = undefined; });
  await launch();
  await check("button absent before automatic check", async () => { await expect(page.locator(".sb-update")).toHaveCount(0); await shot("before-check"); });
  await check("automatic check finds local commit and preserves geometry", async () => {
    const selectors = [".sb-head", ".sb-list", ".sb-set", ".hdr", "#ta"];
    const before = await Promise.all(selectors.map((selector) => page.locator(selector).boundingBox()));
    await expect(page.getByRole("button", { name: `Update ${good.slice(0, 7)}`, exact: true })).toBeVisible({ timeout: 60_000 });
    const after = await Promise.all(selectors.map((selector) => page.locator(selector).boundingBox()));
    assert.deepEqual(after, before);
    await shot("update-available");
  });
  await check("server reservation refuses work from every client and cancellation reopens admission", async () => {
    const control = await controlForWindow();
    try {
      const thread = await control.call("threads.create", {});
      const status = await control.call("update.status", {});
      assert.ok(status.approval);
      await page.keyboard.press("Control+Comma");
      await expect(page.locator(".set")).toBeVisible();
      const prepared = await control.call("update.prepare", { approval: status.approval });
      assert.equal(prepared.state, "ready");
      assert.equal(prepared.targetCommit, good);
      try {
        await expect(page.getByText("Gates Local is preparing an update. New replies", { exact: false })).toBeVisible();
        const imported = path.join(scratch, "admission-import.txt");
        writeFileSync(imported, "A local import fixture\n");
        const requests = await Promise.allSettled([
          control.call("chat.send", { threadId: thread.id, content: "Do not start", model: "qwen3.5:9b", numCtx: 16384 }),
          control.call("image.generate", { prompt: "Do not start" }),
          control.call("models.pull", { name: "never-download-test" }),
          control.call("sources.add", { kind: "file", path: imported, label: "Admission import" }),
        ]);
        assert.ok(requests.every((result) => result.status === "rejected" && result.reason.code === "update-installing"));
      } finally { await control.call("update.cancel", { reservation: prepared.reservation }); }
      assert.equal((await control.call("threads.get", { threadId: thread.id })).messages.length, 0);
      assert.equal((await control.call("update.status", {})).installing, false);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: `Update ${good.slice(0, 7)}`, exact: true })).toBeEnabled();
    } finally { control.close(); }
  });
  await check("real update installs, builds and reopens on B", async () => {
    await updatedWindow("updated", good, "Gates Local updated");
    const dir = path.join(data, "update-logs");
    const log = readFileSync(path.join(dir, readdirSync(dir).toSorted().at(-1)), "utf8");
    assert.match(log, /\$ pnpm install --frozen-lockfile/);
    assert.match(log, /\$ pnpm --filter @gates-local\/web build/);
    assert.match(log, /\$ pnpm --filter @gates-local\/desktop build/);
  });
  await check("a desktop connection that commits but does not quit cannot strand admission", async () => {
    await expect.poll(() => existsSync(path.join(clone, ".git", "gates-local-update.lock"))).toBe(false);
    const control = await controlForWindow();
    // A no-op local commit is published so there is an available offer again.
    writeFileSync(path.join(seed, "update-next-fixture.txt"), "A harmless second offer\n");
    await git(seed, "add", "update-next-fixture.txt");
    await git(seed, "commit", "--quiet", "-m", "A second available offer"); await publish();
    await control.call("update.check", {});
    const status = await control.call("update.status", {});
    const prepared = await control.call("update.prepare", { approval: status.approval });
    assert.equal(prepared.state, "ready");
    assert.equal((await control.call("update.commit", { reservation: prepared.reservation, targetCommit: prepared.targetCommit, release: "proof-release" })).accepted, true);
    control.close();
    const observer = await controlForWindow();
    try { await expect.poll(async () => (await observer.call("update.status", {})).installing, { timeout: 10_000 }).toBe(false); }
    finally { observer.close(); }
  });
  let interruptedThread;
  await check("shutdown retains unfinished reply text for reopening", async () => {
    fake.setScenario("slow-drip", { tokenDelayMs: 40, holdAfterTokens: 3 });
    const control = await controlForWindow();
    try {
      const thread = await control.call("threads.create", { title: "Interrupted reply proof" });
      interruptedThread = thread.id;
      const model = (await control.call("models.list", {})).find((entry) => entry.capabilities.includes("completion"));
      assert.ok(model);
      let sawText = false;
      const off = control.subscribe("chat.event", (event) => { if (event.threadId === thread.id && event.event.type === "delta") sawText = true; });
      await control.call("chat.send", { threadId: thread.id, content: "Keep a partial answer", model: model.name, numCtx: 16384 });
      await expect.poll(() => sawText, { timeout: 60_000 }).toBe(true);
      off();
    } finally { control.close(); }
  });
  await closeApp();
  const main = path.join(seed, "apps/web/src/main.tsx");
  const original = readFileSync(main, "utf8");
  writeFileSync(main, `${original}\nTHIS IS AN INTENTIONALLY INVALID BUILD FIXTURE\n`);
  await git(seed, "add", "apps/web/src/main.tsx");
  await git(seed, "commit", "--quiet", "-m", "Source update fixture C fails to build");
  await publish();
  await launch();
  await check("reopened partial is durably interrupted and visibly unfinished", async () => {
    const control = await controlForWindow();
    try {
      const messages = (await control.call("threads.get", { threadId: interruptedThread })).messages;
      assert.equal(messages.at(-1).interrupted, true);
      assert.ok(messages.at(-1).content.length > 0);
      await page.evaluate((threadId) => { location.hash = `thread=${threadId}`; }, interruptedThread);
      await expect(page.getByLabel("Interrupted reply", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Interrupted reply", { exact: true }).getByRole("img", { name: "Stopped. The model won't see this reply.", exact: true })).toBeVisible();
      await shot("interrupted-reopened");
    } finally { control.close(); }
  });
  await check("failed build rolls back and reopens on B with its log", async () => {
    const bad = await git(seed, "rev-parse", "--short", "HEAD");
    await expect(page.getByRole("button", { name: `Update ${bad}`, exact: true })).toBeVisible({ timeout: 60_000 });
    await updatedWindow("rolled-back", good, "The update did not finish");
    await expect(page.getByText(/stopped at building the app window/)).toBeVisible();
    const note = page.getByRole("alert").filter({ hasText: "The update did not finish" });
    assert.ok(await note.evaluate(element => element.scrollWidth <= element.clientWidth), "The real rollback note must wrap its stack and log path");
    await expect(page.getByText("The full log is in", { exact: false })).toBeVisible();
    assert.equal(await git(clone, "status", "--porcelain"), "");
  });
  await closeApp();
  writeFileSync(main, original);
  const serverMain = path.join(seed, "apps/server/src/main.ts");
  const originalServer = readFileSync(serverMain, "utf8");
  assert.ok(originalServer.includes("const { runtime, catalog } = services;"));
  writeFileSync(serverMain, originalServer.replace("const { runtime, catalog } = services;", 'throw new Error("Intentional server initialization failure fixture");\n  const { runtime, catalog } = services;'));
  await git(seed, "add", "apps/web/src/main.tsx", "apps/server/src/main.ts");
  await git(seed, "commit", "--quiet", "-m", "Source update fixture builds but fails server initialization");
  await publish();
  await launch();
  await check("a built version whose server crashes restores B and starts it once", async () => {
    const bad = await git(seed, "rev-parse", "--short", "HEAD");
    await expect(page.getByRole("button", { name: `Update ${bad}`, exact: true })).toBeVisible({ timeout: 60_000 });
    const attempts = JSON.parse(readFileSync(cdpFile, "utf8")).next;
    await updatedWindow("startup-rolled-back", good, "The update did not finish");
    await expect(page.getByText(/stopped at starting the new version/)).toBeVisible();
    assert.equal(JSON.parse(readFileSync(cdpFile, "utf8")).next - attempts, 2, "One failed new app and one restored previous app; no restart loop");
    const dir = path.join(data, "update-logs");
    const log = readFileSync(path.join(dir, readdirSync(dir).toSorted().at(-1)), "utf8");
    assert.match(log, /\$ pnpm --filter @gates-local\/desktop build/);
    assert.match(log, /stopped at starting the new version/);
    assert.equal(await git(clone, "status", "--porcelain"), "");
  });
  await closeApp();
  writeFileSync(serverMain, originalServer);
  await git(seed, "add", "apps/server/src/main.ts");
  await git(seed, "commit", "--quiet", "-m", "Source update fixture fixes server startup");
  await publish();
  await check("manual git pull, pnpm install and pnpm start still open the app", async () => {
    await git(clone, "pull", "--ff-only");
    await command(clone, "pnpm", ["install", "--offline", "--frozen-lockfile"], "manual-install");
    await launch(true);
    assert.equal(await git(clone, "rev-parse", "HEAD"), await git(seed, "rev-parse", "HEAD"));
    const control = await controlForWindow();
    try { assert.equal((await control.call("threads.get", { threadId: interruptedThread })).messages.at(-1).interrupted, true); }
    finally { control.close(); }
    await shot("manual-start");
    await closeApp();
  });
} catch (error) {
  results.error = error.message;
  // Retain the exact owned group state before cleanup. A refused stop must
  // distinguish a live writer from an unreaped zombie without guessing.
  try {
    const transactionFile = path.join(clone, ".git", "gates-local-update.json");
    const transaction = existsSync(transactionFile) ? JSON.parse(readFileSync(transactionFile, "utf8")) : null;
    const endpoint = existsSync(cdpFile) ? JSON.parse(readFileSync(cdpFile, "utf8")) : null;
    const groups = new Set([currentPid(), transaction?.running?.pid, endpoint?.pid].filter(Number.isInteger));
    const processes = [];
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (groups.has(Number(name)) || groups.has(Number(fields[2]))) processes.push({ pid: Number(name), state: fields[0], parent: Number(fields[1]), group: Number(fields[2]) });
      } catch { /* A process may end during the snapshot. */ }
    }
    writeFileSync(path.join(artifacts, "failure-state.json"), JSON.stringify({ transaction, endpoint, processes }, null, 2));
  } catch (diagnostic) { console.error(`Failure diagnostics: ${diagnostic.message}`); }
  save();
  console.error(error);
  process.exitCode = 1;
} finally {
  await closeApp().catch((error) => console.error(`test app cleanup: ${error.message}`));
  const pid = currentPid();
  if (pid !== null) {
    // A connection failure can precede browser creation. Only signal the app
    // whose own fresh profile record and live working directory match this fixture.
    try {
      assert.ok(within(readlinkSync(`/proc/${pid}/cwd`)));
      process.kill(pid, "SIGTERM");
      await expect.poll(currentPid, { timeout: 60_000, intervals: [500, 1000] }).toBe(null);
    } catch (error) { console.error(`test app cleanup: ${error.message}`); }
  }
  if (recorder && recorder.exitCode === null) { recorder.kill("SIGINT"); await new Promise((resolve) => recorder.once("exit", resolve)); }
  if (fake) await fake.close();
  const logs = path.join(data, "update-logs");
  if (existsSync(logs)) cpSync(logs, path.join(artifacts, "update-logs"), { recursive: true });
  if (existsSync(cdpFile)) cpSync(cdpFile, path.join(artifacts, "proof-cdp.json"));
  if (existsSync(path.join(artifacts, "update-journey.mp4"))) results.artifacts.push("update-journey.mp4");
  results.updateLogCount = existsSync(logs) ? readdirSync(logs).length : 0;
  save();
}
