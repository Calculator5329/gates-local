// The program-file steps of an installed Linux update (rows S1, S2, S3, B3
// and C of docs/design/installed-updates.md, section 2), each with the flush
// its row names, and the identity check recovery uses.
//
// Everything sits in the program file's own folder, so every rename stays on
// one volume: `.<name>.incoming-<id>` is the staged new version and
// `.<name>.previous-<id>` keeps the old one. The program file keeps the
// person's name (owner decision D4).
import path from "node:path";
import { exists, identify, ioCode, removeIfPresent, sameIdentity, type FileOps, type Identity } from "./files.ts";

export interface ProgramPaths {
  readonly program: string;
  readonly dir: string;
  readonly name: string;
  readonly incoming: string;
  readonly previous: string;
  readonly previousPart: string;
}

export function programPaths(program: string, id: string): ProgramPaths {
  const dir = path.dirname(program), name = path.basename(program);
  const previous = path.join(dir, `.${name}.previous-${id}`);
  return { program, dir, name, incoming: path.join(dir, `.${name}.incoming-${id}`), previous, previousPart: `${previous}.part` };
}

export type Holds = "old" | "new" | "neither";

/** What is at `file` now, by size and SHA-512. Nothing there is "neither". */
export function holds(file: string, old: Identity, next: Identity): Holds {
  const found = identify(file);
  if (sameIdentity(found, old)) return "old";
  if (sameIdentity(found, next)) return "new";
  return "neither";
}

/** S1: copy the verified artifact next to the program file, make it executable, flush it and the folder. */
export function stage(p: ProgramPaths, artifactFile: string, ops: FileOps): void {
  removeIfPresent(p.incoming, ops);
  ops.copyFile(artifactFile, p.incoming);
  ops.chmod(p.incoming, 0o755);
  ops.fsyncFile(p.incoming);
  ops.fsyncDir(p.dir);
}

/** S1's recovery: a staged file that matches `new` is flushed again; anything else is deleted (only `.incoming-<id>`) and S1 redone. */
export function recoverStage(p: ProgramPaths, artifactFile: string, next: Identity, ops: FileOps): void {
  if (sameIdentity(identify(p.incoming), next)) {
    ops.chmod(p.incoming, 0o755);
    ops.fsyncFile(p.incoming);
    ops.fsyncDir(p.dir);
    return;
  }
  stage(p, artifactFile, ops);
}

/** Codes with which a volume refuses hard links (vfat, some network and FUSE file systems). */
const LINK_REFUSED: ReadonlySet<string> = new Set(["EPERM", "EOPNOTSUPP", "ENOTSUP", "EXDEV", "EMLINK", "ENOSYS"]);

/**
 * S2, action and recovery: `.previous-<id>` matching `old` is done; a `.part`
 * or a mismatch is deleted and S2 redone. A hard link first; when the volume
 * refuses one, a copy to `.part`, flushed, checked against `old`, renamed.
 */
export function keepPrevious(p: ProgramPaths, old: Identity, ops: FileOps): void {
  removeIfPresent(p.previousPart, ops);
  if (exists(p.previous)) {
    if (sameIdentity(identify(p.previous), old)) {
      ops.fsyncDir(p.dir);
      return;
    }
    ops.unlink(p.previous);
  }
  try {
    ops.link(p.program, p.previous);
  } catch (e) {
    const code = ioCode(e);
    if (code === null || !LINK_REFUSED.has(code)) throw e;
    ops.copyFile(p.program, p.previousPart);
    ops.fsyncFile(p.previousPart);
    if (!sameIdentity(identify(p.previousPart), old)) {
      ops.unlink(p.previousPart);
      throw new Error(`The copy of ${p.program} did not match the file that was there`, { cause: e });
    }
    ops.rename(p.previousPart, p.previous);
  }
  ops.fsyncDir(p.dir);
}

/** S3's replacing rename alone. The watcher checks what it did before the flush, because an error it returns may not mean it failed. */
export const renameIntoPlace = (p: ProgramPaths, ops: FileOps): void => ops.rename(p.incoming, p.program);

/** S3's flush alone, for a rename already seen to have taken effect. */
export const flushProgramFolder = (p: ProgramPaths, ops: FileOps): void => ops.fsyncDir(p.dir);

/** S3: the replacing rename, then the folder flush. `afterRename` is the stop point between them. */
export function replace(p: ProgramPaths, ops: FileOps, afterRename?: () => void): void {
  renameIntoPlace(p, ops);
  afterRename?.();
  flushProgramFolder(p, ops);
}

/** B3: the kept old version back at the program path, then the folder flush. */
export function putBack(p: ProgramPaths, ops: FileOps): void {
  ops.rename(p.previous, p.program);
  ops.fsyncDir(p.dir);
}

/** The incomplete staging files of a transaction stopped before the replace. The kept previous file is row C's. */
export function removeStaging(p: ProgramPaths, ops: FileOps): void {
  const removed = [removeIfPresent(p.incoming, ops), removeIfPresent(p.previousPart, ops)];
  if (removed.some(Boolean)) ops.fsyncDir(p.dir);
}

/** Row C's part in the program folder: the kept previous file (owner decision D2) and any staging left. */
export function removeKept(p: ProgramPaths, ops: FileOps): void {
  const removed = [removeIfPresent(p.previous, ops), removeIfPresent(p.incoming, ops), removeIfPresent(p.previousPart, ops)];
  if (removed.some(Boolean)) ops.fsyncDir(p.dir);
}
