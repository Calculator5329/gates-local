// Packaged probe: an installed copy downloads a newer version for itself and
// checks it against the signed release list. Run only on the test machine,
// with a display:
//
//   node apps/desktop/scripts/packaged-installed-download.ts <test build> [output]
//
// Linux takes the AppImage, Windows the installed Gates Local.exe
// (packaged-copy.ts); the lists name this platform's artifact.
// The build is version N, packaged with GATES_LOCAL_TEST_BUILD=1 so it
// trusts the key and the loopback feed served here. One copy, launched with
// "Check for updates automatically" on in its settings file, then:
//   1. the start-up check finds N+1 and downloads it by itself (the read is
//      held part way so the progress words can be seen), ending "downloaded"
//      with release.json, its .sig and the artifact in updates/N+1/;
//   2. a list for N+2 whose artifact has a wrong hash at the right size ends
//      "did not match", folder gone;
//   3. a list for N+3 whose server keeps sending past the listed size is cut
//      off early, folder gone;
//   4. switch off: a list for N+4 brings no artifact request until Download;
//   5. switch on, a held download of N+5, switch off mid-way: no folder.
// Every request reaches the fixture server below and is counted there. The
// test key exists only in this process; the work folder is removed at the
// end; screenshots and report.json go to output.
import { expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { createHash, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { defaultSettings, SETTINGS_FILE_NAME, SETTINGS_FILE_VERSION } from "../../server/src/settings/store.ts";
import { encodeManifest, signManifest } from "../../server/src/update/release-manifest.ts";
import type { GatesLocalBridge } from "../src/bridge.ts";
import { artifactFor, cleanEnv, dataFolderIn, launchCopy, ownPlatform, watchGit, workFolder } from "./packaged-copy.ts";

const [testBuild] = process.argv.slice(2);
if (!testBuild) throw new Error("Pass the test build.");
const output = path.resolve(process.argv[3] ?? "dist/installed-download");
mkdirSync(output, { recursive: true });
const work = workFolder("gates-local-installed-download");
// Ports the runtime and ComfyUI own on a real machine; the feed never uses them.
const FORBIDDEN_PORTS = new Set([8188, ...Array.from({ length: 11 }, (_, i) => 11434 + i)]);

const testKey = generateKeyPairSync("ed25519");
const publicBase64 = (key: KeyObject) => key.export({ type: "spki", format: "der" }).toString("base64");
const sha512 = (bytes: Uint8Array) => createHash("sha512").update(bytes).digest("hex");

const baseEnv = cleanEnv();
/** "Started no git" is checked, not assumed: a fake git records calls, or (Windows) none is on PATH. */
const git = watchGit(work, baseEnv);

const SIZE = 3_000_000;
const HELD_FIRST = 1_000_000;
const OFFERED = 64 * 1024 * 1024;
const fileFor = (version: string) => artifactFor(ownPlatform, version).file;

/** How the server sends one version's artifact. */
type Plan =
  | { readonly mode: "whole"; readonly bytes: Buffer }
  // 1 MB, then 16 KB every half second until released, then the rest.
  | { readonly mode: "held"; readonly bytes: Buffer; readonly gate: Gate }
  // No length header and 64 MB of bytes on offer, for a list that says 3 MB.
  | { readonly mode: "endless" };

interface Gate { readonly opened: () => boolean; readonly open: () => void }
function gate(): Gate {
  let opened = false;
  return { opened: () => opened, open: () => { opened = true; } };
}

interface Request { readonly method: string; readonly url: string; readonly userAgent: string | undefined; readonly cookie: string | undefined; readonly at: number }
interface ArtifactRead { readonly version: string; written: number; finished: boolean; hungUp: boolean }

interface Feed {
  readonly url: string;
  readonly requests: Request[];
  readonly reads: ArtifactRead[];
  serve(version: string, list: { readonly list: Buffer; readonly sig: Buffer }, plan: Plan): void;
  stop(): Promise<void>;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Waits for the socket to take more, or for the copy to hang up. */
const drained = (res: http.ServerResponse) => new Promise<void>((resolve) => {
  const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
  res.on("drain", done);
  res.on("close", done);
});

async function send(res: http.ServerResponse, read: ArtifactRead, bytes: Buffer): Promise<void> {
  if (res.destroyed) return;
  read.written += bytes.length;
  if (!res.write(bytes)) await drained(res);
}

async function sendArtifact(res: http.ServerResponse, plan: Plan, read: ArtifactRead): Promise<void> {
  res.on("close", () => { if (!res.writableFinished) read.hungUp = true; });
  if (plan.mode === "endless") {
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    const chunk = randomBytes(64 * 1024);
    while (read.written < OFFERED && !res.destroyed) await send(res, read, chunk);
  } else {
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(plan.bytes.length) });
    if (plan.mode === "held") {
      await send(res, read, plan.bytes.subarray(0, HELD_FIRST));
      while (!plan.gate.opened() && !res.destroyed) {
        await pause(500);
        if (!plan.gate.opened()) await send(res, read, plan.bytes.subarray(read.written, read.written + 16 * 1024));
      }
    }
    await send(res, read, plan.bytes.subarray(read.written));
  }
  if (!res.destroyed) res.end(() => { read.finished = true; });
}

async function startFeed(): Promise<Feed> {
  let latest: { readonly list: Buffer; readonly sig: Buffer } | undefined;
  const plans = new Map<string, { readonly version: string; readonly plan: Plan }>();
  const requests: Request[] = [];
  const reads: ArtifactRead[] = [];
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    requests.push({ method: req.method ?? "", url, userAgent: req.headers["user-agent"], cookie: req.headers.cookie, at: Date.now() });
    // A cookie on every answer: the copy must never send one back.
    res.setHeader("Set-Cookie", "probe=1; Path=/");
    if (latest !== undefined && url === "/latest/download/release.json") { res.writeHead(200).end(latest.list); return; }
    if (latest !== undefined && url === "/latest/download/release.json.sig") { res.writeHead(200).end(latest.sig); return; }
    const artifact = plans.get(url);
    if (artifact === undefined) { res.writeHead(404).end("not found"); return; }
    const read: ArtifactRead = { version: artifact.version, written: 0, finished: false, hungUp: false };
    reads.push(read);
    sendArtifact(res, artifact.plan, read).catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === "string") throw new Error("The loopback feed has no port.");
  const { port } = address;
  if (FORBIDDEN_PORTS.has(port)) throw new Error(`The loopback feed got a reserved port ${port}; run again.`);
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    reads,
    serve: (version, list, plan) => {
      latest = list;
      plans.set(`/download/v${version}/${fileFor(version)}`, { version, plan });
    },
    stop: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function signedList(version: string, o: { readonly size: number; readonly sha512: string }): { readonly list: Buffer; readonly sig: Buffer } {
  const list = encodeManifest({ schema: 1, version, commit: "a".repeat(40), artifacts: [{ ...artifactFor(ownPlatform, version), size: o.size, sha512: o.sha512 }] });
  return { list, sig: signManifest(list, testKey.privateKey) };
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
    GATES_LOCAL_OLLAMA_URL: "http://127.0.0.1:19750", GATES_LOCAL_COMFY_URL: "http://127.0.0.1:1",
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

const automaticSwitch = (copy: Copy) => copy.group.getByRole("switch", { name: "Check for updates automatically" });
const downloadButton = (copy: Copy) => copy.group.getByRole("button", { name: "Download", exact: true });
/** A checked download this copy cannot install: its folder, to run it from there (decision 24). */
const openFolder = (copy: Copy) => copy.group.getByRole("button", { name: "Open folder", exact: true });

const shots: string[] = [];
async function shoot(copy: Copy, name: string): Promise<void> {
  const file = path.join(output, `${name}.png`);
  await copy.group.screenshot({ path: file });
  shots.push(file);
}

async function checkNow(copy: Copy): Promise<void> {
  await copy.group.getByRole("button", { name: "Check for updates", exact: true }).click();
}

const updates = (copy: Copy) => path.join(copy.dataFolder, "updates");
const folders = (copy: Copy) => existsSync(updates(copy)) ? readdirSync(updates(copy)).toSorted() : [];
const artifactReads = (feed: Feed, version: string) => feed.reads.filter((r) => r.version === version);
const downloaded = (v: string) => `Update ${v} is downloaded and checked. ${process.platform === "win32" ? "Run this installer to update." : "Put it in place of this file."}`;
const bad = (v: string) => `The download of version ${v} did not match the signed release list, so it was deleted.`;
const downloadingLine = (v: string) => new RegExp(`Downloading version ${v.replaceAll(".", "\\.")} \\([1-9]\\.\\d of 3\\.0 MB\\)\\. You can keep chatting\\.`);

/** The three files, and the artifact's bytes and hash equal to what was signed. */
function expectPrepared(copy: Copy, version: string, bytes: Buffer, served: { readonly list: Buffer; readonly sig: Buffer }): Record<string, unknown> {
  const folder = path.join(updates(copy), version);
  expect(readdirSync(folder).toSorted()).toEqual([fileFor(version), "release.json", "release.json.sig"].toSorted());
  const onDisk = readFileSync(path.join(folder, fileFor(version)));
  expect(readFileSync(path.join(folder, "release.json")).equals(served.list)).toBe(true);
  expect(readFileSync(path.join(folder, "release.json.sig")).equals(served.sig)).toBe(true);
  expect(sha512(onDisk)).toBe(sha512(bytes));
  return { files: readdirSync(folder).toSorted(), size: onDisk.length, sha512: sha512(onDisk) };
}

const report: Record<string, unknown> = {};
let current: Copy | undefined;
let feed: Feed | undefined;
const gates: Gate[] = [];
try {
  feed = await startFeed();
  const fixture = feed;

  // ---- 1. Switch on, no click: the start-up check finds N+1 and downloads it.
  const launched = Date.now();
  const probe = await open(testBuild, "copy", fixture, true);
  current = probe;
  const version = await probe.app.evaluate(({ app }) => app.getVersion());
  const [major, minor, patch] = version.split(".").map(Number);
  if (major === undefined || minor === undefined || patch === undefined || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Build a release-shaped version, got ${version}`);
  const v = (step: number) => `${major}.${minor}.${patch + step}`;
  report["version"] = version;
  await expect(automaticSwitch(probe)).toHaveAttribute("aria-checked", "true");

  const first = randomBytes(SIZE);
  const firstList = signedList(v(1), { size: SIZE, sha512: sha512(first) });
  const firstGate = gate();
  gates.push(firstGate);
  fixture.serve(v(1), firstList, { mode: "held", bytes: first, gate: firstGate });
  await expect(probe.group).toContainText(downloadingLine(v(1)), { timeout: 60_000 });
  await expect(downloadButton(probe)).toHaveCount(0);
  await shoot(probe, "1-downloading");
  // Held part way: the list and signature are written; the artifact is only a .part.
  const midway = readdirSync(path.join(updates(probe), v(1))).toSorted();
  expect(midway).toEqual([`${fileFor(v(1))}.part`, "release.json", "release.json.sig"].toSorted());
  firstGate.open();
  await expect(probe.group).toContainText(downloaded(v(1)), { timeout: 30_000 });
  await expect(openFolder(probe)).toBeVisible();
  await shoot(probe, "1-downloaded");
  const firstRequest = fixture.requests[0];
  if (firstRequest === undefined) throw new Error("Settings showed a download the feed never served.");
  expect(fixture.requests.map((r) => r.url)).toEqual(["/latest/download/release.json", "/latest/download/release.json.sig", `/download/v${v(1)}/${fileFor(v(1))}`]);
  expect(artifactReads(fixture, v(1)).map((r) => ({ written: r.written, finished: r.finished }))).toEqual([{ written: SIZE, finished: true }]);
  report["automatic"] = {
    target: v(1), firstRequestAfterLaunchMs: firstRequest.at - launched, filesMidway: midway,
    prepared: expectPrepared(probe, v(1), first, firstList), signedSha512: sha512(first), requests: fixture.requests.length, artifactRequests: 1,
  };

  // ---- 2. A list for N+2 whose artifact has the right size and a wrong hash.
  let before = fixture.requests.length;
  const second = randomBytes(SIZE);
  fixture.serve(v(2), signedList(v(2), { size: SIZE, sha512: sha512(randomBytes(SIZE)) }), { mode: "whole", bytes: second });
  await checkNow(probe);
  await expect(probe.group).toContainText(bad(v(2)), { timeout: 30_000 });
  await expect(probe.group.getByRole("alert")).toContainText(bad(v(2)));
  await shoot(probe, "2-wrong-hash");
  // Gone, and the older prepared version went when the newer list arrived.
  expect(folders(probe)).toEqual([]);
  expect(fixture.requests.slice(before).map((r) => r.url)).toEqual(["/latest/download/release.json", "/latest/download/release.json.sig", `/download/v${v(2)}/${fileFor(v(2))}`]);
  expect(artifactReads(fixture, v(2)).map((r) => r.written)).toEqual([SIZE]);
  report["wrongHash"] = { target: v(2), folders: folders(probe), artifactRequests: 1, bytesSent: SIZE };

  // ---- 3. A list for N+3 that says 3 MB, and a server offering 64 MB with no length.
  before = fixture.requests.length;
  fixture.serve(v(3), signedList(v(3), { size: SIZE, sha512: sha512(randomBytes(SIZE)) }), { mode: "endless" });
  await checkNow(probe);
  await expect(probe.group).toContainText(bad(v(3)), { timeout: 30_000 });
  await shoot(probe, "3-oversize");
  expect(folders(probe)).toEqual([]);
  const endless = artifactReads(fixture, v(3));
  expect(endless).toHaveLength(1);
  const cut = endless[0];
  if (cut === undefined) throw new Error("No artifact request for the oversize list.");
  // Socket buffers can hold some bytes the copy never read; the copy still
  // hung up long before the 64 MB on offer.
  expect(cut.hungUp).toBe(true);
  expect(cut.written).toBeLessThan(SIZE + 16 * 1024 * 1024);
  expect(fixture.requests.length - before).toBe(3);
  report["oversize"] = { target: v(3), listedSize: SIZE, offered: OFFERED, bytesIntoSocketBeforeHangUp: cut.written, hungUp: cut.hungUp, folders: folders(probe) };

  // ---- 4. Switch off: a newer list brings no artifact request until Download.
  await automaticSwitch(probe).click();
  await expect(automaticSwitch(probe)).toHaveAttribute("aria-checked", "false");
  before = fixture.requests.length;
  const fourth = randomBytes(SIZE);
  const fourthList = signedList(v(4), { size: SIZE, sha512: sha512(fourth) });
  fixture.serve(v(4), fourthList, { mode: "whole", bytes: fourth });
  await checkNow(probe);
  await expect(probe.group).toContainText(`Update ${v(4)} available.`, { timeout: 15_000 });
  await expect(downloadButton(probe)).toBeVisible();
  await pause(5_000);
  expect(fixture.requests.slice(before).map((r) => r.url)).toEqual(["/latest/download/release.json", "/latest/download/release.json.sig"]);
  expect(artifactReads(fixture, v(4))).toEqual([]);
  expect(folders(probe)).toEqual([]);
  await shoot(probe, "4-offered");
  await downloadButton(probe).click();
  await expect(probe.group).toContainText(downloaded(v(4)), { timeout: 30_000 });
  await expect(downloadButton(probe)).toHaveCount(0);
  await shoot(probe, "4-downloaded-after-click");
  expect(artifactReads(fixture, v(4)).map((r) => r.written)).toEqual([SIZE]);
  report["switchOff"] = { target: v(4), artifactRequestsBeforeClick: 0, artifactRequestsAfterClick: 1, prepared: expectPrepared(probe, v(4), fourth, fourthList) };

  // ---- 5. Switch on, a held download of N+5, then switch off mid-way.
  await automaticSwitch(probe).click();
  await expect(automaticSwitch(probe)).toHaveAttribute("aria-checked", "true");
  const fifth = randomBytes(SIZE);
  const fifthGate = gate();
  gates.push(fifthGate);
  fixture.serve(v(5), signedList(v(5), { size: SIZE, sha512: sha512(fifth) }), { mode: "held", bytes: fifth, gate: fifthGate });
  await checkNow(probe);
  await expect(probe.group).toContainText(downloadingLine(v(5)), { timeout: 30_000 });
  await shoot(probe, "5-downloading");
  // The newer list took N+4's folder away; only N+5's partial folder is left.
  expect(folders(probe)).toEqual([v(5)]);
  await automaticSwitch(probe).click();
  await expect(automaticSwitch(probe)).toHaveAttribute("aria-checked", "false");
  await expect(probe.group).toContainText(`Update ${v(5)} available.`, { timeout: 15_000 });
  await expect(downloadButton(probe)).toBeVisible();
  await shoot(probe, "5-switched-off");
  expect(folders(probe)).toEqual([]);
  const held = artifactReads(fixture, v(5));
  expect(held).toHaveLength(1);
  expect(held[0]?.hungUp).toBe(true);
  expect(held[0]?.finished).toBe(false);
  report["switchOffMidway"] = { target: v(5), bytesSentBeforeHangUp: held[0]?.written, hungUp: held[0]?.hungUp, folders: folders(probe) };

  for (const request of fixture.requests) {
    expect(request.method).toBe("GET");
    expect(request.url).not.toContain("?");
    expect(request.userAgent).toBe("Gates-Local");
    expect(request.cookie).toBeUndefined();
  }
  report["requests"] = {
    total: fixture.requests.length,
    artifactRequests: fixture.reads.length,
    byPath: fixture.requests.reduce<Record<string, number>>((n, r) => ({ ...n, [r.url]: (n[r.url] ?? 0) + 1 }), {}),
  };
  await probe.app.close();
  current = undefined;

  expect(git.calls()).toBe("");
  report["git"] = git.how === "recorded" ? { calls: 0 } : { onPath: false };
  report["screenshots"] = shots.map((file) => path.relative(output, file));
  writeFileSync(path.join(output, "report.json"), JSON.stringify({ passed: true, ...report }, null, 2) + "\n");
  console.log(`Installed-download probe passed: version ${version}, ${shots.length} screenshots in ${output}.`);
} catch (error) {
  let words = "";
  try { if (current) { words = await current.group.innerText({ timeout: 2_000 }); await current.group.screenshot({ path: path.join(output, "failure.png") }); } }
  catch { words = "(the Updates group could not be read)"; }
  const requests = feed?.requests.map((r) => r.url) ?? [];
  writeFileSync(path.join(output, "report.json"), JSON.stringify({ passed: false, error: String(error), updates: words, requests, ...report }, null, 2) + "\n");
  console.error(`Updates group at failure:\n${words}\nRequests at the fixture server: ${JSON.stringify(requests)}`);
  throw error;
} finally {
  for (const g of gates) g.open();
  await current?.app.close().catch(() => undefined);
  await feed?.stop().catch(() => undefined);
  rmSync(work, { recursive: true, force: true });
}
