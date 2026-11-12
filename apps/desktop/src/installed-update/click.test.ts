// Row H in the old main, after the admission commit: re-verify the download
// against the approved target, build the approval, begin, quit. Every refusal
// has its sentence, and nothing is written or spawned on one.
import { describe, expect, it } from "vitest";
import type { Verified } from "../../../server/src/update/installed/download.ts";
import type { ReleaseArtifact } from "../../../server/src/update/release-manifest.ts";
import { startInstalledUpdate, type InstalledClick } from "./click.ts";
import type { Approval } from "./transaction.ts";
import type { Begin } from "./watch.ts";

const DIGEST = "a".repeat(128);
const TARGET = `1.3.0:${DIGEST}`;
const artifact = { platform: "linux", arch: "x64", kind: "appimage", file: "G-1.3.0.AppImage", size: 10, sha512: "b".repeat(128) } as unknown as ReleaseArtifact;
const verified = (listSha512 = DIGEST): Verified => ({ ok: true, prepared: { version: "1.3.0", folder: "/d/updates/1.3.0", file: "/d/updates/1.3.0/G", artifact, manifest: {} as never, listSha512 } });

function click(over: Partial<InstalledClick> = {}) {
  const began: Approval[] = [];
  const verifiedVersions: string[] = [];
  let quits = 0;
  const o: InstalledClick = {
    restart: "yes",
    copy: { program: "/apps/G.AppImage", dataDir: "/d" },
    running: "1.2.3",
    serverPid: 200,
    verify: async (version) => { verifiedVersions.push(version); return verified(); },
    begin: (a): Begin => { began.push(a); return { kind: "begun", transaction: {} as never }; },
    record: (pid) => ({ pid, start: `s${pid}`, uptime: 1 }),
    uptime: () => 1000,
    bootId: () => "boot-1",
    quit: () => { quits++; },
    ...over,
  };
  return { o, began, verifiedVersions, quits: () => quits };
}

describe("Restart to update, installed", () => {
  it("CL-01 an approved target that still matches its download begins with the pinned identity, then quits", async () => {
    const c = click();
    expect(await startInstalledUpdate(TARGET, c.o)).toEqual({ ok: true });
    expect(c.verifiedVersions).toEqual(["1.3.0"]);
    expect(c.began).toEqual([{
      copy: { program: "/apps/G.AppImage", dataDir: "/d" }, from: "1.2.3", to: "1.3.0", listDigest: DIGEST, artifact,
      uptime: 1000, boot: "boot-1", main: { pid: process.pid, start: `s${process.pid}`, uptime: 1 }, server: { pid: 200, start: "s200", uptime: 1 },
    }]);
    expect(c.quits()).toBe(1);
  });

  it("CL-02 a download that fails its check, or a list that is not the approved one, is refused with the bad-download sentence", async () => {
    for (const verify of [async (): Promise<Verified> => ({ ok: false, reason: "gone" }), async () => verified("c".repeat(128))]) {
      const c = click({ verify });
      expect(await startInstalledUpdate(TARGET, c.o)).toEqual({ ok: false, message: "The download of version 1.3.0 did not match the signed release list, so it was deleted. Use Check for updates to try again." });
      expect(c.began).toEqual([]);
      expect(c.quits()).toBe(0);
    }
  });

  it("CL-03 a copy that cannot replace its file says why and names the version; nothing is verified", async () => {
    const cases = [
      ["read-only", "Gates Local cannot replace its own file because its folder is read-only. Download version 1.3.0 from the release page and replace the file yourself."],
      ["pinned", "This copy keeps its data in a folder set by GATES_LOCAL_DATA_DIR, so it cannot update itself. Download version 1.3.0 from the release page."],
      ["none", "This installed copy of Gates Local cannot update itself yet. Download the new version from the release page."],
    ] as const;
    for (const [restart, message] of cases) {
      const c = click({ restart });
      expect(await startInstalledUpdate(TARGET, c.o)).toEqual({ ok: false, message });
      expect(c.verifiedVersions).toEqual([]);
    }
  });

  it("CL-04 no server process, a refused begin, or a target that is not an installed one: refused, no quit", async () => {
    const noServer = click({ serverPid: undefined });
    expect(await startInstalledUpdate(TARGET, noServer.o)).toMatchObject({ ok: false });
    expect(noServer.began).toEqual([]);
    const refused = click({ begin: () => ({ kind: "refused", words: { text: "An earlier update did not finish." } }) });
    expect(await startInstalledUpdate(TARGET, refused.o)).toEqual({ ok: false, message: "An earlier update did not finish." });
    expect(refused.quits()).toBe(0);
    const commit = click();
    expect(await startInstalledUpdate("f".repeat(40), commit.o)).toMatchObject({ ok: false });
    expect(commit.verifiedVersions).toEqual([]);
  });
});
