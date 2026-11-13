import { expect, it } from "vitest";
import { createShellStatus } from "./shell.ts";

it("ready with sqlite3 is plain ready; without it the status says what cannot be done", async () => {
  const lines: string[] = [];
  expect(await createShellStatus(async () => ({ available: true, arch: "x64", sqlite: true }), (l) => lines.push(l))()).toEqual({ state: "ready" });
  const status = await createShellStatus(async () => ({ available: true, arch: "x64", sqlite: false }), (l) => lines.push(l))();
  expect(status).toEqual({ state: "ready", word: "Ready, without sqlite3", reason: "Databases in your Library can't be read: this machine has no sqlite3 (/usr/bin/sqlite3)." });
  expect(lines).toEqual(["shell sandbox: ready", "shell sandbox: ready, no /usr/bin/sqlite3 (database reads will fail)"]);
});
