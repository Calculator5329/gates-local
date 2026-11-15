// Whether a version folder under <data dir>/updates/ could be in use, asked
// before every delete of one (the server's cleanup and the watcher's row C).
// A download is the app's own until a person starts the program from it: then
// the file is theirs, and no cleanup takes it.
//
// What can be known, and so what counts:
//   1. a program this process says is running is inside the folder;
//   2. the app was started from the folder before: the copy that found itself
//      there left a note in it (STARTED_FILE; download.ts writes it);
//   3. a process running now was started from a file inside it (Linux: /proc);
//   4. a launcher points into it: a .desktop file in the menu, on the desktop
//      or in autostart that names a file inside it, or a link to one from
//      those folders or the person's bin folders.
// When 3 or 4 cannot be read, the answer is "in use": the folder stays.
//
// Not known: a launcher kept anywhere else, and on Windows who is running.
// There a version folder holds an installer, never the program the app runs
// from, and Windows itself refuses to delete a file that is running.
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** The note in a version folder the app was started from: the time of the last such start. */
export const STARTED_FILE = "started-here";

/** A launcher file larger than this is not one: it is skipped. */
const LAUNCHER_MAX_BYTES = 1_000_000;

/** What the computer says about running programs and launchers. Each answers null when it could not be read. */
export interface Look {
  /** The program file of every running process this user can see. */
  readonly running: () => readonly string[] | null;
  /** Each launcher: the text of a .desktop file, or the file a link points to. */
  readonly launchers: () => readonly string[] | null;
}

const errorCode = (error: unknown): unknown => (typeof error === "object" && error !== null && "code" in error ? error.code : undefined);
const missing = (error: unknown) => errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR";

/** The real path, or the resolved one when it cannot be read (a file already gone). */
export function real(file: string): string {
  try { return fs.realpathSync(file); } catch { return path.resolve(file); }
}

function runningPrograms(): readonly string[] | null {
  if (process.platform !== "linux") return [];
  let names: string[];
  try { names = fs.readdirSync("/proc"); } catch { return null; }
  const programs: string[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    // No answer for a process that ended, a kernel thread, or another user's process.
    try { programs.push(fs.readlinkSync(`/proc/${name}/exe`)); } catch { /* not this user's to see */ }
  }
  return programs;
}

const absolute = (value: string | undefined, fallback: string) => (value !== undefined && path.isAbsolute(value) ? value : fallback);

/** The desktop folder: the one user-dirs.dirs names, else ~/Desktop. */
function desktopFolder(config: string, home: string): string {
  let text = "";
  try { text = fs.readFileSync(path.join(config, "user-dirs.dirs"), "utf8"); } catch { /* the default applies */ }
  const named = /^XDG_DESKTOP_DIR="(.+)"$/m.exec(text)?.[1]?.replace(/^\$HOME(?=\/|$)/, home);
  return named !== undefined && path.isAbsolute(named) ? named : path.join(home, "Desktop");
}

/**
 * The launchers of one home folder: the text of every .desktop file in the
 * app menu, autostart and the desktop, and the target of every link in those
 * folders and the person's bin folders. Null when one of them is there and
 * cannot be read.
 */
export function launchersIn(env: Readonly<Record<string, string | undefined>>, home: string): readonly string[] | null {
  const data = absolute(env["XDG_DATA_HOME"], path.join(home, ".local", "share"));
  const config = absolute(env["XDG_CONFIG_HOME"], path.join(home, ".config"));
  const folders = [path.join(data, "applications"), path.join(config, "autostart"), desktopFolder(config, home), path.join(home, ".local", "bin"), path.join(home, "bin")];
  const found: string[] = [];
  for (const folder of folders) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); }
    catch (error) {
      if (missing(error)) continue;
      return null;
    }
    for (const entry of entries) {
      const file = path.join(folder, entry.name);
      try {
        if (entry.isSymbolicLink()) found.push(real(path.resolve(folder, fs.readlinkSync(file))));
        else if (entry.isFile() && entry.name.endsWith(".desktop") && fs.statSync(file).size <= LAUNCHER_MAX_BYTES) found.push(fs.readFileSync(file, "utf8"));
      } catch (error) {
        if (missing(error)) continue;
        return null;
      }
    }
  }
  return found;
}

export const realLook: Look = {
  running: runningPrograms,
  launchers: () => (process.platform === "linux" ? launchersIn(process.env, homedir()) : []),
};

/** One reading of look shared by several folders: cleanup asks once, not once per folder. */
export function once(look: Look): Look {
  let running: readonly string[] | null | undefined;
  let launchers: readonly string[] | null | undefined;
  return {
    running: () => (running === undefined ? (running = look.running()) : running),
    launchers: () => (launchers === undefined ? (launchers = look.launchers()) : launchers),
  };
}

/**
 * Why folder must not be deleted, or null when nothing uses it. programs are
 * the files this process knows are running (its own). A folder that is not
 * there, or is a link, is never in use: deleting a link removes only the link.
 */
export function inUse(folder: string, programs: readonly string[] = [], look: Look = realLook): string | null {
  let inside: string;
  try {
    if (fs.lstatSync(folder).isSymbolicLink()) return null;
    inside = `${fs.realpathSync(folder)}${path.sep}`;
  } catch (error) {
    return missing(error) ? null : "the folder could not be read";
  }
  if (programs.some((file) => real(file).startsWith(inside))) return "the running program is in it";
  if (fs.existsSync(path.join(folder, STARTED_FILE))) return "the app was started from it";
  const running = look.running();
  if (running === null) return "the running programs could not be read";
  if (running.some((file) => file.startsWith(inside))) return "a running program is in it";
  const launchers = look.launchers();
  if (launchers === null) return "the launchers could not be read";
  const written = `${path.resolve(folder)}${path.sep}`;
  if (launchers.some((text) => text.includes(inside) || text.includes(written))) return "a launcher starts a file in it";
  return null;
}
