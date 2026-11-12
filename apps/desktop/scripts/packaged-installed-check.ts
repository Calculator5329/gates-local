// Packaged probe: an installed copy shows its version and checks a signed
// release list. Run only on the test machine, with a display:
//
//   node apps/desktop/scripts/packaged-installed-check.ts <test build> <plain build> [output]
//
// Linux takes two AppImages; Windows takes the installed Gates Local.exe
// (packaged-copy.ts). Both builds are the same version N. The first was
// packaged with GATES_LOCAL_TEST_BUILD=1, so it reads
// GATES_LOCAL_UPDATE_TEST_KEYS and accepts the loopback feed served here; the
// second was not, so it must ignore both: no request reaches the feed. What
// the real page answers is recorded, not required. Either argument may be "-" to skip that part: one Windows
// install location holds one build at a time.
// The test build runs twice: once with automatic checks off in its settings
// file before launch, so only the clicks read the feed through each answer;
// once with them on, a steady feed and no click, for the start-up check.
// The test key exists only in this process. The work folder (profile, data,
// fake git) is removed at the end; screenshots and report.json go to output.
import { expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { defaultSettings, SETTINGS_FILE_NAME, SETTINGS_FILE_VERSION } from "../../server/src/settings/store.ts";
import { encodeManifest, signManifest } from "../../server/src/update/release-manifest.ts";
import type { GatesLocalBridge } from "../src/bridge.ts";
import { artifactFor, cleanEnv, dataFolderIn, launchCopy, otherPlatform, ownPlatform, watchGit, workFolder } from "./packaged-copy.ts";

const [marked, plain] = process.argv.slice(2);
if (!marked || !plain || (marked === "-" && plain === "-")) throw new Error("Pass the test build and the plain build (\"-\" skips one).");
const output = path.resolve(process.argv[4] ?? "dist/installed-check");
mkdirSync(output, { recursive: true });
const work = workFolder("gates-local-installed-check");
// Ports the runtime and ComfyUI own on a real machine; the feed never uses them.
const FORBIDDEN_PORTS = new Set([8188, ...Array.from({ length: 11 }, (_, i) => 11434 + i)]);

const testKey = generateKeyPairSync("ed25519");
const otherKey = generateKeyPairSync("ed25519");
const publicBase64 = (key: KeyObject) => key.export({ type: "spki", format: "der" }).toString("base64");

const baseEnv = cleanEnv();
/** "Started no git" is checked, not assumed: a fake git records calls, or (Windows) none is on PATH. */
const git = watchGit(work, baseEnv);

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
  const artifacts = platforms.map((platform) => ({ ...artifactFor(platform, version), size: 1, sha512: "0".repeat(128) }));
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
  const dataFolder = dataFolderIn(home);
  mkdirSync(dataFolder, { recursive: true });
  writeFileSync(path.join(dataFolder, SETTINGS_FILE_NAME), `${JSON.stringify({ version: SETTINGS_FILE_VERSION, settings: { ...defaultSettings("app"), updateAutomatic: on } }, null, 2)}\n`);
  return dataFolder;
}

