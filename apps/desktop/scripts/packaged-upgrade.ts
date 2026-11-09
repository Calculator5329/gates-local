// Diagnostic Linux build-to-build upgrade probe.
// Run only on the test machine. No real Ollama/ComfyUI or model downloads.
import { _electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import { decodeResult, decodeServerMessage, encodeRequest, type MethodName, type Params, type ResultOf } from "@gates-local/contracts";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { openThreadStore } from "../../server/src/threads/store.ts";
import type { GatesLocalBridge } from "../src/bridge.ts";

const [before, after] = process.argv.slice(2);
if (!before || !after) throw new Error("Pass the older and newer AppImage paths.");
const output = path.resolve(process.argv[4] ?? "dist/packaged-upgrade");
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
  GATES_LOCAL_OLLAMA_URL: "http://127.0.0.1:19750",
});
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
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
