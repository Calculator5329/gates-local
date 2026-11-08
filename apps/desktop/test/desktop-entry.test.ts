import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DESKTOP_ID, execArg, renderDesktopEntry } from "../src/desktop-entry.ts";

describe("Linux desktop entry", () => {
  it("names the icon and window class the package's desktopName gives the window", () => {
    const pkg = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8")) as { desktopName?: string };
    expect(pkg.desktopName).toBe(`${DESKTOP_ID}.desktop`);
    const entry = renderDesktopEntry(["/home/a/.local/bin/gates-local"]);
    expect(entry).toContain(`Icon=${DESKTOP_ID}\n`);
    expect(entry).toContain(`StartupWMClass=${DESKTOP_ID}\n`);
    expect(entry).toContain("Exec=/home/a/.local/bin/gates-local\n");
  });

  it("quotes Exec arguments with spaces and spec-reserved characters", () => {
    expect(execArg("/opt/Gates Local/run")).toBe('"/opt/Gates Local/run"');
    expect(execArg('a"b$c`d\\e')).toBe('"a\\"b\\$c\\`d\\\\e"');
    expect(execArg("--background")).toBe("--background");
  });

  it("refuses a multi-line argument and an empty command", () => {
    expect(() => renderDesktopEntry(["/bin/x\nExec=evil"])).toThrow(/one line/);
    expect(() => renderDesktopEntry([])).toThrow(/program/);
  });
});
