import path from "node:path";
import { brokenForTest } from "@gates-local/update/break-for-test";
import { exists, identify, ioCode, removeIfPresent, sameIdentity, type FileOps, type Identity } from "@gates-local/update/installed/files";

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

export function holds(file: string, old: Identity, next: Identity): Holds {
  const found = identify(file);
  if (sameIdentity(found, old)) return "old";
  if (sameIdentity(found, next)) return "new";
  return "neither";
}

export function stage(p: ProgramPaths, artifactFile: string, ops: FileOps): void {
  removeIfPresent(p.incoming, ops);
  ops.copyFile(artifactFile, p.incoming);
  ops.chmod(p.incoming, 0o755);
  ops.fsyncFile(p.incoming);
  ops.fsyncDir(p.dir);
}

export function recoverStage(p: ProgramPaths, artifactFile: string, next: Identity, ops: FileOps): void {
  if (sameIdentity(identify(p.incoming), next)) {
    ops.chmod(p.incoming, 0o755);
    ops.fsyncFile(p.incoming);
    ops.fsyncDir(p.dir);
    return;
  }
  stage(p, artifactFile, ops);
}

// external: Linux gives one of these codes when a volume refuses hard links (vfat, some network and FUSE).
const LINK_REFUSED: ReadonlySet<string> = new Set(["EPERM", "EOPNOTSUPP", "ENOTSUP", "EXDEV", "EMLINK", "ENOSYS"]);

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

// why: a rename's error may not mean it failed, so the watcher checks what it did before the flush.
export const renameIntoPlace = (p: ProgramPaths, ops: FileOps): void =>
  brokenForTest("program-written-in-place") ? ops.copyFile(p.incoming, p.program) : ops.rename(p.incoming, p.program);

export const flushProgramFolder = (p: ProgramPaths, ops: FileOps): void => ops.fsyncDir(p.dir);

export function replace(p: ProgramPaths, ops: FileOps, afterRename?: () => void): void {
  renameIntoPlace(p, ops);
  afterRename?.();
  flushProgramFolder(p, ops);
}

export function putBack(p: ProgramPaths, ops: FileOps): void {
  ops.rename(p.previous, p.program);
  ops.fsyncDir(p.dir);
}

export function removeStaging(p: ProgramPaths, ops: FileOps): void {
  const removed = [removeIfPresent(p.incoming, ops), removeIfPresent(p.previousPart, ops)];
  if (removed.some(Boolean)) ops.fsyncDir(p.dir);
}

export function removeKept(p: ProgramPaths, ops: FileOps): void {
  const removed = [removeIfPresent(p.previous, ops), removeIfPresent(p.incoming, ops), removeIfPresent(p.previousPart, ops)];
  if (removed.some(Boolean)) ops.fsyncDir(p.dir);
}
