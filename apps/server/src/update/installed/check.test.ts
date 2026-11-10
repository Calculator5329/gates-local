// Verify and compare: each outcome from a real signed list, the key made here.
import http from "node:http";
import { describe, expect, it } from "vitest";
import { checkInstalled, listUrls } from "./check.ts";
import { boundedGet } from "./feed.ts";
import { BASE, LIST_URL, memoryFeed, releaseKey, SIG_URL, signedList } from "./testing.ts";

const key = releaseKey();
const run = (feed: ReturnType<typeof memoryFeed>, over: { version?: string; keys?: readonly string[]; platform?: string } = {}) =>
  checkInstalled({ version: over.version ?? "1.2.3", platform: over.platform ?? "linux", arch: "x64", keys: over.keys ?? [key.publicKey], base: BASE, get: feed.get, signal: new AbortController().signal });

describe("an installed copy's check", () => {
  it("reads B/latest/download/release.json and its .sig", () => {
    expect(listUrls(BASE)).toEqual({ list: new URL(LIST_URL), signature: new URL(SIG_URL) });
    expect(listUrls(new URL(`${BASE.href}/`)).list.href).toBe(LIST_URL);
    expect(LIST_URL).toBe("https://feed.example.invalid/owner/repo/releases/latest/download/release.json");
  });

  it("makes no request at all with no trusted key", async () => {
    const feed = memoryFeed();
    feed.serve(signedList("2.0.0", ["linux"], key.privateKey));
    expect(await run(feed, { keys: [] })).toEqual({ kind: "no-key" });
    expect(feed.reads).toEqual([]);
  });

  it.each(["0.0.0-dev", "1.2", "v1.2.3", "1.2.3-rc.1", ""])("does not check a development build (%s)", async (version) => {
    const feed = memoryFeed();
    expect(await run(feed, { version })).toEqual({ kind: "development" });
    expect(feed.reads).toEqual([]);
  });

  it("finds a newer version with this copy's installer", async () => {
    const feed = memoryFeed();
    feed.serve(signedList("1.3.0", ["linux", "win32"], key.privateKey));
    expect(await run(feed)).toMatchObject({ kind: "newer", target: "1.3.0", artifact: { platform: "linux", arch: "x64", file: "Gates-Local-1.3.0-x86_64.AppImage" } });
    expect(await run(feed, { platform: "win32" })).toMatchObject({ kind: "newer", target: "1.3.0", artifact: { platform: "win32", file: "Gates-Local-1.3.0-Setup-x64.exe" } });
    expect(feed.reads).toEqual([LIST_URL, SIG_URL, LIST_URL, SIG_URL]);
  });

  it("finds a newer version with no installer for this copy", async () => {
    const feed = memoryFeed();
    feed.serve(signedList("1.10.0", ["win32"], key.privateKey));
    expect(await run(feed)).toEqual({ kind: "newer", target: "1.10.0" });
  });

  it.each(["1.2.3", "1.2.2", "0.9.9"])("finds nothing newer in a list at %s", async (listed) => {
    const feed = memoryFeed();
    feed.serve(signedList(listed, ["linux"], key.privateKey));
    expect(await run(feed)).toEqual({ kind: "none-found", listed });
  });

  it("ignores a list signed by a key this build does not trust", async () => {
    const feed = memoryFeed();
    feed.serve(signedList("9.0.0", ["linux"], releaseKey().privateKey));
    expect(await run(feed)).toEqual({ kind: "bad-signature", detail: "release signature does not match a trusted public key" });
  });

  it("checks the signature before reading a single field", async () => {
    const feed = memoryFeed();
    const good = signedList("9.0.0", ["linux"], key.privateKey);
    feed.serve({ list: Buffer.from(good.list.toString().replace("9.0.0", "9.0.1")), sig: good.sig });
    expect(await run(feed)).toMatchObject({ kind: "bad-signature" });
  });

  it("ignores a list whose signature is missing or too large, and one too large to verify", async () => {
    const feed = memoryFeed();
    const good = signedList("9.0.0", ["linux"], key.privateKey);
    feed.answer(LIST_URL, { kind: "ok", bytes: good.list });
    feed.answer(SIG_URL, { kind: "missing" });
    expect(await run(feed)).toMatchObject({ kind: "bad-signature", detail: "release.json.sig is missing" });
    feed.answer(SIG_URL, { kind: "too-large" });
    expect(await run(feed)).toMatchObject({ kind: "bad-signature" });
    feed.answer(LIST_URL, { kind: "too-large" });
    expect(await run(feed)).toMatchObject({ kind: "bad-signature", detail: "release.json is larger than 65536 bytes" });
  });

  it("says when there is no list, and when the server could not be reached", async () => {
    const feed = memoryFeed({ [LIST_URL]: { kind: "missing" } });
    expect(await run(feed)).toEqual({ kind: "no-list" });
    expect(feed.reads).toEqual([LIST_URL]);
    expect(await run(memoryFeed())).toEqual({ kind: "unreachable", detail: "connection refused" });
    const sigDown = memoryFeed({ [LIST_URL]: { kind: "ok", bytes: Buffer.from("{}") } });
    expect(await run(sigDown)).toEqual({ kind: "unreachable", detail: "connection refused" });
  });

  it("gives the list and its signature one time budget between them", async () => {
    // Each answer comes after 250 ms, well inside a 400 ms budget; both together do not fit.
    const files = signedList("1.3.0", ["linux"], key.privateKey);
    const server = http.createServer((req, res) => {
      const body = req.url?.endsWith(".sig") === true ? files.sig : files.list;
      const timer = setTimeout(() => res.writeHead(200).end(body), 250);
      res.on("close", () => clearTimeout(timer));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      const options = { version: "1.2.3", platform: "linux", arch: "x64", keys: [key.publicKey], base: new URL(`http://127.0.0.1:${address.port}/r`), get: boundedGet({ allowLoopbackHttp: true }), signal: new AbortController().signal };
      const started = Date.now();
      expect(await checkInstalled({ ...options, totalMs: 400 })).toEqual({ kind: "unreachable", detail: "the check took longer than 0.4 seconds" });
      expect(Date.now() - started).toBeLessThan(600);
      // The same feed inside a budget that fits both reads.
      expect(await checkInstalled({ ...options, totalMs: 2_000 })).toMatchObject({ kind: "newer", target: "1.3.0" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
