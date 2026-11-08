import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DESKTOP_ID, renderDesktopEntry } from "../src/desktop-entry.ts";

/**
 * The Exec key read back the way the Desktop Entry spec says a launcher
 * reads it: first the string-value escapes (\s \n \t \r \\), then the Exec
 * quoting (double quotes, with \" \` \$ \\ inside), with %% as a literal %.
 * Any other field code makes it throw: a launcher would expand it.
 */
function parseExec(value: string): string[] {
  let raw = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c !== "\\") {
      raw += c;
      continue;
    }
    const next = value[++i];
    const map: Record<string, string> = { s: " ", n: "\n", t: "\t", r: "\r", "\\": "\\" };
    if (next === undefined || map[next] === undefined) throw new Error(`bad string escape \\${next ?? ""}`);
    raw += map[next];
  }
  const args: string[] = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === " ") {
      i++;
      continue;
    }
    let arg = "";
    if (raw[i] === '"') {
      i++;
      for (;;) {
        const c = raw[i];
        if (c === undefined) throw new Error("unterminated quote");
        i++;
        if (c === '"') break;
        if (c === "\\") {
          const next = raw[i++];
          if (next === undefined || !'"`$\\'.includes(next)) throw new Error(`bad quoted escape \\${next ?? ""}`);
          arg += next;
        } else if (c === "%") {
          if (raw[i++] !== "%") throw new Error("field code inside a quoted argument");
          arg += "%";
        } else arg += c;
      }
      if (raw[i] !== undefined && raw[i] !== " ") throw new Error("text after a closing quote");
    } else {
      while (i < raw.length && raw[i] !== " ") {
        const c = raw[i++];
        if (c === undefined) break;
        if ('"\'\\><~|&;$*?#()`\t\n'.includes(c)) throw new Error(`reserved ${JSON.stringify(c)} outside quotes`);
        if (c === "%") {
          if (raw[i++] !== "%") throw new Error("field code");
          arg += "%";
        } else arg += c;
      }
    }
    args.push(arg);
  }
  return args;
}

const execLine = (entry: string): string => {
  const line = entry.split("\n").find((l) => l.startsWith("Exec="));
  if (line === undefined) throw new Error("no Exec line");
  return line.slice("Exec=".length);
};

/** Arguments that each break one of the two layers when an encoder gets it wrong. */
const HARD = [
  "/opt/Gates Local/run",
  "100%done",
  "%U",
  "%%",
  'a"b$c`d\\e',
  "back\\slash",
  "tab\there",
  "it's",
  "",
  "--flag=a;b",
  "#hash",
  "~tilde",
  "(paren)",
  "/home/ü/gates-local",
  "plain",
];

const work = mkdtempSync(path.join(tmpdir(), "gates-desktop-entry-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const has = (bin: string) => spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0;

describe("Linux desktop entry", () => {
  it("names the icon and window class the package's desktopName gives the window", () => {
    const pkg = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8")) as { desktopName?: string };
    expect(pkg.desktopName).toBe(`${DESKTOP_ID}.desktop`);
    const entry = renderDesktopEntry(["/home/a/.local/bin/gates-local"]);
    expect(entry).toContain(`Icon=${DESKTOP_ID}\n`);
    expect(entry).toContain(`StartupWMClass=${DESKTOP_ID}\n`);
    expect(entry).toContain("Exec=/home/a/.local/bin/gates-local\n");
  });

  it("Exec reads back to the same arguments through both escape layers", () => {
    for (const arg of HARD) {
      expect(parseExec(execLine(renderDesktopEntry(["/bin/prog", arg]))), JSON.stringify(arg)).toEqual(["/bin/prog", arg]);
    }
    expect(parseExec(execLine(renderDesktopEntry(["/opt/Gates (x)/$x\\y/run", ...HARD])))).toEqual(["/opt/Gates (x)/$x\\y/run", ...HARD]);
  });

  it("refuses a % in the program path: GLib looks the program up before it expands %%, so neither spelling launches", () => {
    expect(() => renderDesktopEntry(["/opt/Gates 100%/run"])).toThrow(/%/);
  });

  it.skipIf(!has("gio"))("gio launch passes every argument through unchanged", () => {
    const dir = path.join(work, "Gates $x `q` \"d\" it's back\\slash (p) ü");
    mkdirSync(dir, { recursive: true });
    const prog = path.join(dir, "run.sh");
    writeFileSync(prog, `#!/bin/sh\nprintf '%s\\0' "$0" "$@" > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"\n`);
    chmodSync(prog, 0o755);
    const file = path.join(work, `${DESKTOP_ID}.desktop`);
    writeFileSync(file, renderDesktopEntry([prog, ...HARD]));
    const out = path.join(work, "argv");
    const env: NodeJS.ProcessEnv = { ...process.env, OUT: out };
    delete env["DISPLAY"];
    delete env["WAYLAND_DISPLAY"];
    const run = spawnSync("gio", ["launch", file], { env, encoding: "utf8", timeout: 10_000 });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const end = Date.now() + 5_000;
    while (!existsSync(out) && Date.now() < end) spawnSync("sleep", ["0.05"]);
    const argv = readFileSync(out, "utf8").split("\0").slice(0, -1);
    expect(argv).toEqual([prog, ...HARD]);
  });

  it.skipIf(!has("desktop-file-validate"))("desktop-file-validate accepts the entry with hard arguments", () => {
    const file = path.join(work, `${DESKTOP_ID}.desktop`);
    writeFileSync(file, renderDesktopEntry(["/opt/Gates (x)/$x\\y/run", ...HARD]));
    const run = spawnSync("desktop-file-validate", [file], { encoding: "utf8" });
    expect(run.stdout + run.stderr).not.toMatch(/error/i);
    expect(run.status).toBe(0);
  });

  it("refuses a control character in an argument and an empty command", () => {
    expect(() => renderDesktopEntry(["/bin/x\nExec=evil"])).toThrow(/control/);
    expect(() => renderDesktopEntry(["/bin/x", "a\rb"])).toThrow(/control/);
    expect(() => renderDesktopEntry(["/bin/x", "a\u0007b"])).toThrow(/control/);
    expect(() => renderDesktopEntry([])).toThrow(/program/);
  });
});
