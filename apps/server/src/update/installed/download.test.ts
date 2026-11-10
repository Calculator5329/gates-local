// The verified download into <data dir>/updates/<version>/, against a real
// loopback release page and real signed lists (keys made in memory here).
// Temporary data folders live under ~/.cache and are removed after each test.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DownloadOptions, downloadRelease, fileIn, freeSpace, LIST_FILE, preparedRelease, removeVersions, SIGNATURE_FILE, verifyPrepared, versionFolder } from "./download.ts";
import { streamGet } from "./feed.ts";
import { artifactFile, listFor, releaseKey, releasePage, type ReleasePage, sha512 } from "./testing.ts";

const key = releaseKey();
// Read once: some tests below pretend to be Windows.
const platform = process.platform;
const VERSION = "1.3.0";
const FILE = artifactFile(VERSION);
const ARTIFACT_PATH = `/r/download/v${VERSION}/${FILE}`;
const BYTES = randomBytes(200_000);

let dataDir: string;
let page: ReleasePage;
beforeEach(async () => {
  const cache = path.join(homedir(), ".cache");
  fs.mkdirSync(cache, { recursive: true });
  dataDir = fs.mkdtempSync(path.join(cache, "installed-download-test-"));
  page = await releasePage();
});
afterEach(async () => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", { value: platform });
  await page.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const identity = () => ({ dataDir, running: "1.2.3", keys: [key.publicKey], platform: "linux", arch: "x64" });
const plenty = () => Promise.resolve({ volume: "/data", free: 10 ** 12 });
const good = () => listFor(VERSION, BYTES, key.privateKey);
function options(files = good(), over: Partial<DownloadOptions> = {}): DownloadOptions {
  return {
    ...identity(), base: page.base, version: VERSION, list: files.list, signature: files.sig,
    stream: streamGet({ allowLoopbackHttp: true, idleMs: 2_000 }), signal: new AbortController().signal, freeSpace: plenty, ...over,
  };
}
const folder = () => path.join(dataDir, "updates", VERSION);
const inFolder = () => fs.readdirSync(folder()).toSorted();
const artifactRequests = () => page.requests.filter((p) => p === ARTIFACT_PATH).length;
/** A folder as a finished download leaves it, written here without a request. */
function complete(files = good(), bytes = BYTES, at = folder()): void {
  fs.mkdirSync(at, { recursive: true });
  fs.writeFileSync(path.join(at, LIST_FILE), files.list);
  fs.writeFileSync(path.join(at, SIGNATURE_FILE), files.sig);
  fs.writeFileSync(path.join(at, FILE), bytes);
}
/** Headers and the first bytes, then silence the test ends: a download in flight. */
function holdAfter(bytes: number): void {
  page.route((p, res) => {
    if (p !== ARTIFACT_PATH) return false;
    res.writeHead(200, { "Content-Length": BYTES.length });
    res.write(BYTES.subarray(0, bytes));
    return true;
  });
}

describe("downloading a version", () => {
  it("lands the artifact with the exact list and signature beside it, written first and renamed last", async () => {
    const files = good();
    page.serve(files, { file: FILE, bytes: BYTES });
    let atRequest: string[] = [];
    let listAtRequest: Buffer | undefined;
    let sigAtRequest: Buffer | undefined;
    page.route((p) => {
      if (p === ARTIFACT_PATH) {
        atRequest = inFolder();
        listAtRequest = fs.readFileSync(path.join(folder(), LIST_FILE));
        sigAtRequest = fs.readFileSync(path.join(folder(), SIGNATURE_FILE));
      }
      return false;
    });
    const outcome = await downloadRelease(options(files));
    // When the artifact was asked for, the list and signature were already there, the file only as .part.
    expect(atRequest).toEqual([`${FILE}.part`, LIST_FILE, SIGNATURE_FILE]);
    expect(listAtRequest?.equals(files.list)).toBe(true);
    expect(sigAtRequest?.equals(files.sig)).toBe(true);
    expect(inFolder()).toEqual([FILE, LIST_FILE, SIGNATURE_FILE]);
    expect(sha512(fs.readFileSync(path.join(folder(), FILE)))).toBe(sha512(BYTES));
    expect(outcome).toMatchObject({ kind: "ready", fetched: true, prepared: { version: VERSION, file: path.join(folder(), FILE), listSha512: sha512(files.list), artifact: { size: BYTES.length } } });
    expect(page.requests).toEqual([ARTIFACT_PATH]);
  });

  it("reads the artifact from B/download/v<version>/<file>, with no query and the copy's own name", async () => {
    const seen: string[] = [];
    page.serve(good(), { file: FILE, bytes: BYTES });
    page.route((p, res) => { seen.push(res.req.headers["user-agent"] ?? ""); return false; });
    await downloadRelease(options());
    expect(page.requests).toEqual([ARTIFACT_PATH]);
    expect(seen).toEqual(["Gates-Local"]);
  });

  it("stops reading one byte past the listed size, though the server offers far more", async () => {
    const offered = { bytes: 0 };
    page.route((p, res) => {
      if (p !== ARTIFACT_PATH) return false;
      // No length declared: only counting what arrives can stop it.
      res.writeHead(200);
      const chunk = Buffer.alloc(16 * 1024, 1);
      const pump = () => {
        while (offered.bytes < 50_000_000 && !res.destroyed && res.write(chunk)) offered.bytes += chunk.length;
        if (offered.bytes < 50_000_000 && !res.destroyed) res.once("drain", pump);
      };
      pump();
      return true;
    });
    const outcome = await downloadRelease(options());
    expect(outcome).toMatchObject({ kind: "bad-download" });
    const received = outcome.kind === "bad-download" ? outcome.received : 0;
    // Taken: past the size by at most one chunk the socket handed over.
    expect(received).toBeGreaterThan(BYTES.length);
    expect(received).toBeLessThanOrEqual(BYTES.length + 64 * 1024);
    await page.hangUps[0];
    expect(offered.bytes).toBeLessThan(10_000_000);
    expect(fs.existsSync(folder())).toBe(false);
  });

  it("refuses a declared length one byte over the listed size before reading any of it", async () => {
    page.route((p, res) => {
      if (p !== ARTIFACT_PATH) return false;
      res.writeHead(200, { "Content-Length": BYTES.length + 1 });
      res.flushHeaders();
      return true;
    });
    expect(await downloadRelease(options())).toMatchObject({ kind: "bad-download", received: 0 });
    await page.hangUps[0];
    expect(fs.existsSync(folder())).toBe(false);
  });

  it("deletes a file with the right size and the wrong hash, and calls it a bad download", async () => {
    const files = listFor(VERSION, BYTES, key.privateKey, { sha512: sha512(Buffer.from("another file")) });
    page.serve(files, { file: FILE, bytes: BYTES });
    const renames = vi.spyOn(fs.promises, "rename");
    const removes = vi.spyOn(fs.promises, "rm");
    expect(await downloadRelease(options(files))).toMatchObject({ kind: "bad-download", received: BYTES.length, detail: "the file's SHA-512 does not match the signed list" });
    // Caught while streaming: the .part never became the file.
    expect(renames).not.toHaveBeenCalled();
    expect(fs.existsSync(folder())).toBe(false);
    // A scanner holding the fresh .part for a moment must not turn "did not match" into "could not download".
    expect(removes).toHaveBeenCalledWith(folder(), expect.objectContaining({ recursive: true, force: true, maxRetries: 3 }));
  });

  it("deletes a file that ends short of the listed size", async () => {
    const files = listFor(VERSION, BYTES, key.privateKey, { size: BYTES.length + 10 });
    page.serve(files, { file: FILE, bytes: BYTES });
    expect(await downloadRelease(options(files))).toMatchObject({ kind: "bad-download" });
    expect(fs.existsSync(folder())).toBe(false);
  });

  it("says it could not download when the server fails, and keeps nothing", async () => {
    page.serve(good());
    expect(await downloadRelease(options())).toMatchObject({ kind: "could-not-download", detail: "the server has no such file" });
    expect(fs.existsSync(folder())).toBe(false);
  });

  it("gives up on a server that trickles below the minimum rate", async () => {
    page.route((p, res) => {
      if (p !== ARTIFACT_PATH) return false;
      res.writeHead(200, { "Content-Length": BYTES.length });
      let sent = 0;
      const timer = setInterval(() => { res.write(BYTES.subarray(sent, sent + 1)); sent++; }, 20);
      res.on("close", () => clearInterval(timer));
      return true;
    });
    const outcome = await downloadRelease(options(good(), { slowest: { windowMs: 300, bytes: 1_000 } }));
    expect(outcome).toEqual({ kind: "could-not-download", detail: "the download was slower than 1000 bytes in 0.3 seconds" });
    await page.hangUps[0];
    expect(fs.existsSync(folder())).toBe(false);
  });

  it.each([
    ["holding a .part", () => { complete(); fs.writeFileSync(path.join(folder(), `${FILE}.part`), "x"); }],
    ["with no list", () => { complete(); fs.rmSync(path.join(folder(), LIST_FILE)); fs.writeFileSync(path.join(folder(), "stale"), "x"); }],
    ["with no signature", () => { complete(); fs.rmSync(path.join(folder(), SIGNATURE_FILE)); }],
  ])("deletes a folder %s and downloads it again", async (_name, prepare) => {
    prepare();
    expect(await preparedRelease({ ...identity(), version: VERSION, list: good().list })).toMatchObject({ ok: false });
    expect(fs.existsSync(folder())).toBe(false);
    prepare();
    page.serve(good(), { file: FILE, bytes: BYTES });
    expect(await downloadRelease(options())).toMatchObject({ kind: "ready", fetched: true });
    expect(artifactRequests()).toBe(1);
    expect(inFolder()).toEqual([FILE, LIST_FILE, SIGNATURE_FILE]);
  });

  it("trusts a complete folder only after checking it again, and then makes no request", async () => {
    complete();
    expect(await preparedRelease({ ...identity(), version: VERSION, list: good().list })).toMatchObject({ ok: true, prepared: { version: VERSION } });
    expect(await downloadRelease(options())).toMatchObject({ kind: "ready", fetched: false });
    expect(page.requests).toEqual([]);
  });

  it("does not call a complete folder ready once its artifact changed on disk, and deletes it", async () => {
    page.serve(good(), { file: FILE, bytes: BYTES });
    expect(await downloadRelease(options())).toMatchObject({ kind: "ready" });
    const changed = Buffer.from(BYTES);
    changed[1000] = (changed[1000] ?? 0) ^ 1;
    fs.writeFileSync(path.join(folder(), FILE), changed);
    expect(await verifyPrepared({ ...identity(), version: VERSION })).toEqual({ ok: false, reason: "the downloaded file does not match the signed release list" });
    expect(fs.existsSync(folder())).toBe(false);
  });

  it("downloads again over a complete folder whose artifact changed on disk", async () => {
    const changed = Buffer.from(BYTES);
    changed[0] = (changed[0] ?? 0) ^ 1;
    complete(good(), changed);
    page.serve(good(), { file: FILE, bytes: BYTES });
    expect(await downloadRelease(options())).toMatchObject({ kind: "ready", fetched: true });
    expect(artifactRequests()).toBe(1);
    expect(sha512(fs.readFileSync(path.join(folder(), FILE)))).toBe(sha512(BYTES));
  });

  it.each([
    ["signed by a key this build does not trust", () => complete(listFor(VERSION, BYTES, releaseKey().privateKey)), "1.2.3"],
    ["for the version already running", () => complete(), VERSION],
    ["for an older version", () => complete(), "2.0.0"],
    ["holding a list for another version", () => complete(listFor("1.4.0", BYTES, key.privateKey)), "1.2.3"],
  ])("does not trust a complete folder %s, and deletes it", async (_name, prepare, running) => {
    prepare();
    expect(await verifyPrepared({ ...identity(), running, version: VERSION })).toMatchObject({ ok: false });
    expect(fs.existsSync(folder())).toBe(false);
  });

  it("downloads again over a complete folder that holds an earlier signed list for this version", async () => {
    complete();
    const other = randomBytes(BYTES.length);
    const files = listFor(VERSION, other, key.privateKey);
    page.serve(files, { file: FILE, bytes: other });
    expect(await downloadRelease(options(files))).toMatchObject({ kind: "ready", fetched: true });
    expect(artifactRequests()).toBe(1);
    expect(sha512(fs.readFileSync(path.join(folder(), FILE)))).toBe(sha512(other));
    expect(fs.readFileSync(path.join(folder(), LIST_FILE)).equals(files.list)).toBe(true);
  });

  it("finds nothing prepared when there is no folder", async () => {
    expect(await preparedRelease({ ...identity(), version: VERSION, list: good().list })).toBeNull();
  });
});

/** A symbolic link, or a skip where this platform will not make one (Windows without the privilege). */
function link(target: string, at: string, type: "file" | "junction", skip: () => void): void {
  try { fs.symlinkSync(target, at, type); }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EPERM") skip();
    throw error;
  }
}

