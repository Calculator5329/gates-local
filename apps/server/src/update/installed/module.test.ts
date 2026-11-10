// The installed module: every sentence of Settings' table from a real signed
// list, the status and refusals it answers, the test-build gate, and the
// composition that keeps the clone updater when the desktop says nothing.
import http from "node:http";
import { decodeResult, type UpdateCheck } from "@gates-local/contracts";
import { describe, expect, it, vi } from "vitest";
import type { UpdateModule } from "../module.ts";
import { chooseUpdateModule, createInstalledUpdateModule, DEFAULT_FEED, INSTALL_REFUSAL, installedFeed, type InstalledFeed } from "./module.ts";
import { BASE, LIST_URL, memoryFeed, releaseKey, SIG_URL, signedList } from "./testing.ts";

const key = releaseKey();
const PAGE = `${BASE.href}/latest`;
const feedWith = (keys: readonly string[]): InstalledFeed => ({ base: BASE, page: PAGE, keys, allowLoopbackHttp: false });

function copy(o: { version?: string; keys?: readonly string[]; feed?: ReturnType<typeof memoryFeed> } = {}) {
  const feed = o.feed ?? memoryFeed();
  const changed = vi.fn();
  const module = createInstalledUpdateModule({
    version: o.version ?? "1.2.3", platform: "linux", arch: "x64",
    feed: feedWith(o.keys ?? [key.publicKey]), get: feed.get,
    now: () => 1_000, changed,
  });
  return { module, feed, changed };
}

/** The check's words as Settings shows them, after it decoded off the wire. */
async function words(module: UpdateModule): Promise<{ lines: readonly string[]; page?: string; state: UpdateCheck["state"] }> {
  const check = await module.check();
  const decoded = decodeResult("update.check", check);
  if (!decoded.ok) throw new Error(`does not decode: ${JSON.stringify(check)}`);
  const status = decodeResult("update.status", module.status());
  if (!status.ok) throw new Error("status does not decode");
  const c = decoded.value;
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
    expect(module.commit({ reservation: "r", targetCommit: "0".repeat(40), release: "x" })).toEqual({ accepted: false });
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
    expect(await words(module)).toEqual({ state: "newer", lines: ["Version 1.3.0 is available. Download it from the release page."], page: PAGE });
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
  // switch (apps/web/test/updates.test.ts), never baked in here.
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

  it("stops the read on close", async () => {
    let seen: AbortSignal | undefined;
    const module = createInstalledUpdateModule({
      version: "1.2.3", platform: "linux", arch: "x64", feed: feedWith([key.publicKey]),
      get: (_url, _max, signal) => { seen = signal; return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ kind: "failed", detail: "stopped" }))); },
    });
    const pending = module.check();
    await vi.waitFor(() => expect(seen).toBeDefined());
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
        version: "1.2.3", platform: "linux", arch: "x64",
        feed: { base, page: `${base.href}/latest`, keys: [key.publicKey], allowLoopbackHttp: true },
      });
      const pending = module.check();
      await vi.waitFor(() => expect(hungUp).toHaveLength(1));
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

describe("the test-build gate", () => {
  const testKey = releaseKey().publicKey;
  const env = { GATES_LOCAL_UPDATE_FEED: "http://127.0.0.1:43123", GATES_LOCAL_UPDATE_TEST_KEYS: testKey };

  it("a copy without the marker ignores the test keys and a loopback feed", () => {
    const log = vi.fn();
    expect(installedFeed(env, { testBuild: false, trusted: [], log })).toEqual({ base: DEFAULT_FEED, page: `${DEFAULT_FEED.href}/latest`, keys: [], allowLoopbackHttp: false });
    expect(log).toHaveBeenCalledWith("GATES_LOCAL_UPDATE_FEED names a http: address (only https is read); using the release page");
  });

  it("a test build reads both", () => {
    expect(installedFeed(env, { testBuild: true, trusted: [] })).toEqual({ base: new URL("http://127.0.0.1:43123"), page: "http://127.0.0.1:43123/latest", keys: [testKey], allowLoopbackHttp: true });
  });

  it("a test build still refuses http that is not loopback, and a bad key", () => {
    const log = vi.fn();
    expect(installedFeed({ GATES_LOCAL_UPDATE_FEED: "http://feed.example.invalid", GATES_LOCAL_UPDATE_TEST_KEYS: "not-a-key" }, { testBuild: true, trusted: [], log })).toMatchObject({ base: DEFAULT_FEED, keys: [] });
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("any copy takes an https feed without a query, and keeps the built-in keys", () => {
    expect(installedFeed({ GATES_LOCAL_UPDATE_FEED: "https://mirror.example.invalid/r" }, { testBuild: false, trusted: ["K"] })).toEqual({ base: new URL("https://mirror.example.invalid/r"), page: "https://mirror.example.invalid/r/latest", keys: ["K"], allowLoopbackHttp: false });
    expect(installedFeed({ GATES_LOCAL_UPDATE_FEED: "https://mirror.example.invalid/r?x=1" }, { testBuild: false, trusted: [] }).base).toEqual(DEFAULT_FEED);
  });

  it("the default feed is the public repository's release pages", () => {
    expect(DEFAULT_FEED.href).toMatch(/^https:\/\/github\.com\/[^/]+\/gates-local\/releases$/);
    expect(installedFeed({}, { testBuild: false }).keys).toEqual([]);
  });
});

const stub = (name: string): UpdateModule => createInstalledUpdateModule({ version: name, platform: "linux", arch: "x64", feed: feedWith([]) });

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
