import { createHash } from "node:crypto";
import path from "node:path";
import { Transform } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installPinned } from "./install.ts";
import { FAKE_RELEASE_FORMAT, type ReleaseServer, buildFakeRelease, removeDir, startReleaseServer, tmpDir } from "./test-fakes.ts";

vi.mock("node:zlib", async (real) => {
  const z = await real<typeof import("node:zlib")>();
  // why: every byte reaches tar at once and only the end of the feed is held back 300 ms
  const createZstdDecompress = () => new Transform({ transform: (c: Buffer, _e, cb) => cb(null, z.zstdDecompressSync(c)), flush: (cb) => setTimeout(cb, 300) });
  return { ...z, default: { ...z, createZstdDecompress }, createZstdDecompress };
});
vi.mock("node:child_process", async (real) => {
  const cp = await real<typeof import("node:child_process")>();
  // why: tar runs as itself; a sleep left behind keeps its output open 200 ms after it exits
  const spawn = ((cmd: string, args: string[], opts: object) =>
    cmd === "tar" ? cp.spawn("sh", ["-c", 'tar "$@"; s=$?; (sleep 0.2 </dev/null &); exit $s', "sh", ...args], opts) : cp.spawn(cmd, args, opts)) as typeof cp.spawn;
  return { ...cp, default: { ...cp, spawn }, spawn };
});

let work: string;
let server: ReleaseServer;
let tarball: Buffer;
beforeEach(async () => {
  work = tmpDir("forced");
  tarball = buildFakeRelease(work);
  server = await startReleaseServer(tarball);
});
afterEach(async () => {
  await server.close();
  removeDir(work);
});

// external: GNU tar exits at its end-of-archive mark, which can be before its input ends
it.skipIf(process.platform === "win32")("a good archive unpacks when tar exits before its input ends", async () => {
  const appDataDir = path.join(work, "data", "gates-local");
  const sha256 = createHash("sha256").update(tarball).digest("hex");
  const r = await installPinned({ appDataDir, manifest: { version: "9.9.9-test", url: server.url, sha256, sizeBytes: tarball.length, format: FAKE_RELEASE_FORMAT, verified: true, source: "test" } });
  expect(r.alreadyInstalled).toBe(false);
});