describe("links in the folder", () => {
  it("does not call an artifact that is a link ready, deletes it, and leaves the link's target alone", async (ctx) => {
    complete();
    const outside = path.join(dataDir, "elsewhere.AppImage");
    fs.writeFileSync(outside, BYTES);
    fs.rmSync(path.join(folder(), FILE));
    link(outside, path.join(folder(), FILE), "file", () => ctx.skip());
    expect(await verifyPrepared({ ...identity(), version: VERSION })).toEqual({ ok: false, reason: "the downloaded file is not a regular file" });
    expect(fs.existsSync(folder())).toBe(false);
    expect(sha512(fs.readFileSync(outside))).toBe(sha512(BYTES));
  });

  it("does not call a version folder that is a link ready, deletes only the link, then downloads into a real folder", async (ctx) => {
    const elsewhere = path.join(dataDir, "elsewhere");
    complete(good(), BYTES, elsewhere);
    fs.mkdirSync(path.join(dataDir, "updates"));
    link(elsewhere, folder(), "junction", () => ctx.skip());
    expect(await preparedRelease({ ...identity(), version: VERSION, list: good().list })).toEqual({ ok: false, reason: "the version folder is not a real folder" });
    expect(() => fs.lstatSync(folder())).toThrow();
    expect(fs.readdirSync(elsewhere).toSorted()).toEqual([FILE, LIST_FILE, SIGNATURE_FILE]);
    expect(sha512(fs.readFileSync(path.join(elsewhere, FILE)))).toBe(sha512(BYTES));
    fs.symlinkSync(elsewhere, folder(), "junction");
    page.serve(good(), { file: FILE, bytes: BYTES });
    expect(await downloadRelease(options())).toMatchObject({ kind: "ready", fetched: true });
    expect(fs.lstatSync(folder()).isDirectory()).toBe(true);
    expect(artifactRequests()).toBe(1);
  });

  it.each(["../x", "..", ".", "", "a/b"])("refuses the listed file name %j, which is not a plain name inside the folder", (name) => {
    expect(() => fileIn(folder(), name)).toThrow("the release list names a file outside its folder");
  });
});

