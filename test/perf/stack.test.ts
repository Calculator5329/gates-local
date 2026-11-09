import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { ROOT } from "../e2e/env.ts";

function stopGroup(pid: number) {
  try { process.kill(-pid, "SIGTERM"); }
  catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error; }
}

test("the shared perf stack gives both legacy and fixture-requiring Library servers offline data", async () => {
  const cache = path.join(homedir(), ".cache", "gates-local-perf-test");
  mkdirSync(cache, { recursive: true });
  const scratch = mkdtempSync(path.join(cache, "stack-"));
  try {
    const template = path.join(scratch, "template"); mkdirSync(template);
    writeFileSync(path.join(template, "fixture.json"), JSON.stringify({ short: "a", long: "b", thousands: "c", huge: "d", hoverLong: "e", hoverThousands: "f" }));
    for (const requiresFixture of [true, false]) {
      const target = path.join(scratch, requiresFixture ? "current" : "legacy");
      mkdirSync(path.join(target, "test/fake-ollama"), { recursive: true });
      mkdirSync(path.join(target, "test/e2e"));
      writeFileSync(path.join(target, "test/fake-ollama/main.ts"), 'console.log("fake ollama on"); setInterval(() => {}, 1000);');
      writeFileSync(path.join(target, "test/e2e/library-server.ts"), [
        'const root = process.env.GL_E2E_LIBRARY_FIXTURE;',
        `if (${requiresFixture} && !root) throw new Error("The offline Library fixture must be prepared by the test stack.");`,
        'if (root) {',
        '  const { DatabaseSync } = require("node:sqlite");',
        '  const db = new DatabaseSync(require("node:path").join(root, "sample.db"), { readOnly: true });',
        '  if (db.prepare("SELECT title FROM albums").get().title !== "Fixture album") throw new Error("missing offline sample"); db.close();',
        '  require("node:child_process").execFileSync("git", ["--git-dir", require("node:path").join(root, "fixture.git"), "rev-parse", "HEAD"], { stdio: "ignore" });',
        '}',
        'console.error("OFFLINE_FIXTURE=" + JSON.stringify({ ready: Boolean(root), root }));',
        // Hold before the server readiness protocol, so the control port never opens.
        'setInterval(() => {}, 1000);',
      ].join("\n"));
      const child = spawn(process.execPath, ["test/perf/stack.ts"], { cwd: ROOT, env: { ...process.env, GL_PERF_TARGET: target, GL_PERF_FIXTURE: template }, detached: true, stdio: ["ignore", "ignore", "pipe"] });
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      try {
        const observed = await new Promise<string>((resolve, reject) => {
          let output = "";
          child.stderr.on("data", (chunk: Buffer) => {
            output += chunk.toString();
            const match = /^OFFLINE_FIXTURE=(.+)$/m.exec(output);
            if (match?.[1]) resolve(match[1]);
          });
          child.once("error", reject);
          child.once("exit", code => reject(new Error(`Perf stack exited ${code}: ${output}`)));
        });
        expect(JSON.parse(observed)).toMatchObject({ ready: true, root: expect.stringContaining(path.join(homedir(), ".cache")) });
      } finally {
        if (child.pid !== undefined) stopGroup(child.pid);
        await exited;
      }
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
