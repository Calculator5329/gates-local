// What an update would do, worked out from git: the version this copy runs,
// the target on its channel and the changes in between, or why there is no
// update to take. Both the Settings check (server) and the update command
// (scripts/update.ts) use inspect(); only the command then changes anything.
//
// Channels:
// - main: the newest commit on the clone's upstream branch.
// - release: the newest release tag (v1.2.3, semver.ts) on the remote. Never
//   backwards: a copy already past that tag is up to date.
// - auto (the default): release once the remote has a release tag, main
//   until then. Settings can pin main.
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { lastLines, type RunResult, type Runner } from "./run.ts";
import { newestRelease } from "./semver.ts";
import { readTransaction } from "./transaction.ts";

export type Channel = "main" | "release";
/** What the person chose: auto follows releases once there are any; main pins every change. */
export type ChannelChoice = "auto" | Channel;

/** At most this many change subjects are listed; the rest are counted. */
export const MAX_CHANGES = 20;

const FETCH_MS = 90_000;
const LOCAL_MS = 30_000;

export interface Commit {
  readonly commit: string;
  /** A release tag when the commit has one, else the short commit. */
  readonly label: string;
}

export type Blocked =
  | { readonly reason: "no-git" }
  | { readonly reason: "not-a-clone" }
  /** Not on a branch, or the branch has no upstream to update from. */
  | { readonly reason: "no-upstream"; readonly detail: string }
  /** Tracked files with changes not committed. Untracked and ignored files never count. */
  | { readonly reason: "local-changes"; readonly files: readonly string[] }
  /** git fetch or ls-remote failed: offline, or the remote refused. */
  | { readonly reason: "remote"; readonly detail: string }
  /** Commits here that the target does not have. Never merged or reset over. */
  | { readonly reason: "local-commits"; readonly count: number; readonly subjects: readonly string[] }
  /** --channel release with no release tag on the remote yet. */
  | { readonly reason: "no-releases" }
  /** The target is not ahead of this copy on the same line (a release tag off the branch). */
  | { readonly reason: "diverged"; readonly target: string }
  /** The last update was cut off, so the commit here proves nothing about the install and builds. */
  | { readonly reason: "unfinished"; readonly target: string };

export type Inspection =
  | { readonly state: "blocked"; readonly blocked: Blocked }
  | (Found & { readonly state: "up-to-date" })
  | (Found & { readonly state: "available" });

interface Found {
  readonly channel: Channel;
  readonly head: Commit;
  readonly target: Commit;
  /** Commit subjects from head to target, newest first, at most MAX_CHANGES. */
  readonly changes: readonly string[];
  /** How many commits head to target, all of them. */
  readonly total: number;
  /** A release's tag message. */
  readonly notes?: string;
}

export interface InspectOptions {
  readonly root: string;
  readonly runner: Runner;
  readonly choice: ChannelChoice;
  readonly log?: (chunk: string) => void;
}

export type Git = (args: readonly string[], timeoutMs?: number) => Promise<RunResult>;

export function gitIn(root: string, runner: Runner, log?: (chunk: string) => void): Git {
  return (args, timeoutMs = LOCAL_MS) => {
    log?.(`$ git ${args.join(" ")}\n`);
    return runner("git", args, { cwd: root, timeoutMs, ...(log ? { onOutput: log } : {}) });
  };
}

const ok = (r: RunResult) => r.code === 0;
const out = (r: RunResult) => r.stdout.trim();

/** git on PATH. */
export async function hasGit(git: Git): Promise<boolean> {
  return ok(await git(["--version"]));
}

/**
 * The folder is the top of its own git clone: it holds .git, and git agrees
 * the top is this folder (never a repository further up).
 */
export async function isClone(root: string, git: Git): Promise<boolean> {
  if (!existsSync(path.join(root, ".git"))) return false;
  const top = await git(["rev-parse", "--show-toplevel"]);
  if (!ok(top)) return false;
  try {
    return realpathSync(out(top)) === realpathSync(root);
  } catch {
    return false;
  }
}

/** A release tag at the commit, else its short commit. */
export async function labelOf(git: Git, commit: string): Promise<string> {
  const tags = await git(["tag", "--points-at", commit, "--list", "v*"]);
  const tag = ok(tags) ? newestRelease(out(tags).split("\n")) : undefined;
  if (tag !== undefined) return tag;
  const short = await git(["rev-parse", "--short", commit]);
  return ok(short) ? out(short) : commit.slice(0, 7);
}

export interface Upstream {
  readonly branch: string;
  readonly remote: string;
  /** refs/remotes/<remote>/<branch> */
  readonly ref: string;
}

export async function upstreamOf(git: Git): Promise<Upstream | Blocked> {
  const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!ok(branch)) return { reason: "no-upstream", detail: "This copy is not on a branch." };
  const name = out(branch);
  const ref = await git(["rev-parse", "--symbolic-full-name", "@{upstream}"]);
  const remote = await git(["config", "--get", `branch.${name}.remote`]);
  if (!ok(ref) || out(ref) === "" || !ok(remote) || out(remote) === "" || out(remote) === ".") {
    return { reason: "no-upstream", detail: `The branch ${name} has no upstream branch to update from.` };
  }
  return { branch: name, remote: out(remote), ref: out(ref) };
}

/** Tracked files with changes, staged or not. */
export async function changedFiles(git: Git): Promise<string[] | Blocked> {
  const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=no"]);
  if (!ok(status)) return { reason: "no-upstream", detail: lastLines(status) };
  const files: string[] = [];
  const parts = status.stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] ?? "";
    if (entry.length < 4) continue;
    files.push(entry.slice(3));
    // A rename or copy carries its old path as the next field.
    if (entry[0] === "R" || entry[0] === "C") i++;
  }
  return files;
}

