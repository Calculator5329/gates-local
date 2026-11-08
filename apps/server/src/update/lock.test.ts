// The checkout's lock and the saved transaction: stale owners, and the race
// between two runs both clearing one.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runUpdate } from "./apply.ts";
import { UpdateGuardError } from "./guard.ts";
import { LOCK_FILE, acquireLock, lockHolder, stateDir } from "./lock.ts";
import type { Runner } from "./run.ts";
import { type Repos, commit, fakePnpm, git, head, makeRepos, publish, removeRepos, testEnv } from "./testing.ts";
import { TRANSACTION_FILE, clearTransaction, readTransaction, saveTransaction } from "./transaction.ts";

let r: Repos;
let lockFile: string;

beforeEach(() => {
  r = makeRepos();
  for (const [k, v] of Object.entries(testEnv(r.base))) vi.stubEnv(k, v);
  lockFile = path.join(r.clone, ".git", LOCK_FILE);
});

afterEach(() => {
  vi.unstubAllEnvs();
  removeRepos(r);
});

const DEAD = 999_999_999;
const DAY = 24 * 60 * 60_000;
const owner = (pid: number, start: string | null = null) => JSON.stringify({ pid, start, startedAt: 1, token: "someone" });
const age = (file: string, ms: number) => {
  const at = new Date(Date.now() - ms);
  utimesSync(file, at, at);
};
const taken = (x: ReturnType<typeof acquireLock>) => {
  if (!x.ok) throw new Error("expected the lock");
  return x.lock;
};

