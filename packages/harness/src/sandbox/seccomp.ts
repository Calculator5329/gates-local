// A classic-BPF seccomp program for bwrap's `--seccomp <fd>`. It stops the
// sandbox from taking file locks, so a shell reading a live database in a
// folder source can never block the owner's writer. Everything else is
// allowed; bwrap's namespaces and read-only mounts do the rest.
//
// bwrap reads the raw program: an array of `struct sock_filter`
// { u16 code; u8 jt; u8 jf; u32 k } (8 bytes each, little-endian on both
// supported arches). The kernel runs it against `struct seccomp_data`:
//   offset 0  int nr        the syscall number
//   offset 4  u32 arch      AUDIT_ARCH_* of the calling convention
//   offset 16 u64 args[6]   args[1] low word at 24 (little-endian)
//
// The program, instruction by instruction:
//   0  ld  [4]                        load arch
//   1  jeq ARCH, 0, DENY              a foreign arch (i386 or arm32 compat,
//                                     x32 is caught below) is denied for
//                                     every syscall: its numbers mean other
//                                     calls, so no allow-list holds for it
//   2  ld  [0]                        load the syscall number
//   x86_64 only:
//   3  jset 0x40000000, DENY, 0       the x32 bit: x32 calls reuse x86_64
//                                     numbers plus this bit, so deny them all
//   .  jeq FLOCK, DENY, 0             flock(2) is denied
//   .  jeq FCNTL, 0, ALLOW            not fcntl: allowed
//   .  ld  [24]                       fcntl: load args[1] (cmd), low word;
//                                     the kernel reads cmd as unsigned int,
//                                     so the high word cannot bypass this
//   .  jeq F_SETLK, DENY, 0           6
//   .  jeq F_SETLKW, DENY, 0          7
//   .  jeq F_OFD_SETLK, DENY, 0       37
//   .  jeq F_OFD_SETLKW, DENY, 0      38
//   ALLOW: ret SECCOMP_RET_ALLOW      every other syscall and fcntl cmd
//   DENY:  ret SECCOMP_RET_ERRNO|EPERM
//
// F_GETLK and F_OFD_GETLK stay allowed: they only ask, they take nothing.

export type SeccompArch = "x64" | "arm64";

const BPF_LD_W_ABS = 0x20; // BPF_LD | BPF_W | BPF_ABS
const BPF_JEQ_K = 0x15; // BPF_JMP | BPF_JEQ | BPF_K
const BPF_JSET_K = 0x45; // BPF_JMP | BPF_JSET | BPF_K
const BPF_RET_K = 0x06; // BPF_RET | BPF_K
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_ERRNO = 0x00050000;
const EPERM = 1;
const X32_SYSCALL_BIT = 0x40000000;
export const LOCK_COMMANDS = { F_SETLK: 6, F_SETLKW: 7, F_OFD_SETLK: 37, F_OFD_SETLKW: 38 } as const;

export const ARCHES: Record<SeccompArch, { audit: number; flock: number; fcntl: number; x32: boolean }> = {
  x64: { audit: 0xc000003e, flock: 73, fcntl: 72, x32: true }, // AUDIT_ARCH_X86_64, asm/unistd_64.h
  arm64: { audit: 0xc00000b7, flock: 32, fcntl: 25, x32: false }, // AUDIT_ARCH_AARCH64, asm-generic/unistd.h
};

export function isSeccompArch(arch: string): arch is SeccompArch {
  return arch === "x64" || arch === "arm64";
}

/** The filter bytes for one arch; see the header for each instruction. */
export function lockFilter(arch: SeccompArch): Buffer {
  const a = ARCHES[arch];
  type Insn = { code: number; jt: number | "DENY" | "ALLOW"; jf: number | "DENY" | "ALLOW"; k: number };
  const body: Insn[] = [
    { code: BPF_LD_W_ABS, jt: 0, jf: 0, k: 4 },
    { code: BPF_JEQ_K, jt: 0, jf: "DENY", k: a.audit },
    { code: BPF_LD_W_ABS, jt: 0, jf: 0, k: 0 },
    ...(a.x32 ? [{ code: BPF_JSET_K, jt: "DENY" as const, jf: 0, k: X32_SYSCALL_BIT }] : []),
    { code: BPF_JEQ_K, jt: "DENY", jf: 0, k: a.flock },
    { code: BPF_JEQ_K, jt: 0, jf: "ALLOW", k: a.fcntl },
    { code: BPF_LD_W_ABS, jt: 0, jf: 0, k: 24 },
    ...Object.values(LOCK_COMMANDS).map((k): Insn => ({ code: BPF_JEQ_K, jt: "DENY", jf: 0, k })),
  ];
  const allow = body.length;
  const deny = allow + 1;
  // Jump offsets count from the next instruction.
  const offset = (target: Insn["jt"], at: number) => target === "ALLOW" ? allow - at - 1 : target === "DENY" ? deny - at - 1 : target;
  const program = [
    ...body.map((insn, at) => ({ ...insn, jt: offset(insn.jt, at), jf: offset(insn.jf, at) })),
    { code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ALLOW },
    { code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ERRNO | EPERM },
  ];
  const bytes = Buffer.alloc(program.length * 8);
  program.forEach((insn, i) => {
    bytes.writeUInt16LE(insn.code, i * 8);
    bytes.writeUInt8(insn.jt, i * 8 + 2);
    bytes.writeUInt8(insn.jf, i * 8 + 3);
    bytes.writeUInt32LE(insn.k >>> 0, i * 8 + 4);
  });
  return bytes;
}

/** A tiny classic-BPF interpreter over the same instructions, for tests. */
export function runFilter(program: Buffer, data: { nr: number; arch: number; args?: readonly number[] }): number {
  const word = (offset: number) => {
    if (offset === 0) return data.nr >>> 0;
    if (offset === 4) return data.arch >>> 0;
    const arg = (offset - 16) / 8;
    if (offset >= 16 && offset % 8 === 0 && arg < 6) return (data.args?.[arg] ?? 0) >>> 0;
    throw new Error(`Unexpected load offset ${offset}`);
  };
  let acc = 0;
  for (let pc = 0; pc * 8 < program.length;) {
    const code = program.readUInt16LE(pc * 8);
    const jt = program.readUInt8(pc * 8 + 2);
    const jf = program.readUInt8(pc * 8 + 3);
    const k = program.readUInt32LE(pc * 8 + 4);
    if (code === BPF_LD_W_ABS) { acc = word(k); pc++; }
    else if (code === BPF_JEQ_K) pc += 1 + (acc === k ? jt : jf);
    else if (code === BPF_JSET_K) pc += 1 + ((acc & k) !== 0 ? jt : jf);
    else if (code === BPF_RET_K) return k;
    else throw new Error(`Unexpected opcode ${code}`);
  }
  throw new Error("Program fell off the end");
}
export const RET = { ALLOW: SECCOMP_RET_ALLOW, EPERM: SECCOMP_RET_ERRNO | EPERM } as const;
