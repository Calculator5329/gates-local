// Packaged probe: an installed copy shows its version and checks a signed
// release list. Run only on the test machine, with a display:
//
//   node apps/desktop/scripts/packaged-installed-check.ts <test-build AppImage> <plain AppImage> [output]
//
// Both AppImages are the same version N. The first was packaged with
// GATES_LOCAL_TEST_BUILD=1, so it reads GATES_LOCAL_UPDATE_TEST_KEYS and
// accepts the loopback feed served here; the second was not, so it must
// ignore both, say it has no release key and make no request.
// The test build runs twice: once with automatic checks off in its settings
// file before launch, so only the clicks read the feed through each answer;
// once with them on, a steady feed and no click, for the start-up check.
// The test key exists only in this process. The work folder (profile, data,
// fake git) is removed at the end; screenshots and report.json go to output.
import { _electron, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { defaultSettings, SETTINGS_FILE_NAME, SETTINGS_FILE_VERSION } from "../../server/src/settings/store.ts";
import { encodeManifest, signManifest } from "../../server/src/update/release-manifest.ts";
import type { GatesLocalBridge } from "../src/bridge.ts";

const [marked, plain] = process.argv.slice(2);
if (!marked || !plain) throw new Error("Pass the test-build AppImage and the plain AppImage.");
const output = path.resolve(process.argv[4] ?? "dist/installed-check");
mkdirSync(output, { recursive: true });
const cache = path.join(homedir(), ".cache", "gates-local-installed-check");
mkdirSync(cache, { recursive: true });
const work = mkdtempSync(path.join(cache, "run-"));
// Ports the runtime and ComfyUI own on a real machine; the feed never uses them.
const FORBIDDEN_PORTS = new Set([8188, ...Array.from({ length: 11 }, (_, i) => 11434 + i)]);

const testKey = generateKeyPairSync("ed25519");
const otherKey = generateKeyPairSync("ed25519");
const publicBase64 = (key: KeyObject) => key.export({ type: "spki", format: "der" }).toString("base64");

/** A fake git first on PATH: any call is recorded, so "started no git" is checked, not assumed. */
const bin = path.join(work, "bin");
const gitCalls = path.join(work, "git-calls.log");
mkdirSync(bin);
writeFileSync(path.join(bin, "git"), `#!/bin/sh\necho "$@" >> '${gitCalls}'\nexit 1\n`);
chmodSync(path.join(bin, "git"), 0o755);

const baseEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && !key.startsWith("GATES_LOCAL_") && !key.startsWith("APPIMAGE") && key !== "ELECTRON_RUN_AS_NODE") baseEnv[key] = value;
}

type Served = { readonly list: Buffer; readonly sig: Buffer } | "missing";
interface Feed {
  readonly url: string;
  readonly requests: { method: string; url: string; userAgent: string | undefined; cookie: string | undefined; at: number }[];
  serve(next: Served): void;
  stop(): Promise<void>;
}

async function startFeed(): Promise<Feed> {
  let served: Served = "missing";
  const requests: Feed["requests"] = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "", userAgent: req.headers["user-agent"], cookie: req.headers.cookie, at: Date.now() });
    // A cookie on every answer: the copy must never send one back.
    res.setHeader("Set-Cookie", "probe=1; Path=/");
    const file = req.url === "/latest/download/release.json" ? "list" : req.url === "/latest/download/release.json.sig" ? "sig" : null;
    if (file === null || served === "missing") {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(served[file]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === "string") throw new Error("The loopback feed has no port.");
  const { port } = address;
  if (FORBIDDEN_PORTS.has(port)) throw new Error(`The loopback feed got a reserved port ${port}; run again.`);
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    serve: (next) => { served = next; },
    stop: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function signedList(version: string, platforms: readonly ("linux" | "win32")[], key: KeyObject): Served {
  const artifacts = platforms.map((platform) => platform === "linux"
    ? { platform, arch: "x64", kind: "appimage", file: `Gates-Local-${version}-x86_64.AppImage`, size: 1, sha512: "0".repeat(128) }
    : { platform, arch: "x64", kind: "nsis", file: `Gates-Local-${version}-Setup-x64.exe`, size: 1, sha512: "0".repeat(128) });
  const list = encodeManifest({ schema: 1, version, commit: "a".repeat(40), artifacts });
  return { list, sig: signManifest(list, key) };
}

interface Copy {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly group: Locator;
  readonly dataFolder: string;
}

/** Before launch: a settings file in the copy's own data folder, in the
 *  server store's own format, as if the person had turned the switch. */
function seedAutomatic(home: string, on: boolean): string {
  const dataFolder = path.join(home, "data", "gates-local-installed");
  mkdirSync(dataFolder, { recursive: true });
  writeFileSync(path.join(dataFolder, SETTINGS_FILE_NAME), `${JSON.stringify({ version: SETTINGS_FILE_VERSION, settings: { ...defaultSettings("app"), updateAutomatic: on } }, null, 2)}\n`);
  return dataFolder;
}

async function open(artifact: string, name: string, feed: Feed, automatic?: boolean): Promise<Copy> {
  const home = path.join(work, name);
  const installed = path.join(home, "Gates-Local.AppImage");
  mkdirSync(home);
  const seeded = automatic === undefined ? null : seedAutomatic(home, automatic);
  writeFileSync(installed, readFileSync(artifact));
  chmodSync(installed, 0o755);
  const app = await _electron.launch({
    executablePath: installed,
    args: ["--no-sandbox", "--disable-gpu"],
    env: {
      ...baseEnv, APPIMAGE_EXTRACT_AND_RUN: "1", TMPDIR: home,
      PATH: `${bin}:${baseEnv["PATH"] ?? "/usr/bin:/bin"}`,
      XDG_DATA_HOME: path.join(home, "data"), XDG_CONFIG_HOME: path.join(home, "config"),
      GATES_LOCAL_RUNTIME: "discover-only", GATES_LOCAL_OLLAMA_BINARY: "none",
      GATES_LOCAL_OLLAMA_URL: "http://127.0.0.1:19750",
      GATES_LOCAL_UPDATE_FEED: feed.url,
      GATES_LOCAL_UPDATE_TEST_KEYS: publicBase64(testKey.publicKey),
    },
    timeout: 30_000,
  });
  expect(await app.evaluate(({ app: electron }) => electron.isPackaged)).toBe(true);
  const page = await app.firstWindow();
  // No Ollama here: the first-run screen offers Retry and a Settings link.
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.locator(".fr-cta").getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".snav").getByRole("button", { name: "General", exact: true }).click();
  const group = page.locator(".grp").filter({ has: page.locator(".grp-t", { hasText: /^Updates$/ }) });
  await expect(group).toBeVisible({ timeout: 10_000 });
  const dataFolder = await page.evaluate(() => (globalThis as unknown as { gatesLocal: GatesLocalBridge }).gatesLocal.dataFolder());
  // A seed in the wrong folder would prove nothing: the app must be reading it.
  if (seeded !== null) expect(dataFolder).toBe(seeded);
  return { app, page, group, dataFolder };
}

