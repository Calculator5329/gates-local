import { describe, expect, it } from "vitest";
import { chmodSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ARCH_OFF, probeSandbox, probeSandboxWith, runSandbox, SCOPE_OFF, type SandboxHost } from "./index.ts";
import type { LibraryEntry } from "../types.ts";

const fakeHost = (over: Partial<SandboxHost>): SandboxHost => ({
  platform: "linux", arch: "x64", exists: () => true, run: async () => ({ code: 0, output: "" }), ...over,
});
describe("sandbox probe", () => {
  it("turns the shell off with a plain reason when the user scope cannot cap memory", async () => {
    for (const run of [
      async () => ({ code: 1, output: "Failed to connect to bus: No medium found" }),
      async () => ({ code: 0, output: "max\nmax\nmax" }),
    ]) expect(await probeSandboxWith(fakeHost({ run }))).toMatchObject({ available: false, reason: SCOPE_OFF });
    expect(await probeSandboxWith(fakeHost({ exists: file => !file.endsWith("systemd-run") }))).toMatchObject({ available: false, reason: SCOPE_OFF });
  });
  it("turns the shell off on an arch without a lock filter", async () => {
    expect(await probeSandboxWith(fakeHost({ arch: "riscv64" }))).toEqual({ available: false, reason: ARCH_OFF });
  });
});

const markerProcesses = (marker: string) => readdirSync("/proc").filter(pid => /^\d+$/.test(pid)).filter(pid => {
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(marker); } catch { return false; }
});

/** A folder source and a SQLite snapshot in a fresh temp dir, for tests that move them. */
const fresh = () => {
  const base = mkdtempSync(path.join(tmpdir(), "gl-shell-gone-"));
  const docs = path.join(base, "docs"); mkdirSync(docs); writeFileSync(path.join(docs, "a.txt"), "a");
  const snapshots = path.join(base, "app", "snapshots"); mkdirSync(snapshots, { recursive: true });
  const snapshot = path.join(snapshots, "ledger.db");
  const ledger = new DatabaseSync(snapshot); ledger.exec("CREATE TABLE t(n); INSERT INTO t VALUES(5)"); ledger.close();
  const folderSource: LibraryEntry = { id: "docs", label: "Docs", path: docs, kind: "folder" };
  const sqliteSource: LibraryEntry = { id: "ledger", label: "Ledger", path: path.join(base, "live.db"), snapshotPath: snapshot, kind: "sqlite" };
  // Every host path the model must never read: the source roots, the data dir, home, the worktree.
  const hostPaths = [base, docs, snapshots, path.dirname(snapshots), homedir(), process.cwd()];
  return { base, docs, snapshot, folderSource, sqliteSource, hostPaths };
};
const outcome = (input: Parameters<typeof runSandbox>[0]) => runSandbox(input).then(output => `ran: ${output}`, (e: Error) => e.message);
const noHostPath = (message: string, hostPaths: readonly string[]) => { for (const host of hostPaths) expect(message, host).not.toContain(host); };

