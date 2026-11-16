// The installed module: every sentence of Settings' table from a real signed
// list, the status and refusals it answers, and the composition that keeps
// the clone updater when the desktop says nothing. The test-build gate and the
// download's words are tested beside them (packages/update/src/installed/copy.test.ts).
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { decodeResult, type UpdateCheck, type UpdateStatus } from "@gates-local/contracts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateModule } from "../module.ts";
import { createUpdateAdmission, FINISHING, UPDATE_PAUSED } from "@gates-local/update/admission";
import { readRecord, RECORD_FILE, writeRecord } from "@gates-local/update/record";
import { LIST_FILE, SIGNATURE_FILE, verifyKept } from "@gates-local/update/installed/download";
import { type Stream, streamGet } from "@gates-local/update/installed/feed";
import { INSTALL_REFUSAL, type InstalledFeed } from "@gates-local/update/installed/copy";
import { INSTALLED_APPROVAL_MS } from "@gates-local/update/installed/transaction";
import { chooseUpdateModule, createInstalledUpdateModule, type InstalledModuleDeps } from "./module.ts";
import { artifactFile, BASE, LIST_URL, listFor, memoryFeed, releaseKey, releasePage, type ReleasePage, sha512, SIG_URL, signedList } from "@gates-local/update/installed/testing";

/** How long a wait for the module may take. A download ends with disk syncs, which a busy machine can
 *  hold for seconds: vi.waitFor's own second failed twice in full runs ("expected 'downloading' to be 'ready'"). */
const WAIT = { timeout: 5_000 } as const;
/** Until the check passes. Every wait in this file is for something the module does, so each gets WAIT. */
const eventually = <T>(check: () => T) => vi.waitFor(check, WAIT);

/** A data folder under ~/.cache, removed by the test that made it. */
function tempDataDir(): string {
  const cache = path.join(homedir(), ".cache");
  fs.mkdirSync(cache, { recursive: true });
  return fs.mkdtempSync(path.join(cache, "installed-module-test-"));
}

const key = releaseKey();
const PAGE = `${BASE.href}/latest`;
const feedWith = (keys: readonly string[]): InstalledFeed => ({ base: BASE, page: PAGE, keys, allowLoopbackHttp: false });

/** Settings' automatic switch, flipped by the test. */
function toggle(on: boolean) {
  let value = on;
  const listeners = new Set<() => void>();
  return {
    automatic: { enabled: () => value, onChange: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } },
    set(next: boolean) { value = next; for (const listener of listeners) listener(); },
  };
}

// The words tests below make no download (the switch is off and nothing is clicked).
let wordsDir: string;
beforeAll(() => { wordsDir = tempDataDir(); });
afterAll(() => fs.rmSync(wordsDir, { recursive: true, force: true }));
const offline = () => ({ dataDir: wordsDir, automatic: toggle(false).automatic, keep: () => [] });

function copy(o: { version?: string; keys?: readonly string[]; feed?: ReturnType<typeof memoryFeed> } = {}) {
  const feed = o.feed ?? memoryFeed();
  const changed = vi.fn();
  const module = createInstalledUpdateModule({
    ...offline(),
    version: o.version ?? "1.2.3", platform: "linux", arch: "x64",
    feed: feedWith(o.keys ?? [key.publicKey]), get: feed.get,
    now: () => 1_000, changed,
  });
  return { module, feed, changed };
}

/** The check's words as Settings shows them, after it decoded off the wire. */
async function words(module: UpdateModule): Promise<{ lines: readonly string[]; page?: string; state: UpdateCheck["state"] }> {
  const check = await module.check();
  // The check answers with the status it left: the check's words travel inside it.
  const decoded = decodeResult("update.check", { ...module.status(), lastCheck: check });
  if (!decoded.ok || decoded.value.lastCheck === null) throw new Error(`does not decode: ${JSON.stringify(check)}`);
  const status = decodeResult("update.status", module.status());
  if (!status.ok) throw new Error("status does not decode");
  const c = decoded.value.lastCheck;
  if (c.state === "up-to-date") return { state: c.state, lines: [] };
  if (c.state === "available") throw new Error("an installed copy never offers an install");
  return { state: c.state, lines: c.lines, ...(c.page === undefined ? {} : { page: c.page }) };
}

describe("Settings' words for an installed copy", () => {
  it("version row: the installed version, no approval, no install", async () => {
    const { module } = copy();
    expect(module.status()).toEqual({ version: { kind: "installed", version: "1.2.3" }, result: null, lastCheck: null, activity: [], installing: false });
    expect(decodeResult("update.status", module.status()).ok).toBe(true);
    expect(await module.prepare("anything")).toEqual({ state: "blocked", message: INSTALL_REFUSAL });
    expect(module.commit({ reservation: "r", target: "0".repeat(40), release: "x" })).toEqual({ accepted: false });
  });

  it("development build", async () => {
    const { module, feed } = copy({ version: "0.0.0-dev" });
    expect(await words(module)).toEqual({ state: "cannot-check", lines: ["This is a development build, so it does not check for updates."] });
    expect(feed.reads).toEqual([]);
  });

  it("no key, with no request made", async () => {
    const { module, feed } = copy({ keys: [] });
    feed.serve(signedList("2.0.0", ["linux"], key.privateKey));
    expect(await words(module)).toEqual({ state: "cannot-check", lines: ["This build has no release key, so it cannot check for updates. Download the latest version from the release page."], page: PAGE });
    expect(feed.reads).toEqual([]);
  });

  it("none found", async () => {
    const { module, feed } = copy();
    feed.serve(signedList("1.2.3", ["linux"], key.privateKey));
    expect(await words(module)).toEqual({ state: "up-to-date", lines: [] });
    expect(module.status().lastCheck).toEqual({ state: "up-to-date", checkedAt: 1_000, channel: "release", current: "1.2.3" });
  });

  it("available, with no approval or install control", async () => {
    const { module, feed } = copy();
    feed.serve(signedList("1.3.0", ["linux", "win32"], key.privateKey));
    expect(await words(module)).toEqual({ state: "newer", lines: ["Version 1.3.0 is available."], page: PAGE });
    expect(module.status().lastCheck).toMatchObject({ state: "newer", current: "1.2.3", target: "1.3.0", forThisCopy: true });
    expect(module.status()).not.toHaveProperty("approval");
    expect(await module.prepare("anything")).toEqual({ state: "blocked", message: INSTALL_REFUSAL });
  });

  it("not for this copy", async () => {
    const { module, feed } = copy();
    feed.serve(signedList("1.3.0", ["win32"], key.privateKey));
    expect(await words(module)).toEqual({ state: "newer", lines: ["Version 1.3.0 is available, but this copy cannot install it by itself. Download it from the release page."], page: PAGE });
    expect(module.status().lastCheck).toMatchObject({ forThisCopy: false });
  });

  // "Gates Local will try again in an hour." is Settings' to add from the live
  // switch (apps/web/src/updates/updates.test.ts), never baked in here.
  it("could not reach", async () => {
    const { module } = copy();
    expect(await words(module)).toEqual({ state: "cannot-check", lines: ["Could not reach the update server. Check your connection."] });
  });

  it("no list", async () => {
    const { module, feed } = copy();
    feed.answer(LIST_URL, { kind: "missing" });
    expect(await words(module)).toEqual({ state: "cannot-check", lines: ["No release list was found on the release page."] });
  });

  it("bad signature", async () => {
    const { module, feed } = copy();
    feed.serve(signedList("1.3.0", ["linux"], releaseKey().privateKey));
    expect(await words(module)).toEqual({ state: "cannot-check", lines: ["The release list did not pass its signature check, so Gates Local ignored it. Nothing was downloaded. If this keeps happening, download the latest version from the release page."], page: PAGE });
    expect(feed.reads).toEqual([LIST_URL, SIG_URL]);
  });
});