const AGAIN = "Gates Local will try again in an hour.";
const automaticSwitch = (copy: Copy) => copy.group.getByRole("switch", { name: "Check for updates automatically" });

const shots: string[] = [];
async function shoot(copy: Copy, name: string): Promise<void> {
  const file = path.join(output, `${name}.png`);
  await copy.group.screenshot({ path: file });
  shots.push(file);
}

/** Press "Check for updates" and wait for these words in the Updates group. */
async function check(copy: Copy, ...words: string[]): Promise<void> {
  await copy.group.getByRole("button", { name: "Check for updates", exact: true }).click();
  for (const line of words) await expect(copy.group).toContainText(line, { timeout: 15_000 });
}

const report: Record<string, unknown> = {};
let current: Copy | undefined;
try {
  // ---- The test-build copy against a loopback feed it trusts, with automatic
  // checks switched off before launch: only the clicks below read the feed.
  const feed = await startFeed();
  const launched = Date.now();
  const copy = await open(marked, "test-build", feed, false);
  current = copy;
  const version = await copy.app.evaluate(({ app }) => app.getVersion());
  const [major, minor, patch] = version.split(".").map(Number);
  if (major === undefined || minor === undefined || patch === undefined || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Build a release-shaped version, got ${version}`);
  const next = `${major}.${minor}.${patch + 1}`;
  report["version"] = version;

  await expect(copy.group).toContainText(`Installed copy ${version}`, { timeout: 10_000 });
  await expect(copy.group).toContainText("Updates come from the Gates Local release page.");
  await expect(automaticSwitch(copy)).toHaveAttribute("aria-checked", "false");
  await shoot(copy, "version-row");
  // Past the 15-second start-up delay with the switch off: nothing was read.
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, launched + 25_000 - Date.now())));
  expect(feed.requests).toEqual([]);

  const releasePage = copy.group.getByRole("link", { name: "Open the release page" });
  feed.serve(signedList(next, ["linux", "win32"], testKey.privateKey));
  await check(copy, `Version ${next} is available. Download it from the release page.`);
  await expect(releasePage).toHaveAttribute("href", `${feed.url}/latest`);
  // Nothing installs from here yet: no install button, no sidebar update button.
  await expect(copy.page.getByRole("button", { name: "Update and restart" })).toHaveCount(0);
  await expect(copy.page.locator(".sb-update")).toHaveCount(0);
  await shoot(copy, "available");

  feed.serve(signedList(next, ["win32"], testKey.privateKey));
  await check(copy, `Version ${next} is available, but this copy cannot install it by itself. Download it from the release page.`);
  await expect(releasePage).toBeVisible();
  await shoot(copy, "not-for-this-copy");

  feed.serve(signedList(next, ["linux"], otherKey.privateKey));
  await check(copy, "The release list did not pass its signature check, so Gates Local ignored it. Nothing was downloaded. If this keeps happening, download the latest version from the release page.");
  await expect(releasePage).toBeVisible();
  await shoot(copy, "bad-signature");

  // With the switch off, a failed read promises no retry.
  feed.serve("missing");
  await check(copy, "No release list was found on the release page.");
  await expect(copy.group).not.toContainText(AGAIN);
  await shoot(copy, "no-list");

  feed.serve(signedList(version, ["linux"], testKey.privateKey));
  await check(copy, "No newer version was found.");
  await shoot(copy, "none-found");

  await feed.stop();
  await check(copy, "Could not reach the update server. Check your connection.");
  await expect(copy.group).not.toContainText(AGAIN);
  await shoot(copy, "could-not-reach");
  const clicked = feed.requests.length;

  // Turning the switch on makes the sentence true, on the result already shown.
  await automaticSwitch(copy).click();
  await expect(automaticSwitch(copy)).toHaveAttribute("aria-checked", "true");
  await expect(copy.group).toContainText(AGAIN);
  await shoot(copy, "could-not-reach-automatic-on");

  expect(clicked).toBeGreaterThan(0);
  for (const request of feed.requests) {
    expect(request.method).toBe("GET");
    expect(request.url).not.toContain("?");
    expect(request.userAgent).toBe("Gates-Local");
    expect(request.cookie).toBeUndefined();
  }
  expect(existsSync(path.join(copy.dataFolder, "updates"))).toBe(false);
  report["testBuild"] = { automatic: false, requestsBeforeFirstClick: 0, requests: clicked, updatesFolder: false };
  await copy.app.close();
  current = undefined;

  // ---- Automatic checks on, a stable feed and no click: the start-up check
  // reads the list after its delay and Settings shows the result by itself.
  const steady = await startFeed();
  steady.serve(signedList(next, ["linux"], testKey.privateKey));
  const autoLaunched = Date.now();
  const auto = await open(marked, "automatic", steady, true);
  current = auto;
  await expect(automaticSwitch(auto)).toHaveAttribute("aria-checked", "true");
  await expect(auto.group).toContainText(`Version ${next} is available. Download it from the release page.`, { timeout: 45_000 });
  await expect(auto.group.getByRole("link", { name: "Open the release page" })).toBeVisible();
  await shoot(auto, "automatic");
  const first = steady.requests[0];
  if (first === undefined) throw new Error("Settings showed a result the feed never served.");
  expect(steady.requests.map((r) => r.url).slice(0, 2)).toEqual(["/latest/download/release.json", "/latest/download/release.json.sig"]);
  // The start-up delay is 15 seconds from the server's start, which is after launch.
  expect(first.at - autoLaunched).toBeGreaterThanOrEqual(15_000);
  for (const request of steady.requests) {
    expect(request.method).toBe("GET");
    expect(request.url).not.toContain("?");
    expect(request.userAgent).toBe("Gates-Local");
    expect(request.cookie).toBeUndefined();
  }
  expect(existsSync(path.join(auto.dataFolder, "updates"))).toBe(false);
  report["automatic"] = { firstRequestAfterLaunchMs: first.at - autoLaunched, requests: steady.requests.length, clicks: 0, updatesFolder: false };
  await auto.app.close();
  current = undefined;
  await steady.stop();

  // ---- A plain copy: the same keys and feed in its environment are ignored.
  const quiet = await startFeed();
  quiet.serve(signedList(next, ["linux"], testKey.privateKey));
  const plainCopy = await open(plain, "plain", quiet);
  current = plainCopy;
  await expect(plainCopy.group).toContainText(`Installed copy ${version}`, { timeout: 10_000 });
  await check(plainCopy, "This build has no release key, so it cannot check for updates. Download the latest version from the release page.");
  await expect(plainCopy.group.getByRole("link", { name: "Open the release page" })).toBeVisible();
  await shoot(plainCopy, "no-key");
  expect(quiet.requests).toEqual([]);
  expect(existsSync(path.join(plainCopy.dataFolder, "updates"))).toBe(false);
  report["plain"] = { requests: 0, updatesFolder: false };
  await plainCopy.app.close();
  current = undefined;
  await quiet.stop();

  expect(existsSync(gitCalls) ? readFileSync(gitCalls, "utf8") : "").toBe("");
  report["gitCalls"] = 0;
  report["screenshots"] = shots.map((file) => path.relative(output, file));
  writeFileSync(path.join(output, "report.json"), JSON.stringify({ passed: true, ...report }, null, 2) + "\n");
  console.log(`Installed-copy probe passed: version ${version}, ${shots.length} screenshots in ${output}.`);
} catch (error) {
  let updates = "";
  try { if (current) { updates = await current.group.innerText({ timeout: 2_000 }); await current.group.screenshot({ path: path.join(output, "failure.png") }); } }
  catch { updates = "(the Updates group could not be read)"; }
  writeFileSync(path.join(output, "report.json"), JSON.stringify({ passed: false, error: String(error), updates, ...report }, null, 2) + "\n");
  console.error(`Updates group at failure:\n${updates}`);
  throw error;
} finally {
  await current?.app.close().catch(() => undefined);
  rmSync(work, { recursive: true, force: true });
}