describe("disk space", () => {
  it("makes no artifact request when the volume has too little free space", async () => {
    page.serve(good(), { file: FILE, bytes: BYTES });
    const outcome = await downloadRelease(options(good(), { freeSpace: () => Promise.resolve({ volume: "/data", free: BYTES.length - 1 }) }));
    expect(outcome).toEqual({ kind: "disk", volume: "/data", needed: BYTES.length, free: BYTES.length - 1 });
    expect(page.requests).toEqual([]);
    expect(fs.existsSync(folder())).toBe(false);
  });

  it("ends a write that finds no space left like too little space, with the partial file deleted", async () => {
    page.serve(good(), { file: FILE, bytes: BYTES });
    const spaces = [{ volume: "/data", free: 10 ** 9 }, { volume: "/data", free: 4096 }];
    // The .part file's handle takes one chunk, then the disk is full.
    const open = fs.promises.open;
    vi.spyOn(fs.promises, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await open(file, flags, mode);
      if (!String(file).endsWith(".part")) return handle;
      const write = handle.write.bind(handle);
      let writes = 0;
      Object.defineProperty(handle, "write", {
        value: (bytes: Uint8Array, offset: number, length: number, position: number) => ++writes > 1
          ? Promise.reject(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }))
          : write(bytes, offset, length, position),
      });
      return handle;
    });
    const outcome = await downloadRelease(options(good(), { freeSpace: () => Promise.resolve(spaces.shift() ?? { volume: "/data", free: 0 }) }));
    expect(outcome).toEqual({ kind: "disk", volume: "/data", needed: BYTES.length, free: 4096 });
    expect(fs.existsSync(folder())).toBe(false);
  });

  it("reads the free space and names the volume of a real folder", async () => {
    const space = await freeSpace(dataDir);
    expect(space.free).toBeGreaterThan(0);
    expect(space.volume).not.toBe("");
    expect(dataDir.startsWith(space.volume)).toBe(true);
  });
});

