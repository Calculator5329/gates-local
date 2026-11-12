// "Who may update" (design section 2): one row per case, plus the copies
// that never offer Restart to update (Windows, a clone).
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replaceability, type ReplaceFacts } from "./replaceable.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    chmodSync(root, 0o700);
    for (const dir of ["ro", "app"]) { try { chmodSync(path.join(root, dir), 0o700); } catch { /* not made */ } }
    rmSync(root, { recursive: true, force: true });
  }
});
function folder(): string {
  const root = mkdtempSync(path.join(tmpdir(), "iu-replace-"));
  roots.push(root);
  return root;
}
function appImage(dir: string, name = "Gates-Local.AppImage"): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, "program");
  return file;
}
const facts = (f: Partial<ReplaceFacts>): ReplaceFacts => ({ platform: "linux", packaged: true, env: {}, testBuild: false, ...f });
const error = (code: string) => () => { throw Object.assign(new Error(code), { code }); };

describe("Restart to update: who may update", () => {
  it("RP-01 an AppImage whose folder takes a write can update, by the real path of its file", () => {
    const root = folder();
    const file = appImage(path.join(root, "app"));
    const link = path.join(root, "link.AppImage");
    symlinkSync(file, link);
    expect(replaceability(facts({ env: { APPIMAGE: file } }))).toEqual({ restart: "yes", program: file });
    expect(replaceability(facts({ env: { APPIMAGE: link } }))).toEqual({ restart: "yes", program: file });
  });

  it("RP-02 a folder that refuses the probe write: read-only or no permission, nothing left behind", () => {
    const root = folder();
    const file = appImage(path.join(root, "app"));
    expect(replaceability(facts({ env: { APPIMAGE: file }, probe: error("EROFS") }))).toEqual({ restart: "read-only", program: file });
    expect(replaceability(facts({ env: { APPIMAGE: file }, probe: error("EACCES") }))).toEqual({ restart: "no-permission", program: file });
    expect(replaceability(facts({ env: { APPIMAGE: file }, probe: error("EPERM") }))).toEqual({ restart: "no-permission", program: file });
    if (process.getuid?.() !== 0) {
      const ro = path.join(root, "ro");
      const locked = appImage(ro);
      chmodSync(ro, 0o500);
      expect(replaceability(facts({ env: { APPIMAGE: locked } })).restart).toBe("no-permission");
    }
    chmodSync(path.join(root, "app"), 0o700);
    expect(replaceability(facts({ env: { APPIMAGE: file } })).restart).toBe("yes");
    expect(readdirSync(path.join(root, "app"))).toEqual(["Gates-Local.AppImage"]);
  });

  it("RP-03 not an AppImage: unset, missing, a folder, or another name", () => {
    const root = folder();
    expect(replaceability(facts({})).restart).toBe("not-appimage");
    expect(replaceability(facts({ env: { APPIMAGE: "" } })).restart).toBe("not-appimage");
    expect(replaceability(facts({ env: { APPIMAGE: path.join(root, "gone.AppImage") } })).restart).toBe("not-appimage");
    mkdirSync(path.join(root, "dir.AppImage"));
    expect(replaceability(facts({ env: { APPIMAGE: path.join(root, "dir.AppImage") } })).restart).toBe("not-appimage");
    expect(replaceability(facts({ env: { APPIMAGE: appImage(path.join(root, "app"), "gates-local") } })).restart).toBe("not-appimage");
  });

  it("RP-04 a data folder pinned by GATES_LOCAL_DATA_DIR is refused, except in a test build", () => {
    const file = appImage(path.join(folder(), "app"));
    expect(replaceability(facts({ env: { APPIMAGE: file, GATES_LOCAL_DATA_DIR: "/data" } })).restart).toBe("pinned");
    expect(replaceability(facts({ env: { APPIMAGE: file, GATES_LOCAL_DATA_DIR: "/data" }, testBuild: true })).restart).toBe("yes");
  });

  it("RP-05 Windows, macOS and a clone never restart to update", () => {
    const file = appImage(path.join(folder(), "app"));
    expect(replaceability(facts({ platform: "win32", env: { APPIMAGE: file } }))).toEqual({ restart: "none", program: null });
    expect(replaceability(facts({ platform: "darwin", env: { APPIMAGE: file } }))).toEqual({ restart: "none", program: null });
    expect(replaceability(facts({ packaged: false, env: { APPIMAGE: file } }))).toEqual({ restart: "none", program: null });
  });
});
