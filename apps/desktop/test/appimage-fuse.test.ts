// The mounted update check asks for FUSE 2 only when an AppImage's own runtime loads it.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fuseProblem, type FuseMachine } from "../scripts/appimage-fuse.ts";

/** An ELF file whose section header table ends the runtime, then a payload, as an AppImage is laid out. */
function appImage(runtimeText: string, payloadText: string): Uint8Array {
  const header = Buffer.alloc(64);
  header.write("\x7fELF", 0, "latin1");
  header[4] = 2; // 64-bit
  header[5] = 1; // little-endian
  const body = Buffer.from(runtimeText, "latin1");
  const shentsize = 64, shnum = 2;
  const shoff = header.length + body.length;
  header.writeBigUInt64LE(BigInt(shoff), 0x28);
  header.writeUInt16LE(shentsize, 0x3a);
  header.writeUInt16LE(shnum, 0x3c);
  return Buffer.concat([header, body, Buffer.alloc(shentsize * shnum), Buffer.from(payloadText, "latin1")]);
}

const oldRuntime = appImage("runtime that calls dlopen(libfuse.so.2)", "hsqs app files");
const staticRuntime = appImage("runtime with fuse3 built in, uses fusermount3", "hsqs app files");
const staticWithWordInPayload = appImage("runtime with fuse3 built in, uses fusermount3", "hsqs app files naming libfuse.so.2 in a doc");

const withLibfuse2 = (() => {
  const folder = mkdtempSync(path.join(tmpdir(), "fuse-lib-"));
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "libfuse.so.2"), "");
  return folder;
})();
const stock2404: FuseMachine = { hasDevFuse: true, hasFusermount: true, libraryFolders: [] };
const withFuse2: FuseMachine = { ...stock2404, libraryFolders: [withLibfuse2] };

describe("fuseProblem", () => {
  it("two static-runtime AppImages run mounted on a machine with no libfuse.so.2", () => {
    expect(fuseProblem([staticRuntime, staticRuntime], stock2404)).toBeNull();
  });

  it("an old-runtime AppImage on either side still needs libfuse.so.2", () => {
    expect(fuseProblem([oldRuntime, staticRuntime], stock2404)).toMatch(/libfuse\.so\.2/);
    expect(fuseProblem([staticRuntime, oldRuntime], stock2404)).toMatch(/libfuse\.so\.2/);
    expect(fuseProblem([oldRuntime, staticRuntime], withFuse2)).toBeNull();
  });

  it("reads only the runtime: the words in the app's own files do not count", () => {
    expect(fuseProblem([staticWithWordInPayload], stock2404)).toBeNull();
  });

  it("every AppImage needs /dev/fuse and a fusermount helper", () => {
    expect(fuseProblem([staticRuntime], { ...stock2404, hasDevFuse: false })).toMatch(/\/dev\/fuse/);
    expect(fuseProblem([staticRuntime], { ...stock2404, hasFusermount: false })).toMatch(/fusermount/);
  });

  it("a file that is not a 64-bit ELF is refused, not guessed", () => {
    expect(() => fuseProblem([Buffer.from("not an AppImage")], withFuse2)).toThrow(/not a 64-bit ELF/);
  });
});
