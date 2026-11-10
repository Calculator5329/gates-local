import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { identify, realFileOps, type FileOps, type Identity } from "./files.ts";
import { holds, keepPrevious, programPaths, putBack, recoverStage, removeKept, removeStaging, replace, stage } from "./linux.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function copy() {
  const root = mkdtempSync(path.join(tmpdir(), "iu-linux-")); roots.push(root);
  const program = path.join(root, "Gates-Local.AppImage");
  const artifact = path.join(root, "download.AppImage");
  writeFileSync(program, "old program bytes");
  writeFileSync(artifact, "new program bytes, a little longer");
  const old = identify(program) as Identity, next = identify(artifact) as Identity;
  return { root, program, artifact, old, next, p: programPaths(program, "tx1") };
}
const calls = (log: string[], root: string): FileOps => ({ ...realFileOps,
  link: (a, b) => { log.push(`link ${path.basename(b)}`); realFileOps.link(a, b); },
  rename: (a, b) => { log.push(`rename ${path.basename(a)} ${path.basename(b)}`); realFileOps.rename(a, b); },
  fsyncFile: f => { log.push(`flush ${path.basename(f)}`); realFileOps.fsyncFile(f); },
  fsyncDir: d => { log.push(`flush ${path.relative(root, d) || "program folder"}`); realFileOps.fsyncDir(d); } });

/**
 * `holds` run in a child process, so an open that blocks ends at the timeout
 * (status null) instead of hanging the whole suite.
 */
function holdsInChild(program: string, old: Identity, next: Identity): { readonly status: number | null; readonly out: string } {
  const linux = pathToFileURL(path.join(import.meta.dirname, "linux.ts")).href;
  const code = `const { holds } = await import(${JSON.stringify(linux)}); process.stdout.write(holds(${JSON.stringify(program)}, ${JSON.stringify(old)}, ${JSON.stringify(next)}));`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", code], { timeout: 10_000, encoding: "utf8" });
  return { status: run.status, out: run.stdout };
}

it("a named pipe at the program path is never opened: holds says neither, without blocking", () => {
  const c = copy();
  rmSync(c.program);
  execFileSync("mkfifo", [c.program]);
  expect(holdsInChild(c.program, c.old, c.next)).toEqual({ status: 0, out: "neither" });
}, 20_000);

it("a folder at the program path is never opened: identify gives null and holds says neither", () => {
  const c = copy();
  rmSync(c.program);
  mkdirSync(c.program);
  expect(identify(c.program)).toBeNull();
  expect(holds(c.program, c.old, c.next)).toBe("neither");
});

it("names the staged and kept files after the program file and the transaction id, in its own folder", () => {
  const p = programPaths("/apps/Gates-Local.AppImage", "tx1");
  expect(p).toEqual({ program: "/apps/Gates-Local.AppImage", dir: "/apps", name: "Gates-Local.AppImage", incoming: "/apps/.Gates-Local.AppImage.incoming-tx1", previous: "/apps/.Gates-Local.AppImage.previous-tx1", previousPart: "/apps/.Gates-Local.AppImage.previous-tx1.part" });
});

it("S1 stages an executable copy, flushes it and the program folder; recovery redoes only a partial one", () => {
  const c = copy(); const log: string[] = [];
  stage(c.p, c.artifact, calls(log, c.root));
  expect(holds(c.p.incoming, c.old, c.next)).toBe("new");
  expect(statSync(c.p.incoming).mode & 0o777).toBe(0o755);
  expect(log).toEqual(["flush .Gates-Local.AppImage.incoming-tx1", "flush program folder"]);
  writeFileSync(c.p.incoming, "new prog");
  recoverStage(c.p, c.artifact, c.next, realFileOps);
  expect(holds(c.p.incoming, c.old, c.next)).toBe("new");
  expect(readFileSync(c.program, "utf8")).toBe("old program bytes");
});

it("S2 keeps the previous file as a hard link, and flushes the folder", () => {
  const c = copy(); const log: string[] = [];
  keepPrevious(c.p, c.old, calls(log, c.root));
  expect(statSync(c.p.previous).ino).toBe(statSync(c.program).ino);
  expect(log).toEqual(["link .Gates-Local.AppImage.previous-tx1", "flush program folder"]);
});

it("S2 copies when the volume refuses hard links: .part, flush, match old, rename", () => {
  const c = copy(); const log: string[] = [];
  const noLinks: FileOps = { ...calls(log, c.root), link: () => { throw Object.assign(new Error("link refused"), { code: "EPERM" }); } };
  keepPrevious(c.p, c.old, noLinks);
  expect(holds(c.p.previous, c.old, c.next)).toBe("old");
  expect(statSync(c.p.previous).ino).not.toBe(statSync(c.program).ino);
  expect(existsSync(c.p.previousPart)).toBe(false);
  expect(log).toEqual(["flush .Gates-Local.AppImage.previous-tx1.part", "rename .Gates-Local.AppImage.previous-tx1.part .Gates-Local.AppImage.previous-tx1", "flush program folder"]);
});

it("S2 recovery: a kept file that matches old is done; a .part or a mismatch is deleted and S2 redone", () => {
  const c = copy();
  keepPrevious(c.p, c.old, realFileOps);
  const ino = statSync(c.p.previous).ino;
  keepPrevious(c.p, c.old, realFileOps);
  expect(statSync(c.p.previous).ino).toBe(ino);
  rmSync(c.p.previous); writeFileSync(c.p.previous, "something else"); writeFileSync(c.p.previousPart, "half");
  keepPrevious(c.p, c.old, realFileOps);
  expect(holds(c.p.previous, c.old, c.next)).toBe("old");
  expect(existsSync(c.p.previousPart)).toBe(false);
});

it("S3 replaces by rename and flushes the folder after it; B3 puts the previous file back", () => {
  const c = copy(); const log: string[] = [];
  stage(c.p, c.artifact, realFileOps); keepPrevious(c.p, c.old, realFileOps);
  replace(c.p, calls(log, c.root), () => log.push("after rename"));
  expect(holds(c.program, c.old, c.next)).toBe("new");
  expect(log).toEqual(["rename .Gates-Local.AppImage.incoming-tx1 Gates-Local.AppImage", "after rename", "flush program folder"]);
  log.length = 0;
  putBack(c.p, calls(log, c.root));
  expect(holds(c.program, c.old, c.next)).toBe("old");
  expect(log).toEqual(["rename .Gates-Local.AppImage.previous-tx1 Gates-Local.AppImage", "flush program folder"]);
});

it("identity: what is at a path is old, new or neither, and nothing there is neither", () => {
  const c = copy();
  expect(holds(c.program, c.old, c.next)).toBe("old");
  expect(holds(c.artifact, c.old, c.next)).toBe("new");
  expect(holds(path.join(c.root, "nothing"), c.old, c.next)).toBe("neither");
  writeFileSync(c.program, "old program byteZ");
  expect(holds(c.program, c.old, c.next)).toBe("neither");
});

it("staging removal leaves the kept file; row C's removal takes the kept file too", () => {
  const c = copy();
  stage(c.p, c.artifact, realFileOps); keepPrevious(c.p, c.old, realFileOps); writeFileSync(c.p.previousPart, "half");
  removeStaging(c.p, realFileOps);
  expect([existsSync(c.p.incoming), existsSync(c.p.previousPart), existsSync(c.p.previous)]).toEqual([false, false, true]);
  removeKept(c.p, realFileOps);
  expect(existsSync(c.p.previous)).toBe(false);
  expect(readFileSync(c.program, "utf8")).toBe("old program bytes");
});