/** The remote's release tags and the commit each names (annotated tags peeled). */
async function remoteReleases(git: Git, remote: string): Promise<Map<string, string> | Blocked> {
  const listed = await git(["ls-remote", "--tags", remote, "refs/tags/v*"], FETCH_MS);
  if (!ok(listed)) return { reason: "remote", detail: lastLines(listed) || "git ls-remote failed" };
  const tags = new Map<string, string>();
  const peeled = new Map<string, string>();
  for (const line of out(listed).split("\n")) {
    const [sha, ref] = line.split("\t");
    if (sha === undefined || ref === undefined || !ref.startsWith("refs/tags/")) continue;
    const name = ref.slice("refs/tags/".length);
    if (name.endsWith("^{}")) peeled.set(name.slice(0, -3), sha);
    else tags.set(name, sha);
  }
  for (const [name, sha] of peeled) tags.set(name, sha);
  return tags;
}

export const isBlocked = (v: unknown): v is Blocked => typeof v === "object" && v !== null && "reason" in v;

/**
 * Everything short of changing the copy: preconditions, then git fetch and
 * ls-remote (the two network calls, both to the clone's own remote), the
 * target and the changes. Changes nothing but the remote-tracking refs and
 * tags that fetch brings.
 */
const blocked = (b: Blocked): Inspection => ({ state: "blocked", blocked: b });

export async function inspect(o: InspectOptions): Promise<Inspection> {
  const git = gitIn(o.root, o.runner, o.log);
  if (!(await hasGit(git))) return blocked({ reason: "no-git" });
  if (!(await isClone(o.root, git))) return blocked({ reason: "not-a-clone" });
  // Before "up to date" can be said: an update the last run left half done is finished by the update, not a check.
  const unfinished = readTransaction(o.root);
  if (unfinished !== null) return blocked({ reason: "unfinished", target: unfinished.to.label });
  const upstream = await upstreamOf(git);
  if (isBlocked(upstream)) return blocked(upstream);
  const files = await changedFiles(git);
  if (isBlocked(files)) return blocked(files);
  if (files.length > 0) return blocked({ reason: "local-changes", files });

  const fetched = await git(["fetch", "--quiet", "--tags", upstream.remote], FETCH_MS);
  if (!ok(fetched)) return blocked({ reason: "remote", detail: lastLines(fetched) || "git fetch failed" });
  const releases = await remoteReleases(git, upstream.remote);
  if (isBlocked(releases)) return blocked(releases);
  const newest = newestRelease([...releases.keys()]);

  const channel: Channel = o.choice === "auto" ? (newest === undefined ? "main" : "release") : o.choice;
  if (channel === "release" && newest === undefined) return blocked({ reason: "no-releases" });

  const headSha = out(await git(["rev-parse", "HEAD"]));
  const targetRev = channel === "release" ? releases.get(newest!)! : upstream.ref;
  const resolved = await git(["rev-parse", "--verify", "--quiet", `${targetRev}^{commit}`]);
  if (!ok(resolved)) return blocked({ reason: "remote", detail: `the update ${channel === "release" ? newest! : upstream.ref} was not downloaded` });
  const targetSha = out(resolved);
  const head: Commit = { commit: headSha, label: await labelOf(git, headSha) };
  const target: Commit = { commit: targetSha, label: channel === "release" ? newest! : await labelOf(git, targetSha) };
  const notes = channel === "release" ? await tagNotes(git, newest!) : undefined;
  const withNotes = notes ? { notes } : {};

  // Never backwards: a target this copy already contains is up to date.
  if (ok(await git(["merge-base", "--is-ancestor", targetSha, headSha]))) {
    return { state: "up-to-date", channel, head, target, changes: [], total: 0, ...withNotes };
  }
  if (!ok(await git(["merge-base", "--is-ancestor", headSha, targetSha]))) {
    // Commits here that the remote branch does not have are the person's own.
    const own = await git(["rev-list", "--count", `${upstream.ref}..${headSha}`]);
    const count = Number(out(own));
    if (ok(own) && count > 0) {
      const subjects = await git(["log", "-n", String(MAX_CHANGES), "--format=%s", `${upstream.ref}..${headSha}`]);
      return blocked({ reason: "local-commits", count, subjects: ok(subjects) ? out(subjects).split("\n").filter((s) => s !== "") : [] });
    }
    return blocked({ reason: "diverged", target: target.label });
  }
  const count = await git(["rev-list", "--count", `${headSha}..${targetSha}`]);
  const subjects = await git(["log", "-n", String(MAX_CHANGES), "--format=%s", `${headSha}..${targetSha}`]);
  return {
    state: "available",
    channel,
    head,
    target,
    changes: ok(subjects) ? out(subjects).split("\n").filter((s) => s !== "") : [],
    total: ok(count) ? Number(out(count)) : 0,
    ...withNotes,
  };
}

async function tagNotes(git: Git, tag: string): Promise<string | undefined> {
  // Annotated tags only: a lightweight tag has no message of its own.
  const type = await git(["cat-file", "-t", `refs/tags/${tag}`]);
  if (!ok(type) || out(type) !== "tag") return undefined;
  const r = await git(["tag", "--list", "--format=%(contents)", tag]);
  const text = ok(r) ? out(r) : "";
  return text === "" ? undefined : text;
}