describe("the checkout's lock", () => {
  it("is held in the checkout's git folder, excludes a second taker, and is gone after release", () => {
    const lock = taken(acquireLock(r.clone));
    expect(statSync(lockFile).isFile()).toBe(true);
    expect(git(r.clone, "status", "--porcelain", "--ignored")).toBe("");
    expect(acquireLock(r.clone)).toEqual({ ok: false, pid: process.pid, file: lockFile });
    expect(lockHolder(r.clone)).toEqual({ pid: process.pid, file: lockFile });
    lock.release();
    expect(lockHolder(r.clone)).toBeNull();
    taken(acquireLock(r.clone)).release();
  });

  it("recovers from an owner whose process is gone", () => {
    writeFileSync(lockFile, owner(DEAD));
    expect(lockHolder(r.clone)).toBeNull();
    const lock = taken(acquireLock(r.clone));
    expect(lock.stillOurs()).toBe(true);
    lock.release();
  });

  it("never takes over from a live owner, however old its lock or wherever the clock has gone", () => {
    writeFileSync(lockFile, owner(process.pid));
    age(lockFile, DAY);
    expect(acquireLock(r.clone)).toEqual({ ok: false, pid: process.pid, file: lockFile });
    expect(acquireLock(r.clone, { now: () => Date.now() + 365 * DAY }).ok).toBe(false);
    expect(lockHolder(r.clone)).toEqual({ pid: process.pid, file: lockFile });
    expect(readFileSync(lockFile, "utf8")).toBe(owner(process.pid));
  });

  it("knows a reused pid by its start time, so another program with that number does not hold updates forever", () => {
    writeFileSync(lockFile, owner(process.pid, "started long ago"));
    expect(lockHolder(r.clone, { startOf: () => "started just now" })).toBeNull();
    taken(acquireLock(r.clone, { startOf: () => "started just now" })).release();
  });

  it("keeps refusing when the same process is still there, or its start time cannot be read", () => {
    writeFileSync(lockFile, owner(process.pid, "the same start"));
    expect(acquireLock(r.clone, { startOf: () => "the same start" }).ok).toBe(false);
    expect(acquireLock(r.clone, { startOf: () => null }).ok).toBe(false);
    writeFileSync(lockFile, owner(process.pid, null));
    expect(acquireLock(r.clone, { startOf: () => "anything" }).ok).toBe(false);
  });

  it("treats a file with no owner in it as being written, then as stale", () => {
    writeFileSync(lockFile, "");
    expect(acquireLock(r.clone)).toEqual({ ok: false, pid: null, file: lockFile });
    age(lockFile, 120_000);
    taken(acquireLock(r.clone)).release();
  });

  it("does not remove a lock that has become someone else's", () => {
    const lock = taken(acquireLock(r.clone));
    writeFileSync(lockFile, owner(process.pid));
    expect(lock.stillOurs()).toBe(false);
    lock.release();
    expect(readFileSync(lockFile, "utf8")).toBe(owner(process.pid));
  });

  it("uses the git folder a linked worktree names", () => {
    const linked = path.join(r.base, "linked");
    git(r.clone, "worktree", "add", "--quiet", linked);
    const dir = stateDir(linked);
    expect(dir).toContain(path.join(".git", "worktrees"));
    const lock = taken(acquireLock(linked));
    // A different checkout of the same repository is free to update.
    const other = taken(acquireLock(r.clone));
    other.release();
    lock.release();
  });

  it("is refused outside the test root before it writes anything", () => {
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "gl-update-outside-")));
    try {
      expect(() => acquireLock(outside)).toThrow(UpdateGuardError);
      expect(() => saveTransaction(outside, { channel: "main", branch: "main", from: { commit: "a", label: "a" }, to: { commit: "b", label: "b" }, changes: 1, phase: "forward" })).toThrow(UpdateGuardError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

const claims = () => readdirSync(path.dirname(lockFile)).filter((f) => f.includes(".takeover."));

describe("taking over from a dead owner", () => {
  it("A judges a dead lock and pauses, B takes it, C arrives in A's gap: B alone holds it", () => {
    writeFileSync(lockFile, owner(DEAD));
    let b: ReturnType<typeof taken> | undefined;
    let c: ReturnType<typeof acquireLock> | undefined;
    const a = acquireLock(r.clone, {
      pauseAt: (at) => {
        if (at === "judged") b = taken(acquireLock(r.clone));
        else c = acquireLock(r.clone);
      },
    });
    expect(b?.stillOurs()).toBe(true);
    expect(a.ok).toBe(false);
    expect(c?.ok).toBe(false);
    expect(acquireLock(r.clone).ok).toBe(false);
    b?.release();
    expect(claims()).toEqual([]);
  });

  it("C arriving while A is replacing the lock is refused, and the path is never empty", () => {
    writeFileSync(lockFile, owner(DEAD));
    const seen: boolean[] = [];
    let c: ReturnType<typeof acquireLock> | undefined;
    const a = taken(acquireLock(r.clone, {
      pauseAt: (at) => {
        if (at !== "taking-over") return;
        seen.push(existsSync(lockFile));
        c = acquireLock(r.clone);
      },
    }));
    expect(seen).toEqual([true]);
    expect(c?.ok).toBe(false);
    expect(a.stillOurs()).toBe(true);
    expect(claims()).toEqual([]);
    a.release();
  });

  it("a takeover whose holder died does not block the next one", () => {
    writeFileSync(lockFile, owner(DEAD));
    expect(() => acquireLock(r.clone, { pauseAt: (at) => { if (at === "taking-over") throw new Error("the power went out"); } })).toThrow("the power went out");
    const [claim] = claims();
    expect(claim).toBeDefined();
    writeFileSync(path.join(path.dirname(lockFile), claim!), owner(DEAD));
    const lock = taken(acquireLock(r.clone));
    expect(claims()).toEqual([]);
    lock.release();
  });

  it("a takeover in progress by a live run is left to finish", () => {
    writeFileSync(lockFile, owner(DEAD));
    expect(() => acquireLock(r.clone, { pauseAt: (at) => { if (at === "taking-over") throw new Error("paused"); } })).toThrow("paused");
    expect(claims()).toHaveLength(1);
    expect(acquireLock(r.clone).ok).toBe(false);
    expect(readFileSync(lockFile, "utf8")).toBe(owner(DEAD));
  });
});

const update = (fake: ReturnType<typeof fakePnpm> = fakePnpm()) =>
  runUpdate({ root: r.clone, runner: fake.runner, choice: "auto", pnpm: fake.pnpm, appRunning: () => null, checkOnly: false, say: () => undefined, log: () => undefined });

describe("a run that loses the lock", () => {
  it("stops before its next change and leaves the new owner's state alone", async () => {
    const target = commit(r.seed, "Newer");
    publish(r.seed);
    const fake = fakePnpm();
    // Paused past the limit at the install: another run took over and holds the file now.
    const runner: Runner = async (command, args, options) => {
      if (command === "fake-pnpm" && args[0] === "--version") return fake.runner(command, args, options);
      if (command === "fake-pnpm") throw new Error("a step ran after the lock was lost");
      if (command === "git" && args[0] === "merge") {
        const result = await fake.runner(command, args, options);
        writeFileSync(lockFile, owner(process.pid));
        return result;
      }
      return fake.runner(command, args, options);
    };
    const run = await update({ ...fake, runner });
    expect(run).toEqual({ outcome: "refused", refusal: { reason: "lost-lock" } });
    expect(head(r.clone)).toBe(target);
    expect(readFileSync(lockFile, "utf8")).toBe(owner(process.pid));
    expect(readTransaction(r.clone)).not.toBeNull();
  });

  it("does not go back once the lock is lost, so a newer update is not undone", async () => {
    const target = commit(r.seed, "Newer");
    publish(r.seed);
    const fake = fakePnpm();
    const runner: Runner = async (command, args, options) => {
      if (command === "fake-pnpm" && args[0] === "install") {
        writeFileSync(lockFile, owner(process.pid));
        return { code: 1, stdout: "", stderr: "failed" };
      }
      return fake.runner(command, args, options);
    };
    const run = await update({ ...fake, runner });
    expect(run).toEqual({ outcome: "refused", refusal: { reason: "lost-lock" } });
    expect(head(r.clone)).toBe(target);
  });
});

describe("the saved transaction", () => {
  const t = { channel: "main", branch: "main", from: { commit: "a", label: "a" }, to: { commit: "b", label: "b" }, changes: 2, phase: "forward" } as const;

  it("is on disk before the checkout moves, naming where it started, and gone after a finished update", async () => {
    const old = head(r.clone);
    const target = commit(r.seed, "Newer");
    publish(r.seed);
    const fake = fakePnpm();
    let atMerge: ReturnType<typeof readTransaction> | undefined;
    let headAtMerge: string | undefined;
    const runner: Runner = async (command, args, options) => {
      if (command === "git" && args[0] === "merge") {
        atMerge = readTransaction(r.clone);
        headAtMerge = head(r.clone);
      }
      return fake.runner(command, args, options);
    };
    expect((await update({ ...fake, runner })).outcome).toBe("updated");
    expect(headAtMerge).toBe(old);
    expect(atMerge).toMatchObject({ phase: "forward", branch: "main", from: { commit: old }, to: { commit: target }, changes: 1 });
    expect(readTransaction(r.clone)).toBeNull();
  });

  it("stops the update without moving anything when it cannot be saved", async () => {
    const old = head(r.clone);
    commit(r.seed, "Newer");
    publish(r.seed);
    // A folder where the temporary file would go: the save fails the way a full disk does.
    mkdirSync(`${path.join(r.clone, ".git", TRANSACTION_FILE)}.${process.pid}.tmp`);
    const fake = fakePnpm();
    expect(await update(fake)).toMatchObject({ outcome: "refused", refusal: { reason: "cannot-save", pid: null } });
    expect(head(r.clone)).toBe(old);
    expect(fake.commands.filter((c) => c.startsWith("git merge --ff-only"))).toEqual([]);
  });

  it("is gone after a merge that refused, so the next run starts clean", async () => {
    commit(r.seed, "Newer");
    publish(r.seed);
    const fake = fakePnpm();
    const runner: Runner = async (command, args, options) => (command === "git" && args[0] === "merge" ? { code: 1, stdout: "", stderr: "fatal: no" } : fake.runner(command, args, options));
    expect(await update({ ...fake, runner })).toMatchObject({ outcome: "stopped", step: "switch" });
    expect(readTransaction(r.clone)).toBeNull();
  });

  it("is written whole, read back and cleared", () => {
    saveTransaction(r.clone, t);
    expect(readTransaction(r.clone)).toEqual(t);
    clearTransaction(r.clone);
    expect(readTransaction(r.clone)).toBeNull();
    clearTransaction(r.clone);
  });

  it("keeps a going-back step and reason", () => {
    const back = { ...t, phase: "back", step: "install", reason: "ERR" } as const;
    saveTransaction(r.clone, back);
    expect(readTransaction(r.clone)).toEqual(back);
  });

  it("reads a damaged or unknown file as none", () => {
    const file = path.join(r.clone, ".git", TRANSACTION_FILE);
    for (const text of ["{not json", "{}", JSON.stringify({ ...t, version: 2 }), JSON.stringify({ version: 1, ...t, phase: "back" }), JSON.stringify({ version: 1, ...t, phase: "elsewhere" }), JSON.stringify({ version: 1, ...t, changes: -1 })]) {
      writeFileSync(file, text);
      expect(readTransaction(r.clone)).toBeNull();
    }
  });
});