async function open(artifact: string, name: string, feed: Feed, automatic: boolean): Promise<Copy> {
  const home = path.join(work, name);
  mkdirSync(home);
  const seeded = seedAutomatic(home, automatic);
  const app = await launchCopy(artifact, home, baseEnv, git, {
    GATES_LOCAL_RUNTIME: "discover-only", GATES_LOCAL_OLLAMA_BINARY: "none",
    GATES_LOCAL_OLLAMA_URL: "http://127.0.0.1:19750",
    GATES_LOCAL_UPDATE_FEED: feed.url,
    GATES_LOCAL_UPDATE_TEST_KEYS: publicBase64(testKey.publicKey),
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
  expect(dataFolder).toBe(seeded);
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

function nextAfter(version: string): string {
  const [major, minor, patch] = version.split(".").map(Number);
  if (major === undefined || minor === undefined || patch === undefined || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Build a release-shaped version, got ${version}`);
  return `${major}.${minor}.${patch + 1}`;
}

const report: Record<string, unknown> = { platform: ownPlatform };
let current: Copy | undefined;
try {
  if (marked !== "-") {
  // ---- The test-build copy against a loopback feed it trusts, with automatic
  // checks switched off before launch: only the clicks below read the feed.
  const feed = await startFeed();
  const launched = Date.now();
  const copy = await open(marked, "test-build", feed, false);
  current = copy;
  const version = await copy.app.evaluate(({ app }) => app.getVersion());
  const next = nextAfter(version);
  report["version"] = version;

  await expect(copy.group).toContainText(`Installed copy ${version}`, { timeout: 10_000 });
  await expect(copy.group).toContainText("Updates come from the Gates Local release page.");
  await expect(automaticSwitch(copy)).toHaveAttribute("aria-checked", "false");
  await shoot(copy, "version-row");
  // Past the 15-second start-up delay with the switch off: nothing was read.
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, launched + 25_000 - Date.now())));
  expect(feed.requests).toEqual([]);

  const releasePage = copy.group.getByRole("link", { name: "Open the release page" });
  const download = copy.group.getByRole("button", { name: "Download", exact: true });
  feed.serve(signedList(next, [ownPlatform, otherPlatform], testKey.privateKey));
  // A version for this copy, switch off: the Download offer (never clicked
  // here; packaged-installed-download.ts covers it) and no release-page link.
  await check(copy, `Version ${next} is available.`);
  await expect(download).toBeVisible();
  await expect(releasePage).toHaveCount(0);
  // Nothing installs from here yet: no install button, no sidebar update button.
  await expect(copy.page.getByRole("button", { name: "Update and restart" })).toHaveCount(0);
  await expect(copy.page.locator(".sb-update")).toHaveCount(0);
  await shoot(copy, "available");

  feed.serve(signedList(next, [otherPlatform], testKey.privateKey));
  await check(copy, `Version ${next} is available, but this copy cannot install it by itself. Download it from the release page.`);
  await expect(releasePage).toHaveAttribute("href", `${feed.url}/latest`);
  await expect(download).toHaveCount(0);
  await shoot(copy, "not-for-this-copy");

  feed.serve(signedList(next, [ownPlatform], otherKey.privateKey));
  await check(copy, "The release list did not pass its signature check, so Gates Local ignored it. Nothing was downloaded. If this keeps happening, download the latest version from the release page.");
  await expect(releasePage).toBeVisible();
  await shoot(copy, "bad-signature");

  // With the switch off, a failed read promises no retry.
  feed.serve("missing");
  await check(copy, "No release list was found on the release page.");
  await expect(copy.group).not.toContainText(AGAIN);
  await shoot(copy, "no-list");

  feed.serve(signedList(version, [ownPlatform], testKey.privateKey));
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
  // The list names only the other platform, so nothing downloads (a version
  // for this copy would start its download: packaged-installed-download.ts).
  const steady = await startFeed();
  steady.serve(signedList(next, [otherPlatform], testKey.privateKey));
  const autoLaunched = Date.now();
  const auto = await open(marked, "automatic", steady, true);
  current = auto;
  await expect(automaticSwitch(auto)).toHaveAttribute("aria-checked", "true");
  await expect(auto.group).toContainText(`Version ${next} is available, but this copy cannot install it by itself. Download it from the release page.`, { timeout: 45_000 });
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

  }

  if (plain !== "-") {
    // ---- A plain copy: the test key and the loopback feed in its environment
    // are ignored. It asks the real release page instead; what that page
    // answers (nothing published, offline, a real release) is recorded, not
    // required. Required: the feed sees no request (so nothing the test key
    // signed can be shown), nothing lands under updates/, and the build
    // carries a release key of its own. Which version or link appears is the
    // real page's business: a check on it would turn red the day that page
    // lists the version this probe serves.
    const quiet = await startFeed();
    const plainCopy = await open(plain, "plain", quiet, false);
    current = plainCopy;
    const plainVersion = await plainCopy.app.evaluate(({ app }) => app.getVersion());
    const next = nextAfter(plainVersion);
    quiet.serve(signedList(next, [ownPlatform, otherPlatform], testKey.privateKey));
    await expect(plainCopy.group).toContainText(`Installed copy ${plainVersion}`, { timeout: 10_000 });
    await expect(automaticSwitch(plainCopy)).toHaveAttribute("aria-checked", "false");
    await plainCopy.group.getByRole("button", { name: "Check for updates", exact: true }).click();
    // Every answer ends with when it was checked or tried; the real page may be slow.
    await expect(plainCopy.group).toContainText(/(Checked|Tried) at /, { timeout: 45_000 });
    const shown = await plainCopy.group.innerText();
    await shoot(plainCopy, "plain");
    expect(quiet.requests).toEqual([]);
    expect(shown).not.toContain("This build has no release key");
    expect(existsSync(path.join(plainCopy.dataFolder, "updates"))).toBe(false);
    report["plain"] = { version: plainVersion, requests: 0, updatesFolder: false, shown };
    await plainCopy.app.close();
    current = undefined;
    await quiet.stop();
  }

  expect(git.calls()).toBe("");
  report["git"] = git.how === "recorded" ? { calls: 0 } : { onPath: false };
  report["screenshots"] = shots.map((file) => path.relative(output, file));
  writeFileSync(path.join(output, "report.json"), JSON.stringify({ passed: true, ...report }, null, 2) + "\n");
  console.log(`Installed-copy probe passed on ${ownPlatform}: ${shots.length} screenshots in ${output}.`);
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
