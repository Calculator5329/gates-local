// What the computer can say about who uses a version folder: a real process
// started from a file inside one, and real launcher files in a pretend home.
// Temporary folders live under ~/.cache and are removed after each test.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inUse, launchersIn, type Look, realLook, STARTED_FILE } from "./in-use.ts";

let root: string;
let folder: string;
beforeEach(() => {
  const cache = path.join(homedir(), ".cache");
  fs.mkdirSync(cache, { recursive: true });
  root = fs.mkdtempSync(path.join(cache, "installed-in-use-test-"));
  folder = path.join(root, "data", "updates", "1.0.0");
  fs.mkdirSync(folder, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const nothing: Look = { running: () => [], launchers: () => [] };

describe("a version folder in use", () => {
  it("is free when nothing runs from it, nothing points into it and the app was never started from it", () => {
    fs.writeFileSync(path.join(folder, "Gates-Local.AppImage"), "a download");
    expect(inUse(folder, [], nothing)).toBeNull();
    expect(inUse(path.join(root, "data", "updates", "9.9.9"), [], nothing)).toBeNull();
  });

  it("is in use while this process's own program is inside it", () => {
    const program = path.join(folder, "deeper", "Gates-Local.AppImage");
    fs.mkdirSync(path.dirname(program));
    fs.writeFileSync(program, "the running program");
    expect(inUse(folder, [program], nothing)).toMatch(/running/);
  });

  it("is in use once the app was started from it", () => {
    fs.writeFileSync(path.join(folder, STARTED_FILE), "2026-01-01T00:00:00.000Z\n");
    expect(inUse(folder, [], nothing)).toMatch(/started/);
  });

  it("is in use when a launcher names a file inside it", () => {
    const look: Look = { ...nothing, launchers: () => [`[Desktop Entry]\nExec="${path.join(folder, "Gates-Local.AppImage")}" %U\n`] };
    expect(inUse(folder, [], look)).toMatch(/launcher/);
    expect(inUse(path.join(root, "data", "updates", "1.0.1"), [], look)).toBeNull();
  });

  it("is in use when the running programs or the launchers cannot be read", () => {
    expect(inUse(folder, [], { ...nothing, running: () => null })).toMatch(/could not/);
    expect(inUse(folder, [], { ...nothing, launchers: () => null })).toMatch(/could not/);
  });

  it("a folder that is a link is never in use: removing it removes only the link", () => {
    const link = path.join(root, "data", "updates", "2.0.0");
    fs.symlinkSync(folder, link);
    fs.writeFileSync(path.join(folder, STARTED_FILE), "x");
    expect(inUse(link, [], nothing)).toBeNull();
  });

  it.runIf(process.platform === "linux")("finds a real process started from a file inside it", async () => {
    const program = path.join(folder, "sleeper");
    fs.copyFileSync("/bin/sleep", program);
    fs.chmodSync(program, 0o755);
    expect(inUse(folder, [], realLook)).toBeNull();
    const child = spawn(program, ["30"], { stdio: "ignore" });
    try {
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      expect(inUse(folder, [], realLook)).toMatch(/running/);
    } finally {
      const ended = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await ended;
    }
    expect(inUse(folder, [], realLook)).toBeNull();
  });
});

const home = () => path.join(root, "home");
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

describe("the launchers a person starts programs from", () => {
  it("reads launcher files and links from the menu, the desktop, autostart and the person's bin folders", () => {
    write(path.join(home(), ".local", "share", "applications", "gates.desktop"), "Exec=/menu/app\n");
    write(path.join(home(), ".config", "autostart", "gates.desktop"), "Exec=/autostart/app\n");
    write(path.join(home(), "Desktop", "gates.desktop"), "Exec=/desktop/app\n");
    write(path.join(home(), "Desktop", "notes.txt"), "/not/a/launcher\n");
    fs.mkdirSync(path.join(home(), ".local", "bin"), { recursive: true });
    const program = path.join(folder, "Gates-Local.AppImage");
    fs.writeFileSync(program, "x");
    fs.symlinkSync(program, path.join(home(), ".local", "bin", "gates-local"));
    const found = launchersIn({}, home());
    expect(found).toEqual(expect.arrayContaining(["Exec=/menu/app\n", "Exec=/autostart/app\n", "Exec=/desktop/app\n", fs.realpathSync(program)]));
    expect(found?.some((text) => text.includes("/not/a/launcher"))).toBe(false);
    expect(inUse(folder, [], { ...nothing, launchers: () => found })).toMatch(/launcher/);
  });

  it("follows XDG_DATA_HOME, XDG_CONFIG_HOME and a renamed desktop folder", () => {
    write(path.join(root, "xdg-data", "applications", "a.desktop"), "Exec=/data/app\n");
    write(path.join(root, "xdg-config", "autostart", "b.desktop"), "Exec=/config/app\n");
    write(path.join(root, "xdg-config", "user-dirs.dirs"), 'XDG_DESKTOP_DIR="$HOME/Schreibtisch"\n');
    write(path.join(home(), "Schreibtisch", "c.desktop"), "Exec=/renamed/app\n");
    const found = launchersIn({ XDG_DATA_HOME: path.join(root, "xdg-data"), XDG_CONFIG_HOME: path.join(root, "xdg-config") }, home());
    expect(found).toEqual(expect.arrayContaining(["Exec=/data/app\n", "Exec=/config/app\n", "Exec=/renamed/app\n"]));
  });

  it("a home with none of those folders has no launchers", () => {
    expect(launchersIn({}, home())).toEqual([]);
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)("cannot say when a launcher folder is there and unreadable", () => {
    const menu = path.join(home(), ".local", "share", "applications");
    fs.mkdirSync(menu, { recursive: true });
    fs.chmodSync(menu, 0o000);
    try {
      expect(launchersIn({}, home())).toBeNull();
    } finally {
      fs.chmodSync(menu, 0o755);
    }
  });
});
