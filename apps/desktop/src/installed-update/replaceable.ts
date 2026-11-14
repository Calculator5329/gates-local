// "Who may update" (docs/design/installed-updates.md, section 2): whether this
// copy can replace its own program file, found once at startup by the desktop
// main and handed to the server in GATES_LOCAL_INSTALLED_RESTART.
import { closeSync, existsSync, openSync, realpathSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { Restart } from "../../../server/src/update/installed/module.ts";
import { UNINSTALLER } from "./windows.ts";

export interface ReplaceFacts {
  readonly platform: NodeJS.Platform;
  readonly packaged: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly testBuild: boolean;
  /** Creates and removes one file in a folder; throws the folder's refusal. Real by default. */
  readonly probe?: (dir: string) => void;
  /** The app's own executable (Windows): an install made by the installer has its uninstaller beside it. */
  readonly execPath?: string;
}

export interface Replaceability {
  readonly restart: Restart;
  /** The real path of the program file, when there is one to replace. */
  readonly program: string | null;
}

function probeWrite(dir: string): void {
  const file = path.join(dir, `.gates-local-probe-${process.pid}-${Date.now()}`);
  closeSync(openSync(file, "wx", 0o600));
  unlinkSync(file);
}

function appImageFile(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  try {
    const real = realpathSync(value);
    return real.endsWith(".AppImage") && statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

export function replaceability(f: ReplaceFacts): Replaceability {
  if (f.platform === "win32" && f.packaged) {
    if ((f.env["GATES_LOCAL_DATA_DIR"] ?? "") !== "" && !f.testBuild) return { restart: "pinned", program: null };
    // Section 3 (W-A): the installer runs over the install it made, which keeps its uninstaller beside the app.
    const installed = f.execPath !== undefined && existsSync(path.join(path.dirname(f.execPath), UNINSTALLER));
    return { restart: installed ? "windows" : "none", program: null };
  }
  if (f.platform !== "linux" || !f.packaged) return { restart: "none", program: null };
  const program = appImageFile(f.env["APPIMAGE"]);
  if ((f.env["GATES_LOCAL_DATA_DIR"] ?? "") !== "" && !f.testBuild) return { restart: "pinned", program };
  if (program === null) return { restart: "not-appimage", program: null };
  try {
    (f.probe ?? probeWrite)(path.dirname(program));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EROFS") return { restart: "read-only", program };
    return { restart: "no-permission", program };
  }
  return { restart: "yes", program };
}