describe("the installed module's checks", () => {
  it("shares one read between two clicks and keeps background failures silent", async () => {
    const { module, feed, changed } = copy();
    feed.serve(signedList("1.3.0", ["linux"], key.privateKey));
    await Promise.all([module.check(), module.check()]);
    expect(feed.reads).toEqual([LIST_URL, SIG_URL]);
    expect(changed).toHaveBeenCalledTimes(2);
    const quiet = copy();
    await quiet.module.check(true);
    expect(quiet.module.status().lastCheck).toBeNull();
    expect(quiet.changed).not.toHaveBeenCalled();
  });

  it("never reads the release list when the status is read, however often", async () => {
    const { module, feed } = copy();
    feed.serve(signedList("1.3.0", ["linux"], key.privateKey));
    for (let i = 0; i < 3; i += 1) module.status();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(feed.reads).toEqual([]);
    expect(module.status().lastCheck).toBeNull();
    await module.close();
  });

  it("stops the read on close", async () => {
    let seen: AbortSignal | undefined;
    const module = createInstalledUpdateModule({
      ...offline(),
      version: "1.2.3", platform: "linux", arch: "x64", feed: feedWith([key.publicKey]),
      get: (_url, _max, signal) => { seen = signal; return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ kind: "failed", detail: "stopped" }))); },
    });
    const pending = module.check();
    await eventually(() => expect(seen).toBeDefined());
    await module.close();
    expect(seen?.aborted).toBe(true);
    expect((await pending).state).toBe("cannot-check");
  });

  it("a check after close says it is closing, with a reason Settings never promises a retry for", async () => {
    const { module, feed } = copy();
    await module.close();
    expect(await module.check()).toMatchObject({ state: "cannot-check", reason: "error", lines: ["Gates Local is closing, so it did not check for updates."] });
    expect(feed.reads).toEqual([]);
  });

  it("close ends a real read in flight and hangs up", async () => {
    const hungUp: Promise<void>[] = [];
    const server = http.createServer((_req, res) => {
      const socket = res.req.socket;
      hungUp.push(new Promise((resolve) => socket.on("close", () => resolve())));
      res.writeHead(200);
      const timer = setInterval(() => res.write("{"), 20);
      res.on("close", () => clearInterval(timer));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      const base = new URL(`http://127.0.0.1:${address.port}/r`);
      const module = createInstalledUpdateModule({
        ...offline(),
        version: "1.2.3", platform: "linux", arch: "x64",
        feed: { base, page: `${base.href}/latest`, keys: [key.publicKey], allowLoopbackHttp: true },
      });
      const pending = module.check();
      await eventually(() => expect(hungUp).toHaveLength(1));
      const closing = Date.now();
      await module.close();
      expect(Date.now() - closing).toBeLessThan(500);
      expect((await pending).state).toBe("cannot-check");
      await hungUp[0];
      expect(module.status().lastCheck).toBeNull();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

const stub = (name: string): UpdateModule => createInstalledUpdateModule({ ...offline(), version: name, platform: "linux", arch: "x64", feed: feedWith([]) });

describe("composition", () => {
  it("builds the clone updater, and never the installed module, when the desktop says nothing", () => {
    const installed = vi.fn(() => stub("installed"));
    const clone = vi.fn(() => stub("clone"));
    chooseUpdateModule({}, { installed, clone });
    chooseUpdateModule({ GATES_LOCAL_INSTALLED_VERSION: "" }, { installed, clone });
    expect(clone).toHaveBeenCalledTimes(2);
    expect(installed).not.toHaveBeenCalled();
  });

  it("builds the installed module, and never the clone updater, for an installed copy", () => {
    const installed = vi.fn(() => stub("installed"));
    const clone = vi.fn(() => stub("clone"));
    chooseUpdateModule({ GATES_LOCAL_INSTALLED_VERSION: "1.2.3" }, { installed, clone });
    expect(installed).toHaveBeenCalledWith("1.2.3");
    expect(clone).not.toHaveBeenCalled();
  });
});

/** The newer check Settings shows, after it decoded off the wire. */
function shown(module: UpdateModule) {
  const decoded = decodeResult("update.status", module.status());
  if (!decoded.ok) throw new Error("status does not decode");
  const check = decoded.value.lastCheck;
  if (check?.state !== "newer") throw new Error(`not newer: ${JSON.stringify(check)}`);
  return check;
}
/** Until the download in flight ends. */
const settled = (module: UpdateModule) => vi.waitFor(() => {
  const download = shown(module).download;
  if (download === undefined || download === "downloading") throw new Error(`still ${String(download)}`);
}, WAIT);
/** The progress lines among the pushes Settings received. */
const downloading = (pushes: readonly UpdateStatus[]) => pushes.flatMap((s) => (s.lastCheck?.state === "newer" && s.lastCheck.download === "downloading" ? s.lastCheck.lines : []));

describe("downloading a newer version", () => {
  const VERSION = "1.3.0";
  const FILE = artifactFile(VERSION);
  const ARTIFACT = `/r/download/v${VERSION}/${FILE}`;
  const BYTES = randomBytes(300_000);
  let dataDir: string;
  let page: ReleasePage;
  beforeEach(async () => { dataDir = tempDataDir(); page = await releasePage(); });
  afterEach(async () => { await page.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const folder = (version = VERSION) => path.join(dataDir, "updates", version);
  const artifactRequests = () => page.requests.filter((p) => p === ARTIFACT).length;
  const serveGood = () => {
    const files = listFor(VERSION, BYTES, key.privateKey);
    page.serve(files, { file: FILE, bytes: BYTES });
    return files;
  };
  function installed(on: boolean, over: Partial<InstalledModuleDeps> = {}) {
    const sw = toggle(on);
    const pushes: UpdateStatus[] = [];
    const module = createInstalledUpdateModule({
      version: "1.2.3", platform: "linux", arch: "x64", program: "/apps/Gates-Local-1.2.3-x86_64.AppImage",
      feed: { base: page.base, page: `${page.base.href}/latest`, keys: [key.publicKey], allowLoopbackHttp: true },
      dataDir, automatic: sw.automatic, keep: () => [],
      freeSpace: () => Promise.resolve({ volume: "/data", free: 10 ** 12 }),
      changed: (status) => { pushes.push(status); },
      ...over,
    });
    return { module, sw, pushes };
  }
  /** An install the Windows installer made (design section 3, W-A). */
  const windows = (over: Partial<InstalledModuleDeps> = {}) => installed(true, { platform: "win32", restart: "windows", ...over });
  /** Headers and the first bytes, then silence: a download in flight. */
  const hold = () => page.route((p, res) => {
    if (p !== ARTIFACT) return false;
    res.writeHead(200, { "Content-Length": BYTES.length });
    res.write(BYTES.subarray(0, 1000));
    return true;
  });

  it("with the switch on, a check that finds a newer version downloads it without asking", async () => {
    serveGood();
    const { module } = installed(true);
    expect(await module.check()).toMatchObject({ state: "newer", download: "downloading" });
    await settled(module);
    expect(shown(module)).toMatchObject({ download: "ready", lines: ["Update 1.3.0 is downloaded and checked. Put the new file in place of /apps/Gates-Local-1.2.3-x86_64.AppImage."], page: `${page.base.href}/latest` });
    expect(fs.readdirSync(folder()).toSorted()).toEqual([FILE, LIST_FILE, SIGNATURE_FILE]);
    expect(sha512(fs.readFileSync(path.join(folder(), FILE)))).toBe(sha512(BYTES));
    expect(artifactRequests()).toBe(1);
    await module.close();
  });

  it("with the switch off, nothing downloads until the Download click", async () => {
    serveGood();
    const { module } = installed(false);
    const check = await module.check();
    expect(check).toMatchObject({ state: "newer", lines: ["Version 1.3.0 is available."] });
    expect(check).not.toHaveProperty("download");
    expect(artifactRequests()).toBe(0);
    expect(fs.existsSync(folder())).toBe(false);
    expect(await module.download?.()).toMatchObject({ state: "newer", download: "downloading" });
    await settled(module);
    expect(shown(module).download).toBe("ready");
    expect(artifactRequests()).toBe(1);
    await module.close();
  });

  it("with the switch off, the Download click checks for the newer version, downloads and checks it, and installs nothing", async () => {
    serveGood();
    const admission = createUpdateAdmission();
    const { module } = installed(false, { restart: "yes", admission });
    await module.download?.();
    await settled(module);
    expect(shown(module)).toMatchObject({ download: "ready", restart: true });
    expect(artifactRequests()).toBe(1);
    await module.download?.();
    expect(typeof module.status().approval).toBe("string");
    expect(admission.installing()).toBe(false);
    expect(module.status().installing).toBe(false);
    expect(artifactRequests()).toBe(1);
    await module.close();
  });

  it("an automatic check downloads a newer version and offers Restart, but never installs it", async () => {
    serveGood();
    const admission = createUpdateAdmission();
    const { module } = installed(true, { restart: "yes", admission });
    await module.check(true);
    await settled(module);
    await module.check(true);
    expect(shown(module)).toMatchObject({ download: "ready", restart: true });
    expect(typeof module.status().approval).toBe("string");
    expect(admission.installing()).toBe(false);
    expect(module.status().installing).toBe(false);
    await module.close();
  });

  /** The release's file is wrong for the list served until the test fixes one or the other. */
  function serveWrongFile() {
    const files = serveGood();
    const wrong = Buffer.from(BYTES);
    wrong[7] = (wrong[7] ?? 0) ^ 1;
    let broken = true;
    page.route((p, res) => {
      if (p !== ARTIFACT || !broken) return false;
      res.writeHead(200, { "Content-Length": wrong.length }).end(wrong);
      return true;
    });
    return { files, wrong, fixFile: () => { broken = false; } };
  }
  /** A bad download from a background check with the switch on. */
  async function badOnce(over: Partial<InstalledModuleDeps> = {}) {
    const release = serveWrongFile();
    const made = installed(true, over);
    await made.module.check(true);
    await settled(made.module);
    expect(shown(made.module)).toMatchObject({ download: "bad", lines: ["The download of version 1.3.0 did not match the signed release list, so it was deleted."] });
    expect(fs.existsSync(folder())).toBe(false);
    expect(artifactRequests()).toBe(1);
    return { ...release, ...made };
  }

  it("a bad download is not fetched again by a background check of the same list", async () => {
    const { module, fixFile } = await badOnce();
    fixFile();
    await module.check(true);
    await settled(module);
    expect(shown(module)).toMatchObject({ download: "bad", lines: ["The download of version 1.3.0 did not match the signed release list, so it was deleted."] });
    expect(artifactRequests()).toBe(1);
    expect(fs.existsSync(folder())).toBe(false);
    await module.close();
  });

  it("after a bad download, Check for updates fetches the same list again", async () => {
    const { module, fixFile } = await badOnce();
    fixFile();
    expect(await module.check()).toMatchObject({ download: "downloading" });
    await settled(module);
    expect(shown(module).download).toBe("ready");
    expect(artifactRequests()).toBe(2);
    await module.close();
  });

  it("after a bad download, a click that joins a background check in flight still fetches again", async () => {
    const { module, fixFile } = await badOnce();
    fixFile();
    await Promise.all([module.check(true), module.check()]);
    await settled(module);
    expect(shown(module).download).toBe("ready");
    expect(artifactRequests()).toBe(2);
    await module.close();
  });

  it("after a bad download, the Download click fetches the same list again", async () => {
    const { module, fixFile } = await badOnce();
    fixFile();
    expect(await module.download?.()).toMatchObject({ download: "downloading" });
    await settled(module);
    expect(shown(module).download).toBe("ready");
    expect(artifactRequests()).toBe(2);
    await module.close();
  });

  it("after a bad download, a background check fetches a list whose bytes changed", async () => {
    const { module, wrong } = await badOnce();
    // The release is fixed by signing a list for the file it serves.
    page.serve(listFor(VERSION, wrong, key.privateKey));
    await module.check(true);
    await settled(module);
    expect(shown(module).download).toBe("ready");
    expect(artifactRequests()).toBe(2);
    expect(sha512(fs.readFileSync(path.join(folder(), FILE)))).toBe(sha512(wrong));
    await module.close();
  });

  it("after a bad download, a click whose retry could not finish keeps the hourly retry", async () => {
    const { module } = await badOnce();
    let failOnce = true;
    page.route((p, res) => {
      if (p !== ARTIFACT || !failOnce) return false;
      failOnce = false;
      res.writeHead(500).end();
      return true;
    });
    await module.check();
    await settled(module);
    expect(shown(module)).toMatchObject({ download: "failed", lines: ["Could not download version 1.3.0. Check your connection."] });
    expect(artifactRequests()).toBe(2);
    // The next background check (hourly in the app) tries again.
    await module.check(true);
    await settled(module);
    expect(shown(module).download).toBe("ready");
    expect(artifactRequests()).toBe(3);
    await module.close();
  });

  it("after a bad download, a retry the switch ended leaves the list still not fetched by a background check", async () => {
    // The .part file is made before the request leaves (download.ts fetchInto).
    // A slow start holds that gap open, as a busy machine can.
    const real = streamGet({ allowLoopbackHttp: true });
    const slowStart: Stream = async (url, body, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return real(url, body, signal);
    };
    const { module, sw, fixFile } = await badOnce({ stream: slowStart });
    fixFile();
    hold();
    await module.check();
    // The retry's request has reached the page (a .part file alone does not say so), so hangUps[1] is its socket.
    await eventually(() => expect(artifactRequests()).toBe(2));
    sw.set(false);
    await page.hangUps[1];
    await eventually(() => expect(fs.existsSync(folder())).toBe(false));
    sw.set(true);
    await module.check(true);
    expect(shown(module).download).toBe("bad");
    expect(artifactRequests()).toBe(2);
    await module.close();
  });

  it.each([
    ["a newer version that downloads", "1.4.0", "ready"],
    ["a newer version still downloading", "1.4.0", "held"],
    ["a list with nothing newer", "1.2.0", "none"],
  ] as const)("a list that did not match is fetched again once %s came between", async (_name, between, how) => {
    const { module, files, fixFile } = await badOnce();
    const other = randomBytes(1_000);
    page.serve(listFor(between, other, key.privateKey), { file: artifactFile(between), bytes: other });
    const otherPath = `/r/download/v${between}/${artifactFile(between)}`;
    if (how === "held") {
      page.route((p, res) => {
        if (p !== otherPath) return false;
        res.writeHead(200, { "Content-Length": other.length });
        res.write(other.subarray(0, 100));
        return true;
      });
    }
    await module.check(true);
    if (how === "ready") await eventually(() => expect(shown(module).download).toBe("ready"));
    if (how === "held") await eventually(() => expect(page.requests).toContain(otherPath));
    // That list is withdrawn and the first one's exact bytes come back.
    page.serve(files);
    if (how !== "held") fixFile();
    else page.route(undefined);
    await module.check(true);
    await settled(module);
    expect(shown(module).download).toBe("ready");
    expect(artifactRequests()).toBe(2);
    await module.close();
  });

  it("a download in flight is ended when the same version is re-signed, and the new list's file is the one made ready", async () => {
    serveGood();
    let held = true;
    page.route((p, res) => {
      if (p !== ARTIFACT || !held) return false;
      held = false;
      res.writeHead(200, { "Content-Length": BYTES.length });
      res.write(BYTES.subarray(0, 1000));
      return true;
    });
    const { module } = installed(true);
    await module.check(true);
    await eventually(() => expect(fs.existsSync(path.join(folder(), `${FILE}.part`))).toBe(true));
    const other = randomBytes(BYTES.length);
    const resigned = listFor(VERSION, other, key.privateKey);
    page.serve(resigned, { file: FILE, bytes: other });
    await module.check(true);
    await eventually(() => expect(artifactRequests()).toBe(2));
    await page.hangUps[0];
    await settled(module);
    expect(shown(module).download).toBe("ready");
    expect(sha512(fs.readFileSync(path.join(folder(), FILE)))).toBe(sha512(other));
    expect(fs.readFileSync(path.join(folder(), LIST_FILE)).equals(resigned.list)).toBe(true);
    await module.close();
  });

  it("a ready version re-signed with a different file is downloaded again, not reused", async () => {
    serveGood();
    const { module } = installed(true);
    await module.check(true);
    await settled(module);
    expect(shown(module).download).toBe("ready");
    const other = randomBytes(BYTES.length);
    const files = listFor(VERSION, other, key.privateKey);
    page.serve(files, { file: FILE, bytes: other });
    await module.check(true);
    await settled(module);
    expect(shown(module).download).toBe("ready");
    expect(artifactRequests()).toBe(2);
    expect(sha512(fs.readFileSync(path.join(folder(), FILE)))).toBe(sha512(other));
    expect(fs.readFileSync(path.join(folder(), LIST_FILE)).equals(files.list)).toBe(true);
    await module.close();
  });

  it("a download that could not finish is tried again at the next check while the switch is on", async () => {
    serveGood();
    let first = true;
    page.route((p, res) => {
      if (p !== ARTIFACT || !first) return false;
      first = false;
      res.writeHead(500).end();
      return true;
    });
    const { module } = installed(true);
    await module.check(true);
    await settled(module);
    expect(shown(module)).toMatchObject({ download: "failed", lines: ["Could not download version 1.3.0. Check your connection."] });
    await module.check(true);
    await settled(module);
    expect(shown(module).download).toBe("ready");
    expect(artifactRequests()).toBe(2);
    await module.close();
  });

  it("with the switch off, a failed download is not retried; Check for updates offers Download again", async () => {
    serveGood();
    page.route((p, res) => {
      if (p !== ARTIFACT) return false;
      res.writeHead(500).end();
      return true;
    });
    const { module } = installed(false);
    await module.check();
    await module.download?.();
    await settled(module);
    expect(shown(module).download).toBe("failed");
    const again = await module.check();
    expect(again).toMatchObject({ lines: ["Version 1.3.0 is available."] });
    expect(again).not.toHaveProperty("download");
    expect(artifactRequests()).toBe(1);
    await module.close();
  });

  it("too little free space makes no artifact request and names the volume and sizes", async () => {
    serveGood();
    const { module } = installed(true, { freeSpace: () => Promise.resolve({ volume: "/data", free: 100_000 }) });
    await module.check();
    await settled(module);
    expect(shown(module)).toMatchObject({ download: "disk", lines: ["Not enough free space on /data for version 1.3.0 (needs 0.3 MB, 0.1 MB free). Free some space, then use Check for updates."] });
    expect(artifactRequests()).toBe(0);
    expect(fs.existsSync(folder())).toBe(false);
    await module.close();
  });

  it("turning the switch off ends a download in flight, hangs up, and leaves no folder", async () => {
    serveGood();
    hold();
    const { module, sw } = installed(true);
    await module.check();
    await eventually(() => expect(page.hangUps).toHaveLength(1));
    await eventually(() => expect(fs.existsSync(path.join(folder(), `${FILE}.part`))).toBe(true));
    sw.set(false);
    await page.hangUps[0];
    await eventually(() => expect(fs.existsSync(folder())).toBe(false));
    await eventually(() => expect(shown(module)).not.toHaveProperty("download"));
    expect(shown(module).lines).toEqual(["Version 1.3.0 is available."]);
    await module.close();
  });

  it("closing ends a download in flight, hangs up, and leaves nothing a later start would trust", async () => {
    serveGood();
    hold();
    const { module } = installed(true);
    await module.check();
    await eventually(() => expect(fs.existsSync(path.join(folder(), `${FILE}.part`))).toBe(true));
    const closing = Date.now();
    await module.close();
    expect(Date.now() - closing).toBeLessThan(1_000);
    await page.hangUps[0];
    expect(fs.existsSync(folder())).toBe(false);
  });

  it("a kept version survives the cleanup a newer list starts, and the switch turned off keeps the finished download", async () => {
    for (const version of ["1.0.0", "1.1.0"]) {
      fs.mkdirSync(folder(version), { recursive: true });
      fs.writeFileSync(path.join(folder(version), "note"), version);
    }
    serveGood();
    const { module, sw } = installed(true, { keep: () => ["1.1.0"] });
    await module.check();
    await settled(module);
    expect(shown(module).download).toBe("ready");
    expect(fs.readdirSync(path.join(dataDir, "updates")).toSorted()).toEqual(["1.1.0", "1.3.0"]);
    sw.set(false);
    await eventually(() => expect(fs.existsSync(folder("1.0.0"))).toBe(false));
    expect(fs.readdirSync(path.join(dataDir, "updates")).toSorted()).toEqual(["1.1.0", "1.3.0"]);
    expect(fs.readFileSync(path.join(folder("1.1.0"), "note"), "utf8")).toBe("1.1.0");
    // Still offered as downloaded: nothing is fetched twice.
    expect(shown(module).download).toBe("ready");
    expect(artifactRequests()).toBe(1);
    await module.close();
  });

  it("a copy started from inside its own download folder keeps that folder, is told so, and still gets the next version", async () => {
    // The person double-clicked the AppImage an earlier update left in updates/1.2.3/; that folder is writable.
    const running = path.join(folder("1.2.3"), artifactFile("1.2.3"));
    fs.mkdirSync(folder("1.2.3"), { recursive: true });
    fs.writeFileSync(running, "the running program");
    serveGood();
    const { module, sw } = installed(true, { restart: "yes", program: running });
    await module.check();
    await settled(module);
    expect(fs.readFileSync(running, "utf8")).toBe("the running program");
    expect(fs.readdirSync(path.join(dataDir, "updates")).toSorted()).toEqual(["1.2.3", VERSION]);
    const check = shown(module);
    expect(check).toMatchObject({ download: "ready", lines: ["Update 1.3.0 is downloaded and checked. This copy runs from its download folder, so put the new file where you keep programs and start it from there."] });
    expect(check).not.toHaveProperty("restart");
    expect(module.status()).not.toHaveProperty("approval");
    expect(await module.prepare("anything")).toEqual({ state: "blocked", message: "Gates Local cannot replace its own file because it runs from its download folder. Download version 1.3.0 from the release page and replace the file yourself." });
    // The switch's cleanup keeps it too.
    sw.set(false);
    await eventually(async () => { await module.check(); expect(shown(module).download).toBe("ready"); });
    expect(fs.readFileSync(running, "utf8")).toBe("the running program");
    await module.close();
  });

  it("a folder the app was once started from is still there after another copy finds a newer version and cleans up", async () => {
    // One day the person started the AppImage an earlier download left in updates/1.1.0/, and made a shortcut to it.
    const launched = path.join(folder("1.1.0"), artifactFile("1.1.0"));
    fs.mkdirSync(folder("1.1.0"), { recursive: true });
    fs.writeFileSync(launched, "the program the shortcut starts");
    fs.mkdirSync(folder("1.0.0"), { recursive: true });
    fs.writeFileSync(path.join(folder("1.0.0"), "note"), "never started from");
    const first = installed(false, { version: "1.1.0", restart: "yes", program: launched });
    await first.module.close();
    // Another day they start the copy in their programs folder; it finds 1.3.0 and cleans up the others.
    serveGood();
    const { module } = installed(true);
    await module.check();
    await settled(module);
    expect(shown(module).download).toBe("ready");
    expect(fs.existsSync(folder("1.0.0"))).toBe(false);
    expect(fs.readFileSync(launched, "utf8")).toBe("the program the shortcut starts");
    await module.close();
  });

  it("sends progress at most about once a second", async () => {
    serveGood();
    page.route((p, res) => {
      if (p !== ARTIFACT) return false;
      res.writeHead(200, { "Content-Length": BYTES.length });
      let sent = 0;
      const step = 50_000;
      const timer = setInterval(() => {
        res.write(BYTES.subarray(sent, sent + step));
        sent += step;
        if (sent >= BYTES.length) { clearInterval(timer); res.end(); }
      }, 30);
      res.on("close", () => clearInterval(timer));
      return true;
    });
    // A clock that never moves: only the push that starts the download.
    const still = installed(true, { now: () => 5_000 });
    await still.module.check();
    await settled(still.module);
    expect(downloading(still.pushes)).toEqual(["Downloading version 1.3.0 (0.0 of 0.3 MB). You can keep chatting."]);
    await still.module.close();
    // No wait between pushes: one per chunk, with the bytes so far. The first copy's folder would be reused.
    fs.rmSync(folder(), { recursive: true });
    const eager = installed(true, { progressMs: 0 });
    await eager.module.check();
    await settled(eager.module);
    const lines = downloading(eager.pushes);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines).toContain("Downloading version 1.3.0 (0.1 of 0.3 MB). You can keep chatting.");
    await eager.module.close();
  });

  const identityOf = (files: { list: Buffer }) => `${VERSION}:${sha512(files.list)}`;
  describe("Restart to update", () => {

    it("IM-01 a copy that can replace its file offers Restart once the download is checked, pinned to the version and the exact list", async () => {
      const files = serveGood();
      const admission = createUpdateAdmission();
      const { module } = installed(true, { restart: "yes", admission });
      await module.check();
      // While it downloads there is nothing to approve.
      expect(module.status()).not.toHaveProperty("approval");
      await settled(module);
      const check = shown(module);
      expect(check).toMatchObject({ download: "ready", restart: true, lines: ["Update 1.3.0 is downloaded and checked."] });
      const approval = module.status().approval;
      expect(typeof approval).toBe("string");
      expect(await module.prepare("an older approval")).toMatchObject({ state: "changed" });
      const prepared = await module.prepare(approval!);
      expect(prepared).toEqual({ state: "ready", reservation: expect.any(String), target: identityOf(files) });
      if (prepared.state !== "ready") throw new Error("not ready");
      expect(admission.installing()).toBe(true);
      expect(module.status()).toMatchObject({ installing: true });
      expect(module.status()).not.toHaveProperty("approval");
      // Another list's identity, or the clone's commit, is not this reservation.
      expect(module.commit({ reservation: prepared.reservation, target: `${VERSION}:${"0".repeat(128)}`, release: "main" })).toEqual({ accepted: false });
      expect(module.commit({ reservation: prepared.reservation, target: prepared.target, release: "main" })).toEqual({ accepted: true, release: "main" });
      // A check while it closes to update reads nothing and deletes nothing.
      expect(await module.check()).toMatchObject({ state: "cannot-check", lines: [UPDATE_PAUSED] });
      expect(fs.readdirSync(folder()).toSorted()).toEqual([FILE, LIST_FILE, SIGNATURE_FILE]);
      expect(module.cancel("main")).toEqual({ cancelled: true });
      expect(admission.installing()).toBe(false);
      await module.close();
    });

    it("after main lets go without quitting, no work is let in before the approval's deadline has passed", async () => {
      serveGood();
      const admission = createUpdateAdmission();
      const { module } = installed(true, { restart: "yes", admission });
      await module.check();
      await settled(module);
      const prepared = await module.prepare(module.status().approval!);
      if (prepared.state !== "ready") throw new Error("not ready");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const main = new AbortController();
        expect(module.commit({ reservation: prepared.reservation, target: prepared.target, release: "main" }, main.signal)).toEqual({ accepted: true, release: "main" });
        main.abort();
        // The program that replaces the file gives the old app this long to close, and goes ahead if it does.
        await vi.advanceTimersByTimeAsync(INSTALLED_APPROVAL_MS - 1);
        expect(() => admission.admit(), "a reply let in now could be cut off by the update").toThrow(UPDATE_PAUSED);
        expect(module.status()).toMatchObject({ installing: true });
        // Past the deadline that program changes nothing, so the app that stayed open takes work again.
        await vi.advanceTimersByTimeAsync(1);
        expect(() => admission.admit()).not.toThrow();
        expect(module.status()).not.toMatchObject({ installing: true });
      } finally { vi.useRealTimers(); }
      await module.close();
    });

    it("IM-02 a copy that cannot replace its file keeps the download, says what to do with it, refuses the click with why, and offers no approval", async () => {
      const PROGRAM = "/apps/Gates-Local-1.2.3-x86_64.AppImage";
      const READY = "Update 1.3.0 is downloaded and checked.";
      const cases = [
        ["read-only", "Gates Local cannot replace its own file because its folder is read-only. Download version 1.3.0 from the release page and replace the file yourself.",
          `${READY} The folder of ${PROGRAM} is read-only, so put the new file in its place yourself.`],
        ["no-permission", "Gates Local cannot replace its own file because you do not have permission to change its folder. Download version 1.3.0 from the release page and replace the file yourself.",
          `${READY} Gates Local has no permission to change the folder of ${PROGRAM}, so put the new file in its place yourself.`],
        ["not-appimage", "Gates Local cannot replace its own file because it was not started from an AppImage file. Download version 1.3.0 from the release page and replace the file yourself.",
          `${READY} This copy was not started from an AppImage file, so put the new file where you keep programs and start it from there.`],
        ["pinned", "This copy keeps its data in a folder set by GATES_LOCAL_DATA_DIR, so it cannot update itself. Download version 1.3.0 from the release page.",
          `${READY} This copy keeps its data in a folder set by GATES_LOCAL_DATA_DIR, so put the new file in place of ${PROGRAM} yourself.`],
      ] as const;
      serveGood();
      for (const [restart, sentence, line] of cases) {
        const { module } = installed(true, { restart, ...(restart === "not-appimage" ? { program: null } : {}) });
        await module.check();
        await settled(module);
        const check = shown(module);
        expect(check).toMatchObject({ download: "ready", lines: [line], page: `${page.base.href}/latest` });
        expect(check).not.toHaveProperty("restart");
        expect(module.status()).not.toHaveProperty("approval");
        expect(await module.prepare("anything")).toEqual({ state: "blocked", message: sentence });
        await module.close();
      }
    });

    describe("on Windows (design section 3, W-A)", () => {
      const WIN = artifactFile(VERSION, "win32");
      const RUNNING = "1.2.3";
      const serveWin = () => {
        const files = listFor(VERSION, BYTES, key.privateKey);
        page.serve(files, { file: WIN, bytes: BYTES });
        return files;
      };
      /** The running version's installer, kept from the update that installed it: a signed list for it and its file. */
      const keepInstaller = (bytes: Buffer = BYTES) => {
        const signed = listFor(RUNNING, BYTES, key.privateKey);
        fs.mkdirSync(folder(RUNNING), { recursive: true });
        fs.writeFileSync(path.join(folder(RUNNING), LIST_FILE), signed.list);
        fs.writeFileSync(path.join(folder(RUNNING), SIGNATURE_FILE), signed.sig);
        fs.writeFileSync(path.join(folder(RUNNING), artifactFile(RUNNING, "win32")), bytes);
        return path.join(folder(RUNNING), artifactFile(RUNNING, "win32"));
      };

      it("IM-W1 offers Restart to update once the download is checked, names the kept installer to go back with, and keeps that installer", async () => {
        const kept = keepInstaller();
        // A version folder no one keeps: cleanup still removes it.
        fs.mkdirSync(folder("1.1.0"), { recursive: true });
        serveWin();
        const { module } = windows();
        await module.check();
        await settled(module);
        await eventually(() => { if (shown(module).restart !== true) throw new Error("no Restart yet"); });
        expect(shown(module)).toMatchObject({
          download: "ready", restart: true,
          lines: ["Update 1.3.0 is downloaded and checked.", `If version 1.3.0 does not start, Gates Local will not go back by itself. To go back, run ${kept}.`],
        });
        expect(typeof module.status().approval).toBe("string");
        expect(fs.readdirSync(path.join(dataDir, "updates")).toSorted()).toEqual([RUNNING, VERSION]);
        expect(fs.existsSync(kept)).toBe(true);
        await module.close();
      });

      it("IM-W2 with no kept installer, or one that does not match its list, sends the person to the running version's release page to go back", async () => {
        for (const prepare of [() => undefined, () => { keepInstaller(Buffer.from("not the installer")); }]) {
          prepare();
          serveWin();
          const { module } = windows();
          await module.check();
          await settled(module);
          await eventually(() => { if (shown(module).restart !== true) throw new Error("no Restart yet"); });
          expect(shown(module).lines).toEqual([
            "Update 1.3.0 is downloaded and checked.",
            `If version 1.3.0 does not start, Gates Local will not go back by itself. To go back, download version 1.2.3 from ${page.base.href}/tag/v1.2.3.`,
          ]);
          await module.close();
        }
      });

      it("IM-W5 while the kept installer is still being checked, a ready download says Restart is coming, never that this copy cannot install it", async () => {
        const kept = keepInstaller();
        serveWin();
        // The kept installer's check (about 122 MB hashed at startup) ends when the test says.
        const gate: { open?: () => void } = {};
        const held = new Promise<void>((resolve) => { gate.open = resolve; });
        const { module, pushes } = windows({ keptInstaller: async (version) => { await held; return verifyKept({ dataDir, running: RUNNING, keys: [key.publicKey], platform: "win32", arch: "x64", version }); } });
        await module.check();
        await settled(module);
        expect(shown(module)).toMatchObject({ download: "ready", restart: false, lines: ["Update 1.3.0 is downloaded and checked."] });
        expect(module.status()).not.toHaveProperty("approval");
        gate.open?.();
        await eventually(() => { if (shown(module).restart !== true) throw new Error("no Restart yet"); });
        expect(shown(module).lines).toEqual(["Update 1.3.0 is downloaded and checked.", `If version 1.3.0 does not start, Gates Local will not go back by itself. To go back, run ${kept}.`]);
        // Settled once: no push ever offered the ready download as one this copy cannot install.
        const ready = pushes.flatMap((s) => (s.lastCheck?.state === "newer" && s.lastCheck.download === "ready" ? [s.lastCheck.restart] : []));
        expect(ready.length).toBeGreaterThan(0);
        expect(ready).not.toContain(undefined);
        expect(ready.at(-1)).toBe(true);
        await module.close();
      });

      it("IM-W3 the click reserves admission for the version and the exact list, as on Linux", async () => {
        const files = serveWin();
        const admission = createUpdateAdmission();
        const { module } = windows({ admission });
        await module.check();
        await settled(module);
        await eventually(() => { if (module.status().approval === undefined) throw new Error("no approval yet"); });
        const prepared = await module.prepare(module.status().approval!);
        expect(prepared).toEqual({ state: "ready", reservation: expect.any(String), target: identityOf(files) });
        await module.close();
      });

      it("IM-W4 switching automatic checks off keeps the running version's installer and the finished download", async () => {
        const kept = keepInstaller();
        serveWin();
        const { module, sw } = windows();
        await module.check();
        await settled(module);
        // Another version's folder, which the switch's cleanup deletes: once it is gone, the cleanup has run.
        fs.mkdirSync(folder("1.0.0"), { recursive: true });
        sw.set(false);
        await eventually(() => { if (fs.existsSync(folder("1.0.0"))) throw new Error("cleanup has not run"); });
        expect(fs.existsSync(folder())).toBe(true);
        expect(fs.existsSync(kept)).toBe(true);
        await module.close();
      });
    });

    it("IM-03 a reply that must finish blocks the click, and new work changes the approval", async () => {
      serveGood();
      let busy: string[] = ["an image job"];
      let activity: string[] = [];
      const { module } = installed(true, { restart: "yes", uninterruptible: () => busy, activity: () => activity });
      await module.check();
      await settled(module);
      const first = module.status().approval!;
      expect(await module.prepare(first)).toEqual({ state: "blocked", message: "Wait for an image job to finish before updating." });
      busy = [];
      activity = ["a reply"];
      expect(module.status().approval).not.toBe(first);
      expect(await module.prepare(first)).toMatchObject({ state: "changed" });
      await module.close();
    });

    it("IM-04 an update startup holds every write until the result carrying its own token, and never removes the result", async () => {
      serveGood();
      const admission = createUpdateAdmission({ finishing: true });
      // The previous launch's note, for another token: not this launch's result.
      writeRecord(dataDir, { at: 1, outcome: "updated", installed: { id: "tx-0", from: "1.2.2", to: "1.2.3", text: "Updated to version 1.2.3.", token: "earlier" } });
      const { module } = installed(true, { restart: "yes", admission, startupToken: "t1" });
      expect(module.status().result).toBeNull();
      expect(admission.finishing()).toBe(true);
      await module.check();
      await settled(module);
      // Nothing to approve while the last update finishes.
      expect(module.status()).not.toHaveProperty("approval");
      expect(await module.prepare("anything")).toEqual({ state: "blocked", message: FINISHING });
      writeRecord(dataDir, { at: 2, outcome: "updated", installed: { id: "tx-1", from: "1.2.2", to: "1.2.3", text: "Updated to version 1.2.3.", token: "t1" } });
      await vi.waitFor(() => expect(admission.finishing()).toBe(false), { timeout: 3_000 });
      expect(module.status().result).toEqual({ at: 2, outcome: "updated", line: "Updated to version 1.2.3." });
      expect(fs.existsSync(path.join(dataDir, RECORD_FILE))).toBe(true);
      // This launch said it, so the next ordinary start does not say it again.
      expect(readRecord(dataDir)?.installed).toMatchObject({ token: "t1", shown: true });
      const next = installed(true, { restart: "yes" });
      expect(next.module.status().result).toBeNull();
      await next.module.close();
      writeRecord(dataDir, { at: 2, outcome: "updated", installed: { id: "tx-1", from: "1.2.2", to: "1.2.3", text: "Updated to version 1.2.3.", token: "t1", shown: true } });
      expect(typeof module.status().approval).toBe("string");
      // Dismissing it ends the note on disk too.
      expect(module.dismissResult()).toEqual({ dismissed: true });
      expect(fs.existsSync(path.join(dataDir, RECORD_FILE))).toBe(false);
      await module.close();
    });

    it("IM-05 an ordinary start shows a result once, keeps a rollback-failed note and its folders until dismissed, and offers nothing until then", async () => {
      fs.mkdirSync(folder("1.2.9"), { recursive: true });
      const failed = { at: 3, outcome: "rollback-failed" as const, installed: { id: "tx-2", from: "1.2.3", to: "1.2.9", text: "Version 1.2.9 did not start, and Gates Local could not go back.", link: true as const, keeps: ["/p/.previous"] } };
      writeRecord(dataDir, failed);
      serveGood();
      const first = installed(true, { restart: "yes" });
      const note = { at: 3, outcome: "rollback-failed", line: failed.installed.text, page: `${page.base.href}/latest` };
      expect(first.module.status().result).toEqual(note);
      await first.module.check();
      await settled(first.module);
      // The cleanup a newer list starts keeps the failed version's folder, and no new update is offered.
      expect(fs.readdirSync(path.join(dataDir, "updates")).toSorted()).toEqual(["1.2.9", "1.3.0"]);
      // The row offers no Restart button while the note is undismissed.
      expect(shown(first.module)).not.toHaveProperty("restart");
      // And says why, once, instead of "downloaded and checked".
      expect(shown(first.module)).toMatchObject({ download: "ready", lines: ["An earlier update did not finish. Read that note and dismiss it before updating again."] });
      expect(first.module.status()).not.toHaveProperty("approval");
      expect(await first.module.prepare("anything")).toEqual({ state: "blocked", message: "An earlier update did not finish. Read that note and dismiss it before updating again." });
      await first.module.close();
      // Still there for the next start.
      const second = installed(true, { restart: "yes" });
      expect(second.module.status().result).toEqual(note);
      expect(second.module.dismissResult()).toEqual({ dismissed: true });
      expect(readRecord(dataDir)).toBeUndefined();
      expect(typeof second.module.status().approval).toBe("undefined");
      await second.module.check();
      expect(typeof second.module.status().approval).toBe("string");
      await second.module.close();
      // A result its token launch already showed is not shown again; any other is shown once.
      writeRecord(dataDir, { at: 4, outcome: "updated", installed: { id: "tx-3", from: "1.2.2", to: "1.2.3", text: "Updated to version 1.2.3.", token: "t1", shown: true } });
      expect(installed(false).module.status().result).toBeNull();
      expect(readRecord(dataDir)).toBeUndefined();
      writeRecord(dataDir, { at: 5, outcome: "rolled-back", installed: { id: "tx-4", from: "1.2.3", to: "1.2.4", text: "Version 1.2.4 did not start, so Gates Local went back to 1.2.3.", token: "t2" } });
      expect(installed(false).module.status().result).toMatchObject({ outcome: "rolled-back", line: "Version 1.2.4 did not start, so Gates Local went back to 1.2.3." });
      expect(installed(false).module.status().result).toBeNull();
    });

    it("IM-06 an ordinary start does not say it was updated to a version other than its own", () => {
      // Windows IU-W2: 1.2.4's desktop turned the click's note into this result, its server died before
      // taking it, and the kept installer put 1.2.3 back. 1.2.3 must not say "Updated to version 1.2.4."
      writeRecord(dataDir, { at: 6, outcome: "updated", installed: { id: "tx-5", from: "1.2.3", to: "1.2.4", text: "Updated to version 1.2.4." } });
      expect(installed(false).module.status().result).toBeNull();
      expect(readRecord(dataDir)).toBeUndefined();
      // Its own version's result is still said once.
      writeRecord(dataDir, { at: 7, outcome: "updated", installed: { id: "tx-6", from: "1.2.2", to: "1.2.3", text: "Updated to version 1.2.3." } });
      expect(installed(false).module.status().result).toEqual({ at: 7, outcome: "updated", line: "Updated to version 1.2.3." });
    });
  });
});
