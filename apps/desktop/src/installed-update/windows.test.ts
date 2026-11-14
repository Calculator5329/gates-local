// Windows W-A (design section 3): the click, a refused installer, the note the
// next launch reads, and the kept installer the status page names. The
// installer runs only on Windows; here a shell script or a file that cannot
// run stands in for it, through the same spawn.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIST_FILE, SIGNATURE_FILE, verifyPrepared } from "../../../server/src/update/installed/download.ts";
import { artifactFile, listFor, releaseKey, sha512 } from "../../../server/src/update/installed/testing.ts";
import { readRecord } from "../../../server/src/update/record.ts";
import { goBackInstaller, INSTALLER_ARGS, pendingFile, settlePending, startInstaller, startWindowsUpdate, writePending, type WindowsClick } from "./windows.ts";

const key = releaseKey();
const RUNNING = "1.2.3";
const NEXT = "1.3.0";
const BYTES = randomBytes(4_000);

let dataDir: string;
beforeEach(() => {
  const cache = path.join(homedir(), ".cache");
  fs.mkdirSync(cache, { recursive: true });
  dataDir = fs.mkdtempSync(path.join(cache, "windows-update-test-"));
});
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

/** A version folder as the download leaves it: the signed list, its signature and the installer. */
function prepare(version: string, bytes: Buffer = BYTES): { file: string; digest: string } {
  const folder = path.join(dataDir, "updates", version);
  const signed = listFor(version, BYTES, key.privateKey);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, LIST_FILE), signed.list);
  fs.writeFileSync(path.join(folder, SIGNATURE_FILE), signed.sig);
  const file = path.join(folder, artifactFile(version, "win32"));
  fs.writeFileSync(file, bytes);
  return { file, digest: sha512(signed.list) };
}

const identity = () => ({ dataDir, running: RUNNING, keys: [key.publicKey], platform: "win32", arch: "x64" });
function click(over: Partial<WindowsClick> = {}) {
  const quit = vi.fn();
  const o: WindowsClick = {
    dataDir, running: RUNNING,
    verify: (version) => verifyPrepared({ ...identity(), version }),
    start: () => Promise.resolve({ started: true }),
    quit, now: () => 1_000,
    ...over,
  };
  return { o, quit };
}

describe("Restart to update on Windows", () => {
  it("WS-01 writes the note, starts the checked installer and only then quits", async () => {
    const { file, digest } = prepare(NEXT);
    const seen: unknown[] = [];
    const { o, quit } = click({
      start: (installer) => {
        seen.push(installer, JSON.parse(fs.readFileSync(pendingFile(dataDir), "utf8")), quit.mock.calls.length);
        return Promise.resolve({ started: true });
      },
    });
    expect(await startWindowsUpdate(`${NEXT}:${digest}`, o)).toEqual({ ok: true });
    expect(seen).toEqual([file, { version: 1, from: RUNNING, to: NEXT, listDigest: digest, installer: file, at: 1_000 }, 0]);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(pendingFile(dataDir))).toBe(true);
  });

  it("WS-02 an installer Windows refuses leaves the app as it was and names the checked installer in one sentence", async () => {
    const { file, digest } = prepare(NEXT);
    // A file that cannot be run: spawn refuses it, as Windows refuses a blocked installer.
    fs.chmodSync(file, 0o644);
    const { o, quit } = click({ start: (installer) => startInstaller(installer, { graceMs: 2_000 }) });
    expect(await startWindowsUpdate(`${NEXT}:${digest}`, o)).toEqual({
      ok: false,
      message: `Gates Local could not start the installer, so nothing changed; to update, run ${file}.`,
    });
    expect(quit).not.toHaveBeenCalled();
    expect(fs.existsSync(pendingFile(dataDir))).toBe(false);
    // The checked installer stays where the sentence says.
    expect(sha512(fs.readFileSync(file))).toBe(sha512(BYTES));
  });

  it("WS-03 an installer that ends at once counts as not started", async () => {
    const { file, digest } = prepare(NEXT);
    const { o, quit } = click({ start: () => Promise.resolve({ started: false, why: "the installer ended at once (2)" }) });
    expect(await startWindowsUpdate(`${NEXT}:${digest}`, o)).toMatchObject({ ok: false, message: expect.stringContaining(`run ${file}.`) });
    expect(quit).not.toHaveBeenCalled();
    expect(fs.existsSync(pendingFile(dataDir))).toBe(false);
  });

  it("WS-04 a download that no longer checks out, or another list than the approved one, starts nothing", async () => {
    const { digest } = prepare(NEXT);
    const start = vi.fn(() => Promise.resolve({ started: true as const }));
    const other = click({ start });
    expect(await startWindowsUpdate(`${NEXT}:${"0".repeat(128)}`, other.o)).toMatchObject({ ok: false, message: expect.stringContaining("did not match the signed release list") });
    prepare(NEXT, Buffer.from("changed on disk"));
    const bad = click({ start });
    expect(await startWindowsUpdate(`${NEXT}:${digest}`, bad.o)).toMatchObject({ ok: false, message: expect.stringContaining("did not match the signed release list") });
    expect(start).not.toHaveBeenCalled();
    expect(other.quit).not.toHaveBeenCalled();
    expect(bad.quit).not.toHaveBeenCalled();
    expect(fs.existsSync(pendingFile(dataDir))).toBe(false);
  });
});

