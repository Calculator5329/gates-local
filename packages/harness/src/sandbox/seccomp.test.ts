import { describe, expect, it } from "vitest";
import { ARCHES, LOCK_COMMANDS, lockFilter, RET, runFilter, type SeccompArch } from "./seccomp.ts";

const hex = (arch: SeccompArch) => lockFilter(arch).toString("hex").match(/.{16}/g);
// Little-endian sock_filter words: code(2) jt(1) jf(1) k(4). Pinned so a change to the program is a visible diff.
const pinned: Record<SeccompArch, string[]> = {
  x64: ["2000000004000000", "1500000b3e0000c0", "2000000000000000", "4500090000000040", "1500080049000000", "1500000648000000",
    "2000000018000000", "1500050006000000", "1500040007000000", "1500030025000000", "1500020026000000", "1500010000040000", "060000000000ff7f", "0600000001000500"],
  arm64: ["2000000004000000", "1500000ab70000c0", "2000000000000000", "1500080020000000", "1500000619000000",
    "2000000018000000", "1500050006000000", "1500040007000000", "1500030025000000", "1500020026000000", "1500010000040000", "060000000000ff7f", "0600000001000500"],
};
const foreign = { x64: 0x40000003 /* AUDIT_ARCH_I386 */, arm64: 0x40000028 /* AUDIT_ARCH_ARM */ };
const read = { x64: 0, arm64: 63 };

describe("seccomp lock filter", () => {
  for (const arch of ["x64", "arm64"] as const) {
    const program = lockFilter(arch);
    const { audit, flock, fcntl } = ARCHES[arch];
    it(`${arch}: bytes are the documented program`, () => {
      expect(program.length % 8).toBe(0);
      expect(hex(arch)).toEqual(pinned[arch]);
    });
    it(`${arch}: denies flock, every locking fcntl and F_SETLEASE, allows the rest`, () => {
      expect(runFilter(program, { arch: audit, nr: flock })).toBe(RET.EPERM);
      expect(LOCK_COMMANDS.F_SETLEASE).toBe(1024);
      for (const cmd of Object.values(LOCK_COMMANDS)) expect(runFilter(program, { arch: audit, nr: fcntl, args: [3, cmd] })).toBe(RET.EPERM);
      for (const cmd of [1 /* F_GETFD */, 3 /* F_GETFL */, 5 /* F_GETLK */, 36 /* F_OFD_GETLK */, 1025 /* F_GETLEASE */]) expect(runFilter(program, { arch: audit, nr: fcntl, args: [3, cmd] })).toBe(RET.ALLOW);
      expect(runFilter(program, { arch: audit, nr: read[arch], args: [3, 6] })).toBe(RET.ALLOW);
    });
    it(`${arch}: a foreign arch is denied for every syscall`, () => {
      for (const nr of [0, 3, flock, fcntl, 400]) expect(runFilter(program, { arch: foreign[arch], nr })).toBe(RET.EPERM);
    });
  }
  it("x64: a syscall with the x32 bit is denied", () => {
    const { audit } = ARCHES.x64;
    for (const nr of [0, 72, 73, 512]) expect(runFilter(lockFilter("x64"), { arch: audit, nr: 0x40000000 | nr })).toBe(RET.EPERM);
  });
});
