// The version read straight from .git, checked against what git itself says
// for the same repository: loose objects, after gc (packs and packed-refs),
// delta chains, annotated and lightweight tags, and a worktree.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Repos, commit, git, makeRepos, removeRepos, testEnv } from "./testing.ts";
import { applyDelta, objectIn, readVersion } from "./version.ts";

let r: Repos;

beforeEach(() => {
  r = makeRepos();
  for (const [k, v] of Object.entries(testEnv(r.base))) vi.stubEnv(k, v);
});

afterEach(() => {
  vi.unstubAllEnvs();
  removeRepos(r);
});

const expected = (repo: string) => ({
  commit: git(repo, "rev-parse", "--short=7", "HEAD"),
  date: Number(git(repo, "log", "-1", "--format=%ct", "HEAD")) * 1000,
});

describe("readVersion", () => {
  it("reads a commit and its date from loose objects", () => {
    commit(r.seed, "Second");
    expect(readdirSync(path.join(r.seed, ".git", "objects", "pack")).filter((f) => f.endsWith(".pack"))).toEqual([]);
    expect(readVersion(r.seed)).toEqual({ kind: "commit", ...expected(r.seed) });
  });

  it("reads the same from a packed clone, with an annotated release tag", () => {
    commit(r.seed, "Release");
    git(r.seed, "tag", "-a", "v0.2.0", "-m", "Release notes");
    git(r.seed, "tag", "v0.10.0-rc.1");
    git(r.seed, "tag", "not-a-release");
    // Loose first: the tag object itself is read.
    expect(readVersion(r.seed)).toEqual({ kind: "release", tag: "v0.2.0", ...expected(r.seed) });
    git(r.seed, "gc", "--quiet");
    expect(readdirSync(path.join(r.seed, ".git", "objects")).filter((d) => /^[0-9a-f]{2}$/.test(d))).toEqual([]);
    expect(readVersion(r.seed)).toEqual({ kind: "release", tag: "v0.2.0", ...expected(r.seed) });
  });

  it("picks the newest release when several tags name HEAD, packed or not", () => {
    git(r.seed, "tag", "v0.9.0");
    git(r.seed, "tag", "v0.10.0");
    expect(readVersion(r.seed)).toMatchObject({ kind: "release", tag: "v0.10.0" });
    git(r.seed, "pack-refs", "--all");
    expect(readVersion(r.seed)).toMatchObject({ kind: "release", tag: "v0.10.0" });
  });

  it("reads a fresh clone, where everything arrives in one pack", () => {
    expect(readVersion(r.clone)).toEqual({ kind: "commit", ...expected(r.clone) });
  });

  it("reads a worktree, whose .git is a file", () => {
    git(r.seed, "worktree", "add", "--quiet", "-b", "side", path.join(r.base, "side"));
    commit(path.join(r.base, "side"), "On the side");
    expect(readVersion(path.join(r.base, "side"))).toEqual({ kind: "commit", ...expected(path.join(r.base, "side")) });
  });

  it("says not a clone for a folder without .git", () => {
    mkdirSync(path.join(r.base, "plain"));
    expect(readVersion(path.join(r.base, "plain"))).toEqual({ kind: "not-a-clone" });
  });

  it("reads objects stored as deltas in a pack the same as git does", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i} of a file that changes a little each commit`);
    for (let i = 0; i < 6; i++) {
      lines[i * 50] = `changed in commit ${i}`;
      writeFileSync(path.join(r.seed, "big.txt"), lines.join("\n"));
      git(r.seed, "add", "big.txt");
      git(r.seed, "commit", "--quiet", "-m", `Big ${i}`);
    }
    git(r.seed, "repack", "-a", "-d", "-f", "--quiet", "--depth=50", "--window=50");
    const pack = readdirSync(path.join(r.seed, ".git", "objects", "pack")).find((f) => f.endsWith(".idx"))!;
    const verify = git(r.seed, "verify-pack", "-v", path.join(".git", "objects", "pack", pack));
    // Rows with a delta base carry a depth and the base's hash.
    const deltas = verify.split("\n").filter((l) => /^[0-9a-f]{40} blob +\d+ \d+ \d+ \d+ [0-9a-f]{40}$/.test(l));
    expect(deltas.length).toBeGreaterThan(0);
    for (const row of deltas) {
      const hash = row.slice(0, 40);
      expect(objectIn(r.seed, hash)?.body.toString("utf8")).toBe(git(r.seed, "cat-file", "blob", hash));
    }
    expect(readVersion(r.seed)).toEqual({ kind: "commit", ...expected(r.seed) });
  });
});

describe("applyDelta", () => {
  it("copies and inserts as the delta says", () => {
    const base = Buffer.from("hello world");
    // base size 11, result size 11: copy 6 bytes from 0, insert "there".
    const delta = Buffer.from([11, 11, 0x90, 6, 5, ...Buffer.from("there")]);
    expect(applyDelta(base, delta).toString()).toBe("hello there");
  });

  it("refuses a delta for a different base", () => {
    expect(() => applyDelta(Buffer.from("short"), Buffer.from([11, 1, 1, 0x41]))).toThrow(/base size/);
  });
});