describe("cancelling", () => {
  it("an abort ends a download in flight, hangs up and leaves no folder", async () => {
    page.serve(good());
    holdAfter(1000);
    const controller = new AbortController();
    const pending = downloadRelease(options(good(), { signal: controller.signal }));
    await vi.waitFor(() => expect(page.hangUps).toHaveLength(1));
    controller.abort(new Error("switched off"));
    expect(await pending).toEqual({ kind: "cancelled" });
    await page.hangUps[0];
    expect(fs.existsSync(folder())).toBe(false);
  });
});

describe("the folder's place", () => {
  it.each(["../x", "..", "1.2.3/../../x", "1.2.3/..", "1.2", "01.2.3", "1.2.3 ", "1.2.3-rc.1", "C:\\x", "1.2.3\\..\\..", ""])("refuses the version %j before any file call", async (bad) => {
    const names = ["rm", "mkdir", "open", "readFile", "writeFile", "readdir", "stat", "lstat", "rename", "statfs", "access"] as const;
    const spies = names.map((name) => vi.spyOn(fs.promises, name));
    expect(() => versionFolder(dataDir, bad)).toThrow(/not major\.minor\.patch/);
    expect(await verifyPrepared({ ...identity(), version: bad })).toMatchObject({ ok: false });
    expect(await preparedRelease({ ...identity(), version: bad, list: good().list })).toMatchObject({ ok: false });
    expect(await downloadRelease(options(good(), { version: bad }))).toMatchObject({ kind: "could-not-download" });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    // Cleanup never lists a refused name as a folder to keep or delete.
    await expect(removeVersions(dataDir, [bad])).resolves.toEqual([]);
    expect(page.requests).toEqual([]);
  });

  it("deletes only other versions' folders under updates/, and never a kept one", async () => {
    const updates = path.join(dataDir, "updates");
    for (const v of ["1.0.0", "1.1.0", "1.3.0"]) complete(good(), BYTES, path.join(updates, v));
    fs.mkdirSync(path.join(updates, "notes"));
    fs.writeFileSync(path.join(updates, "installed-update.json"), "{}");
    fs.writeFileSync(path.join(dataDir, "beside.txt"), "x");
    expect(await removeVersions(dataDir, ["1.1.0", "1.3.0"])).toEqual(["1.0.0"]);
    expect(fs.readdirSync(updates).toSorted()).toEqual(["1.1.0", "1.3.0", "installed-update.json", "notes"]);
    expect(fs.existsSync(path.join(dataDir, "beside.txt"))).toBe(true);
    expect(await removeVersions(dataDir, ["1.1.0"])).toEqual(["1.3.0"]);
    expect(fs.readdirSync(updates).toSorted()).toEqual(["1.1.0", "installed-update.json", "notes"]);
  });

  it("does nothing when there is no updates folder", async () => {
    expect(await removeVersions(dataDir, [])).toEqual([]);
  });
});

