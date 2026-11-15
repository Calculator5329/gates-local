export type SeccompArch = "x64" | "arm64";

const BPF_LD_W_ABS = 0x20;
const BPF_JEQ_K = 0x15;
const BPF_JSET_K = 0x45;
const BPF_RET_K = 0x06;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_ERRNO = 0x00050000;
const EPERM = 1;
// external: Linux's x32 calls reuse the x86_64 syscall numbers plus this bit.
const X32_SYSCALL_BIT = 0x40000000;
const AUDIT_ARCH_X86_64 = 0xc000003e;
const AUDIT_ARCH_AARCH64 = 0xc00000b7;
// external: Linux's struct seccomp_data { int nr; u32 arch; u64 instruction_pointer; u64 args[6] }, little-endian.
const SECCOMP_DATA_OFFSET = { nr: 0, arch: 4, firstArg: 16, lowWordOfSecondArg: 24 } as const;
const BYTES_PER_ARG = 8;
const ARG_COUNT = 6;
// external: Linux's struct sock_filter { u16 code; u8 jt; u8 jf; u32 k }, little-endian on both arches; bwrap passes the array on as it is.
const SOCK_FILTER = { bytes: 8, code: 0, jt: 2, jf: 3, k: 4 } as const;
// external: a read lease (F_SETLEASE) makes Linux block the owner's writable open, or fail it with EAGAIN.
export const LOCK_COMMANDS = { F_SETLK: 6, F_SETLKW: 7, F_OFD_SETLK: 37, F_OFD_SETLKW: 38, F_SETLEASE: 1024 } as const;

// external: Linux numbers flock and fcntl in asm/unistd_64.h for x86_64 and asm-generic/unistd.h for aarch64.
export const ARCHES: Record<SeccompArch, { audit: number; flock: number; fcntl: number; x32: boolean }> = {
  x64: { audit: AUDIT_ARCH_X86_64, flock: 73, fcntl: 72, x32: true },
  arm64: { audit: AUDIT_ARCH_AARCH64, flock: 32, fcntl: 25, x32: false },
};

export function isSeccompArch(arch: string): arch is SeccompArch {
  return arch === "x64" || arch === "arm64";
}

type Target = number | "DENY" | "ALLOW";
type Insn = { code: number; jt: Target; jf: Target; k: number };
const NEXT = 0;
const load = (offset: number): Insn => ({ code: BPF_LD_W_ABS, jt: NEXT, jf: NEXT, k: offset });
const denyUnlessEqual = (k: number): Insn => ({ code: BPF_JEQ_K, jt: NEXT, jf: "DENY", k });
const denyIfEqual = (k: number): Insn => ({ code: BPF_JEQ_K, jt: "DENY", jf: NEXT, k });
const allowUnlessEqual = (k: number): Insn => ({ code: BPF_JEQ_K, jt: NEXT, jf: "ALLOW", k });
const denyIfAnyBitOf = (k: number): Insn => ({ code: BPF_JSET_K, jt: "DENY", jf: NEXT, k });
const returning = (k: number) => ({ code: BPF_RET_K, jt: NEXT, jf: NEXT, k });

export function lockFilter(arch: SeccompArch): Buffer {
  const a = ARCHES[arch];
  const body: Insn[] = [
    load(SECCOMP_DATA_OFFSET.arch),
    // external: under a foreign arch Linux reads the same syscall numbers as other calls, so no allow-list holds for it.
    denyUnlessEqual(a.audit),
    load(SECCOMP_DATA_OFFSET.nr),
    ...(a.x32 ? [denyIfAnyBitOf(X32_SYSCALL_BIT)] : []),
    denyIfEqual(a.flock),
    allowUnlessEqual(a.fcntl),
    // external: Linux reads fcntl's command, its second argument, as an unsigned int, so the low word is all of it.
    load(SECCOMP_DATA_OFFSET.lowWordOfSecondArg),
    ...Object.values(LOCK_COMMANDS).map(denyIfEqual),
  ];
  const allow = body.length;
  const deny = allow + 1;
  // external: Linux counts a BPF jump offset from the next instruction.
  const offset = (target: Target, at: number) => target === "ALLOW" ? allow - at - 1 : target === "DENY" ? deny - at - 1 : target;
  const program = [
    ...body.map((insn, at) => ({ ...insn, jt: offset(insn.jt, at), jf: offset(insn.jf, at) })),
    returning(SECCOMP_RET_ALLOW),
    returning(SECCOMP_RET_ERRNO | EPERM),
  ];
  const bytes = Buffer.alloc(program.length * SOCK_FILTER.bytes);
  program.forEach((insn, i) => {
    bytes.writeUInt16LE(insn.code, i * SOCK_FILTER.bytes + SOCK_FILTER.code);
    bytes.writeUInt8(insn.jt, i * SOCK_FILTER.bytes + SOCK_FILTER.jt);
    bytes.writeUInt8(insn.jf, i * SOCK_FILTER.bytes + SOCK_FILTER.jf);
    bytes.writeUInt32LE(insn.k >>> 0, i * SOCK_FILTER.bytes + SOCK_FILTER.k);
  });
  return bytes;
}

export function runFilter(program: Buffer, data: { nr: number; arch: number; args?: readonly number[] }): number {
  const word = (offset: number) => {
    if (offset === SECCOMP_DATA_OFFSET.nr) return data.nr >>> 0;
    if (offset === SECCOMP_DATA_OFFSET.arch) return data.arch >>> 0;
    const arg = (offset - SECCOMP_DATA_OFFSET.firstArg) / BYTES_PER_ARG;
    if (offset >= SECCOMP_DATA_OFFSET.firstArg && offset % BYTES_PER_ARG === 0 && arg < ARG_COUNT) return (data.args?.[arg] ?? 0) >>> 0;
    throw new Error(`Unexpected load offset ${offset}`);
  };
  let acc = 0;
  for (let pc = 0; pc * SOCK_FILTER.bytes < program.length;) {
    const code = program.readUInt16LE(pc * SOCK_FILTER.bytes + SOCK_FILTER.code);
    const jt = program.readUInt8(pc * SOCK_FILTER.bytes + SOCK_FILTER.jt);
    const jf = program.readUInt8(pc * SOCK_FILTER.bytes + SOCK_FILTER.jf);
    const k = program.readUInt32LE(pc * SOCK_FILTER.bytes + SOCK_FILTER.k);
    if (code === BPF_LD_W_ABS) { acc = word(k); pc++; }
    else if (code === BPF_JEQ_K) pc += 1 + (acc === k ? jt : jf);
    else if (code === BPF_JSET_K) pc += 1 + ((acc & k) !== 0 ? jt : jf);
    else if (code === BPF_RET_K) return k;
    else throw new Error(`Unexpected opcode ${code}`);
  }
  throw new Error("Program fell off the end");
}
export const RET = { ALLOW: SECCOMP_RET_ALLOW, EPERM: SECCOMP_RET_ERRNO | EPERM } as const;
