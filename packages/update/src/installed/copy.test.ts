// The installed copy's shared pieces: the test-build gate on the feed and the
// download's words.
import { describe, expect, it, vi } from "vitest";
import { TRUSTED_RELEASE_KEYS } from "../release-manifest.ts";
import { DEFAULT_FEED, downloadLines, installedFeed } from "./copy.ts";
import { releaseKey } from "./testing.ts";

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
  });

  it("a plain build trusts the source list's keys and nothing from its environment", () => {
    expect(TRUSTED_RELEASE_KEYS.length).toBeGreaterThan(0);
    expect(installedFeed({}, { testBuild: false }).keys).toEqual([...TRUSTED_RELEASE_KEYS]);
    expect(installedFeed({ GATES_LOCAL_UPDATE_TEST_KEYS: testKey }, { testBuild: false }).keys).toEqual([...TRUSTED_RELEASE_KEYS]);
  });
});

describe("the download's words", () => {
  const PROGRAM = "/apps/Gates-Local-1.2.3-x86_64.AppImage";
  it("says each state in Settings' words", () => {
    expect(downloadLines("1.3.0", { state: "downloading", received: 12_345_678, total: 98_765_432 })).toEqual(["Downloading version 1.3.0 (12 of 99 MB). You can keep chatting."]);
    expect(downloadLines("1.3.0", { state: "downloading", received: 1_250_000, total: 4_000_000 })).toEqual(["Downloading version 1.3.0 (1.2 of 4.0 MB). You can keep chatting."]);
    expect(downloadLines("1.3.0", { state: "bad" })).toEqual(["The download of version 1.3.0 did not match the signed release list, so it was deleted."]);
    expect(downloadLines("1.3.0", { state: "failed" })).toEqual(["Could not download version 1.3.0. Check your connection."]);
    expect(downloadLines("1.3.0", { state: "disk", volume: "/home", needed: 98_100_000, free: 97_900_000 })).toEqual(["Not enough free space on /home for version 1.3.0 (needs 99 MB, 97 MB free). Free some space, then use Check for updates."]);
    // A copy that cannot install it keeps the file and says, in one line, why and what to do with it.
    // On Linux the sentence names the running file when there is one to put the download in place of.
    expect(downloadLines("1.3.0", { state: "ready" }, "no-permission", undefined, "linux", PROGRAM)).toEqual([`Update 1.3.0 is downloaded and checked. Gates Local has no permission to change the folder of ${PROGRAM}, so put the new file in its place yourself.`]);
    expect(downloadLines("1.3.0", { state: "ready" }, "read-only", undefined, "linux", PROGRAM)).toEqual([`Update 1.3.0 is downloaded and checked. The folder of ${PROGRAM} is read-only, so put the new file in its place yourself.`]);
    expect(downloadLines("1.3.0", { state: "ready" }, "not-appimage", undefined, "linux")).toEqual(["Update 1.3.0 is downloaded and checked. This copy was not started from an AppImage file, so put the new file where you keep programs and start it from there."]);
    expect(downloadLines("1.3.0", { state: "ready" }, "download-folder", undefined, "linux", PROGRAM)).toEqual(["Update 1.3.0 is downloaded and checked. This copy runs from its download folder, so put the new file where you keep programs and start it from there."]);
    expect(downloadLines("1.3.0", { state: "ready" }, "pinned", undefined, "linux", PROGRAM)).toEqual([`Update 1.3.0 is downloaded and checked. This copy keeps its data in a folder set by GATES_LOCAL_DATA_DIR, so put the new file in place of ${PROGRAM} yourself.`]);
    expect(downloadLines("1.3.0", { state: "ready" }, "none", undefined, "win32")).toEqual(["Update 1.3.0 is downloaded and checked. Run this installer to update."]);
    expect(downloadLines("1.3.0", { state: "ready" }, "pinned", undefined, "win32")).toEqual(["Update 1.3.0 is downloaded and checked. Run this installer to update."]);
  });
});