describe("the final rename", () => {
  it.each(["EPERM", "EACCES", "EBUSY"])("on Windows, tries a rename refused with %s again", async (code) => {
    Object.defineProperty(process, "platform", { value: "win32" });
    page.serve(good(), { file: FILE, bytes: BYTES });
    const rename = fs.promises.rename;
    let refusals = 2;
    const calls = vi.spyOn(fs.promises, "rename").mockImplementation((from, to) => {
      if (refusals-- > 0) return Promise.reject(Object.assign(new Error(`${code}: refused, rename`), { code }));
      return rename(from, to);
    });
    expect(await downloadRelease(options())).toMatchObject({ kind: "ready" });
    expect(calls).toHaveBeenCalledTimes(3);
    expect(inFolder()).toEqual([FILE, LIST_FILE, SIGNATURE_FILE]);
  });

  it("on Windows, a rename still refused after two seconds fails the download and deletes it", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    page.serve(good(), { file: FILE, bytes: BYTES });
    const calls = vi.spyOn(fs.promises, "rename").mockRejectedValue(Object.assign(new Error("EPERM: refused, rename"), { code: "EPERM" }));
    const started = Date.now();
    expect(await downloadRelease(options())).toMatchObject({ kind: "could-not-download" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
    expect(Date.now() - started).toBeLessThan(3_500);
    expect(calls.mock.calls.length).toBeGreaterThan(2);
    expect(fs.existsSync(folder())).toBe(false);
  }, 10_000);

  it.each(["linux", "darwin"])("on %s, a refused rename is a real permission problem and is not waited on", async (pretend) => {
    Object.defineProperty(process, "platform", { value: pretend });
    page.serve(good(), { file: FILE, bytes: BYTES });
    const calls = vi.spyOn(fs.promises, "rename").mockRejectedValue(Object.assign(new Error("EPERM: refused, rename"), { code: "EPERM" }));
    const started = Date.now();
    expect(await downloadRelease(options())).toMatchObject({ kind: "could-not-download" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(folder())).toBe(false);
  });
});
