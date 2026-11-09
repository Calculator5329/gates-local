import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { isAlive } from "../update/wait.ts";

it.runIf(process.platform === "linux")("AW-02 Windows git worker leaves an exited root alone and waits for close", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "gl-git-worker-"));
  const record = path.join(root, "taskkill-called");
  // The root exits while its helper keeps the worker's pipe open.
  writeFileSync(path.join(root, "git"), "#!/bin/sh\necho $$\n(sleep 1; echo drained) &\n", { mode: 0o755 });
  writeFileSync(path.join(root, "taskkill"), `#!${process.execPath}\nimport { writeFileSync } from "node:fs"; writeFileSync(process.env.TASKKILL_RECORD, "called"); process.exit(128);\n`, { mode: 0o755 });
  const worker = path.join(import.meta.dirname, "git-worker.ts");
  const script = `Object.defineProperty(process, "platform", { value: "win32" }); process.argv = [process.execPath, ${JSON.stringify(worker)}, "[]", ${JSON.stringify(root)}]; await import(${JSON.stringify(pathToFileURL(worker).href)});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { detached: true, env: { ...process.env, PATH: `${root}${path.delimiter}${process.env["PATH"] ?? ""}`, TASKKILL_RECORD: record }, stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "close");
  let output = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.resume();
  try {
    child.stdin.write("start\n");
    await vi.waitFor(() => expect(output).toMatch(/^\d+\n/));
    const pid = Number(output.trim().split("\n")[0]);
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false));
    child.stdin.end();
    expect((await closed)[0]).toBe(1);
    expect.soft(existsSync(record)).toBe(false);
    expect(output).toContain("drained");
  } finally {
    if (child.pid !== undefined) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already closed. */ } }
    await closed;
    rmSync(root, { recursive: true, force: true });
  }
});
