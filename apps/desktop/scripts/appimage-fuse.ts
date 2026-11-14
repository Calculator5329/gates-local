// What a mounted AppImage needs from the machine, read from the files themselves.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export interface FuseMachine {
  readonly hasDevFuse: boolean;
  readonly hasFusermount: boolean;
  /** Folders the AppImage runtime's dlopen searches: LD_LIBRARY_PATH, then the system's. */
  readonly libraryFolders: readonly string[];
}

export function thisMachine(): FuseMachine {
  return {
    hasDevFuse: existsSync("/dev/fuse"),
    hasFusermount: ["fusermount3", "fusermount"].some(name => spawnSync("sh", ["-c", `command -v ${name}`]).status === 0),
    libraryFolders: [...(process.env["LD_LIBRARY_PATH"] ?? "").split(":"), "/lib/x86_64-linux-gnu", "/usr/lib/x86_64-linux-gnu", "/lib64", "/usr/lib64", "/lib", "/usr/lib"].filter(f => f !== ""),
  };
}

/**
 * The AppImage's runtime: the ELF program before the app's squashfs, which starts where the
 * section header table ends.
 */
function runtimeOf(file: Uint8Array): Uint8Array {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const elf = file.length >= 64 && file[0] === 0x7f && file[1] === 0x45 && file[2] === 0x4c && file[3] === 0x46 && file[4] === 2 && file[5] === 1;
  if (!elf) throw new Error("not a 64-bit ELF: an AppImage starts with its runtime program");
  const end = Number(view.getBigUint64(0x28, true)) + view.getUint16(0x3a, true) * view.getUint16(0x3c, true);
  return file.subarray(0, Math.min(end, file.length));
}

const LIBFUSE2 = new TextEncoder().encode("libfuse.so.2");

/**
 * Only the old (type 2, dynamic) runtime loads libfuse.so.2 with dlopen; the static runtime that
 * builds after 0.2.4 carry has FUSE built in and needs only the fusermount helper.
 */
export function needsLibfuse2(file: Uint8Array): boolean {
  const runtime = runtimeOf(file);
  outer: for (let i = 0; i + LIBFUSE2.length <= runtime.length; i++) {
    for (let j = 0; j < LIBFUSE2.length; j++) if (runtime[i + j] !== LIBFUSE2[j]) continue outer;
    return true;
  }
  return false;
}

/** Why the AppImages cannot run mounted on this machine, or null when they can. */
export function fuseProblem(appImages: readonly Uint8Array[], machine: FuseMachine): string | null {
  const needsFuse2 = appImages.map(needsLibfuse2).some(Boolean);
  if (!machine.hasDevFuse) return "this machine has no /dev/fuse";
  if (!machine.hasFusermount) return "this machine has no fusermount";
  if (!needsFuse2) return null;
  return machine.libraryFolders.some(f => existsSync(path.join(f, "libfuse.so.2"))) ? null : "this machine has no libfuse.so.2 (Ubuntu: libfuse2t64), which the old AppImage runtime needs";
}
