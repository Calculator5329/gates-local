// The checkout's lock and the saved transaction: stale owners, and the race
// between two runs both clearing one.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runUpdate } from "./apply.ts";
import { UpdateGuardError } from "./guard.ts";
import { HEARTBEAT_MS, LOCK_FILE, STALE_MS, acquireLock, lockHolder, stateDir, takeAway } from "./lock.ts";
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
const owner = (pid: number) => JSON.stringify({ pid, startedAt: 1, token: "someone" });
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
    expect(acquireLock(r.clone)).toEqual({ ok: false, pid: process.pid });
    expect(lockHolder(r.clone)).toEqual({ pid: process.pid });
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

  it("waits for a live owner, however old its lock, until its heartbeat has stopped", () => {
    writeFileSync(lockFile, owner(process.pid));
    age(lockFile, STALE_MS - 60_000);
    expect(acquireLock(r.clone).ok).toBe(false);
    // The pid was reused by something else, or the owner hangs.
    age(lockFile, STALE_MS + 60_000);
    taken(acquireLock(r.clone)).release();
  });

  it("treats a file with no owner in it as being written, then as stale", () => {
    writeFileSync(lockFile, "");
    expect(acquireLock(r.clone)).toEqual({ ok: false, pid: null });
    age(lockFile, 120_000);
    taken(acquireLock(r.clone)).release();
  });

  it("two takers of a stale lock: the one that judged an older file puts a live lock back", () => {
    const judged = owner(DEAD);
    writeFileSync(lockFile, judged);
    // The other taker clears it and takes the lock, after this one read the dead owner.
    expect(takeAway(lockFile, judged)).toBe(true);
    const live = taken(acquireLock(r.clone));
    expect(takeAway(lockFile, judged)).toBe(false);
    expect(live.stillOurs()).toBe(true);
    expect(acquireLock(r.clone).ok).toBe(false);
    live.release();
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

  it("keeps a long step's lock fresh, so a slow install does not read as stale", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const lock = taken(acquireLock(r.clone));
      age(lockFile, STALE_MS + 60_000);
      vi.advanceTimersByTime(HEARTBEAT_MS);
      expect(acquireLock(r.clone).ok).toBe(false);
      lock.release();
    } finally {
      vi.useRealTimers();
    }
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
    await expect(update(fake)).rejects.toThrow();
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