/** A shell script standing in for the installer. */
function script(body: string): string {
  const file = path.join(dataDir, "installer.sh");
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

/** The note a click left for the next launch. */
function note(to: string): void {
  writePending(dataDir, { from: RUNNING, to, listDigest: "d".repeat(128), installer: "C:\\data\\updates\\1.3.0\\Setup.exe", at: 5 });
}

describe.skipIf(process.platform === "win32")("starting the installer", () => {
  it("WS-05 started: still running after the grace, with the silent update arguments", async () => {
    const argsFile = path.join(dataDir, "args");
    const file = script(`echo "$@" > "${argsFile}"; sleep 3`);
    expect(await startInstaller(file, { graceMs: 500 })).toEqual({ started: true });
    expect(fs.readFileSync(argsFile, "utf8").trim()).toBe(INSTALLER_ARGS.join(" "));
  });

  it("WS-06 not started: missing, not runnable, or ended inside the grace", async () => {
    expect(await startInstaller(path.join(dataDir, "missing.exe"), { graceMs: 500 })).toMatchObject({ started: false });
    const plain = path.join(dataDir, "plain.exe");
    fs.writeFileSync(plain, "not a program", { mode: 0o644 });
    expect(await startInstaller(plain, { graceMs: 500 })).toMatchObject({ started: false });
    expect(await startInstaller(script("exit 2"), { graceMs: 2_000 })).toEqual({ started: false, why: "the installer ended at once (2)" });
  });
});

describe("the next launch reads the note", () => {
  it("WS-07 the version it names runs: Updated to version, once, and the note goes", () => {
    note(NEXT);
    expect(settlePending(dataDir, NEXT, () => 9)).toEqual({ kind: "updated", to: NEXT });
    expect(readRecord(dataDir)).toMatchObject({ at: 9, outcome: "updated", installed: { from: RUNNING, to: NEXT, text: "Updated to version 1.3.0." } });
    expect(fs.existsSync(pendingFile(dataDir))).toBe(false);
    expect(settlePending(dataDir, NEXT)).toEqual({ kind: "none" });
  });

  it("WS-08 an older version runs: the update did not finish, naming the installer and the release page", () => {
    note(NEXT);
    expect(settlePending(dataDir, RUNNING, () => 9)).toEqual({ kind: "did-not-finish", to: NEXT, installer: "C:\\data\\updates\\1.3.0\\Setup.exe" });
    expect(readRecord(dataDir)).toMatchObject({
      outcome: "stopped",
      installed: { to: NEXT, link: true, text: "The update to version 1.3.0 did not finish. Run C:\\data\\updates\\1.3.0\\Setup.exe or download version 1.3.0 from the release page to finish or repair it." },
    });
    expect(fs.existsSync(pendingFile(dataDir))).toBe(false);
  });

  it("WS-09 a newer version runs, or the note does not decode: removed, nothing said", () => {
    note(NEXT);
    expect(settlePending(dataDir, "1.4.0")).toMatchObject({ kind: "dropped" });
    fs.writeFileSync(pendingFile(dataDir), "{ not json");
    expect(settlePending(dataDir, NEXT)).toMatchObject({ kind: "dropped" });
    expect(fs.existsSync(pendingFile(dataDir))).toBe(false);
    expect(readRecord(dataDir)).toBeUndefined();
  });
});

describe("the kept installer to go back with", () => {
  it("WS-10 the newest earlier version that still checks out; none when nothing does", async () => {
    expect(await goBackInstaller({ ...identity(), running: NEXT })).toBeNull();
    const older = prepare("1.1.0");
    prepare(RUNNING, Buffer.from("not the installer"));
    prepare(NEXT);
    expect(await goBackInstaller({ ...identity(), running: NEXT })).toBe(older.file);
    const kept = prepare(RUNNING);
    expect(await goBackInstaller({ ...identity(), running: NEXT })).toBe(kept.file);
  });
});
