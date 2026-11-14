// The Windows installer's running-app check (installed updates, design section
// 3). It runs only inside a Windows installer, so this reads the script the
// build includes; IU-W1 and IU-W3 in docs/releasing.md run it for real.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const desktop = path.resolve(import.meta.dirname, "..");
const nsh = readFileSync(path.join(desktop, "build", "installer.nsh"), "utf8");
const code = nsh.split("\n").filter((line) => !line.trimStart().startsWith(";")).join("\n");

describe("the Windows installer's running-app check", () => {
  it("IC-01 the build includes it, and it replaces the stock check", () => {
    expect(readFileSync(path.join(desktop, "scripts", "package.ts"), "utf8")).toContain('include: path.join(desktop, "build", "installer.nsh")');
    expect(code).toMatch(/^!macro customCheckAppRunning$/m);
  });

  it("IC-02 never kills: no process is stopped by any route", () => {
    for (const kill of ["Stop-Process", "taskkill", "KILL_PROCESS", "TerminateProcess", "nsProcess::_KillProcess"]) expect(code).not.toContain(kill);
  });

  it("IC-03 only this install's processes: the folder with its separator, the running installer left out", () => {
    expect(code).toContain(`SetEnvironmentVariable(t "GATES_LOCAL_INSTDIR", t "$INSTDIR\\")`);
    expect(code).toContain("$$_.ExecutablePath.StartsWith($$d, [StringComparison]::OrdinalIgnoreCase)");
    expect(code).toContain("$$_.ProcessId -ne $$me");
    expect(code).toContain("if (-not $$d) { exit 12 }");
  });

  it("IC-04 goes on only when nothing of the install runs; a silent run otherwise stops before anything is removed", () => {
    const loop = /\$\{Do\}([\s\S]*)\$\{Loop\}/.exec(code)?.[1] ?? "";
    expect(loop).toMatch(/\$\{If\} \$R0 == 10\s+\$\{Break\}/);
    expect(loop).toMatch(/\$\{If\} \$\{Silent\}\s+SetErrorLevel 2\s+Quit/);
    expect(loop).toContain(`"Close every Gates Local window, then click Retry."`);
    // A wait that ran out asks again; a check that could not run takes the person's Retry.
    expect(loop).toMatch(/\$\{If\} \$R0 != 11\s+\$\{Break\}/);
  });
});