const probe = await probeSandbox();
const bwrapAbsent = !probe.available && /bubblewrap|cannot create its sandbox/.test(probe.reason);
describe.skipIf(bwrapAbsent)(`real bwrap confinement${probe.available ? "" : ` [${bwrapAbsent ? "SKIP" : "OFF"}: ${probe.reason}]`}`, () => {
  const root = mkdtempSync(path.join(tmpdir(), "gl-bwrap-"));
  const snapshotPath = path.join(root, "test.db");
  const db = new DatabaseSync(snapshotPath); db.exec("CREATE TABLE t(n); INSERT INTO t VALUES(42)"); db.close();
  const folder = path.join(root, "folder"); mkdirSync(folder);
  writeFileSync(path.join(folder, "note.txt"), "hello");
  const livePath = path.join(folder, "live.db");
  const live = new DatabaseSync(livePath); live.exec("CREATE TABLE t(n); INSERT INTO t VALUES(1)"); live.close();
  const sources: LibraryEntry[] = [
    { id: "test", label: "test.db", path: snapshotPath, snapshotPath, kind: "sqlite" },
    { id: "folder", label: "folder", path: folder, kind: "folder" },
  ];
  it("is available on this machine", () => { expect(probe).toMatchObject({ available: true }); });
  it("SELECT returns real rows", async () => {
    expect(await runSandbox({ command: 'sqlite3 /data/test.db "SELECT * FROM t"', sources })).toContain("42");
  });
  for (const [name, command] of [
    ["CTE delete", 'sqlite3 /data/test.db "WITH x AS (SELECT 1) DELETE FROM t"'],
    ["pragma write", 'sqlite3 /data/test.db "PRAGMA user_version=7"'],
    ["data write", "echo nope > /data/test.db"],
    ["home read", `ls ${JSON.stringify(homedir())}`],
    ["network", "bash -c 'echo hi > /dev/tcp/1.1.1.1/80'"],
    ["root write", "echo nope > /escape"],
    ["library write", "echo nope > /library/folder/new.txt"],
    ["library root write", "echo nope > /library/new.txt"],
    ["nested user namespace", "unshare -U true"],
    ["flock", "flock /tmp/lock true"],
    ["fcntl lock", `python3 -c 'import fcntl; fcntl.lockf(open("/tmp/lock", "w"), fcntl.LOCK_EX | fcntl.LOCK_NB)'`],
    ["sqlite3 without the wrapper on a snapshot", '/usr/bin/sqlite3 /data/test.db "SELECT * FROM t"'],
  ]) it(`${name} fails`, async () => { await expect(runSandbox({ command: command!, sources })).rejects.toThrow(); });
  it("allows fcntl calls that take no lock", async () => {
    expect(await runSandbox({ command: `python3 -c 'import fcntl, os; fd = os.open("/tmp/x", os.O_CREAT | os.O_RDWR); fcntl.fcntl(fd, fcntl.F_GETFL); print("ok")'`, sources })).toContain("ok");
  });
  it("the home read is a real path that exists outside the sandbox", () => { expect(existsSync(homedir())).toBe(true); });
  it("sees only the loopback interface", async () => {
    const devices = (await runSandbox({ command: "cat /proc/net/dev", sources })).split("\n").slice(2).filter(Boolean).map(l => l.split(":")[0]!.trim());
    expect(devices).toEqual(["lo"]);
  });
  it("caps /tmp at 64 MiB: a 200M write fails", async () => {
    await expect(runSandbox({ command: "head -c 200M /dev/zero > /tmp/big", sources })).rejects.toThrow(/No space left/);
    expect(await runSandbox({ command: "head -c 1M /dev/zero > /tmp/small && echo ok", sources })).toContain("ok");
  });
  it("kills a process that allocates 1 GiB inside the scope and returns an error", async () => {
    const before = process.memoryUsage().rss;
    await expect(runSandbox({ command: "python3 -c \"x = b'a' * (1 << 30); print('allocated')\"", sources, timeoutMs: 30000 })).rejects.toThrow(/killed|memory/i);
    expect(process.memoryUsage().rss - before).toBeLessThan(256 * 1024 * 1024);
    expect(await runSandbox({ command: "echo still here", sources })).toContain("still here");
  }, 40000);
  it("an OOM kill of one process leaves the rest of the shell running", async () => {
    // With the scope's default OOM policy (stop), systemd stops the whole scope and
    // marks it failed with result oom-kill, which also raises a desktop OOM notice.
    const out = await runSandbox({ command: "python3 -c \"x = b'a' * (1 << 30)\"; echo \"after the hog: $?\"", sources, timeoutMs: 30000 });
    expect(out).toContain("after the hog: 137");
  }, 40000);
  it("hits the task cap before 200 background sleeps", async () => {
    const spawnMany = 'import subprocess\nps = []\ntry:\n    for i in range(200): ps.append(subprocess.Popen(["sleep", "30"]))\nexcept OSError as e:\n    print("capped at", len(ps), e.errno)\n    raise SystemExit(3)\nprint("ran", len(ps))';
    const error = await runSandbox({ command: `python3 -c '${spawnMany}'`, sources, timeoutMs: 20000 }).then(() => undefined, (e: Error) => e);
    expect(error?.message).toMatch(/capped at (\d+)/);
    expect(Number(error!.message.match(/capped at (\d+)/)![1])).toBeLessThan(64);
  }, 30000);
  it("never locks a live database in a folder source: the host writes while the sandbox reads", async () => {
    const reader = runSandbox({ command: "(echo 'BEGIN; SELECT count(*) FROM t;'; sleep 2) | sqlite3 /library/folder/live.db; sleep 1", sources, timeoutMs: 10000 }).catch((e: Error) => e.message);
    await new Promise(r => setTimeout(r, 800));
    const writer = new DatabaseSync(livePath, { timeout: 0 });
    try { writer.exec("BEGIN IMMEDIATE; INSERT INTO t VALUES(2); COMMIT"); } finally { writer.close(); }
    await reader;
    const check = new DatabaseSync(livePath, { readOnly: true });
    try { expect(check.prepare("SELECT count(*) AS n FROM t").get()?.n).toBe(2); } finally { check.close(); }
  }, 15000);
  it("never holds a lease on a Library file: the host opens it for writing while the sandbox tries", async () => {
    const leased = path.join(folder, "lease.txt"); writeFileSync(leased, "data");
    // F_SETLEASE is 1024, F_RDLCK 0. SIGIO (the lease-break signal) is ignored so a granted
    // lease is held for the whole sleep instead of killing the holder.
    const lease = "import fcntl, os, signal, time\nsignal.signal(signal.SIGIO, signal.SIG_IGN)\nfd = os.open('/library/folder/lease.txt', os.O_RDONLY)\nfcntl.fcntl(fd, 1024, 0)\nprint('leased', flush=True)\ntime.sleep(2)";
    const holder = runSandbox({ command: `python3 -c "${lease}"; s=$?; sleep 2; exit $s`, sources, timeoutMs: 10000 }).then(() => "ran", (e: Error) => e);
    await new Promise(r => setTimeout(r, 800));
    let opened: string;
    try { closeSync(openSync(leased, constants.O_WRONLY | constants.O_NONBLOCK)); opened = "opened"; }
    catch (e) { opened = (e as NodeJS.ErrnoException).code ?? String(e); }
    expect(opened).toBe("opened");
    const result = await holder;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).not.toContain("leased");
  }, 15000);
  describe("setup failures name virtual paths, never a host path (T2-02)", () => {
    it("a folder source renamed between the check and the bind", async () => {
      const t = fresh();
      const message = await outcome({ command: "ls /library/docs", sources: [t.folderSource], beforeLaunch: () => renameSync(t.docs, `${t.docs}-moved`) });
      expect(message).toBe("/library/docs: no longer available (its folder was moved or removed)");
      noHostPath(message, t.hostPaths);
    });
    it("a folder source gone or unreadable when the call starts", async () => {
      const t = fresh();
      renameSync(t.docs, `${t.docs}-moved`);
      const gone = await outcome({ command: "ls /library/docs", sources: [t.folderSource] });
      expect(gone).toBe("/library/docs: no longer available (its folder was moved or removed)");
      noHostPath(gone, t.hostPaths);
      renameSync(`${t.docs}-moved`, t.docs);
      chmodSync(t.base, 0o000);
      try {
        const shut = await outcome({ command: "ls /library/docs", sources: [t.folderSource] });
        expect(shut).toBe("/library/docs: no longer available (its folder can no longer be read)");
        noHostPath(shut, t.hostPaths);
      } finally { chmodSync(t.base, 0o700); }
    });
    it("a SQLite snapshot renamed between the check and the bind, or gone when the call starts", async () => {
      const t = fresh();
      const raced = await outcome({ command: 'sqlite3 /data/ledger.db "SELECT * FROM t"', sources: [t.folderSource, t.sqliteSource], beforeLaunch: () => renameSync(t.snapshot, `${t.snapshot}.moved`) });
      expect(raced).toBe("/data/ledger.db: no longer available (the source was removed during this reply)");
      noHostPath(raced, t.hostPaths);
      const gone = await outcome({ command: 'sqlite3 /data/ledger.db "SELECT * FROM t"', sources: [t.sqliteSource] });
      expect(gone).toBe("/data/ledger.db: no longer available (the source was removed during this reply)");
      noHostPath(gone, t.hostPaths);
    });
    it("a bwrap setup error whose raw text holds a host path gives a fixed sentence and the virtual path", async () => {
      const t = fresh();
      const launcher = path.join(t.base, "fake-systemd-run");
      writeFileSync(launcher, `#!/usr/bin/sh\nprintf '%s\\n' "bwrap: Can't bind mount /oldroot${t.docs} on /newroot/library/docs: Permission denied" >&2\nexit 1\n`, { mode: 0o755 });
      const message = await outcome({ command: "ls /library/docs", sources: [t.folderSource, t.sqliteSource], launcher });
      expect(message).toBe("The shell sandbox could not start while setting up /library/docs.");
      noHostPath(message, t.hostPaths);
      // Text with no host path in it is kept, after the virtual paths involved.
      writeFileSync(launcher, "#!/usr/bin/sh\necho 'Failed to start transient scope unit: Unit already exists.' >&2\nexit 1\n", { mode: 0o755 });
      expect(await outcome({ command: "ls /library/docs", sources: [t.folderSource, t.sqliteSource], launcher }))
        .toBe("The shell sandbox could not start while setting up /library/docs, /data/ledger.db: Failed to start transient scope unit: Unit already exists.");
    });
    it("the command's own failure output inside the sandbox is unchanged", async () => {
      const t = fresh();
      expect(await outcome({ command: "ls /library/docs/missing", sources: [t.folderSource] }))
        .toBe("Shell exited 2: ls: cannot access '/library/docs/missing': No such file or directory\n");
    });
  });
  it("kills commands over the time and output limits, and nothing outlives a timeout", async () => {
    const marker = `98${Date.now() % 100000}.5`;
    await expect(runSandbox({ command: `sleep ${marker} & sleep ${marker} & wait`, sources, timeoutMs: 500 })).rejects.toThrow(/time limit/);
    await new Promise(r => setTimeout(r, 300));
    expect(markerProcesses(marker)).toEqual([]);
    await expect(runSandbox({ command: "yes", sources, outputCap: 100 })).rejects.toThrow(/output limit/);
  });
});
