// Installs the Gates Local launcher and icon for this Linux user, so the
// app menu lists it and the window shows its own icon.
// Run: node scripts/install-linux.ts --exec <program> [--exec-arg <arg>]...
// Writes $XDG_DATA_HOME (default ~/.local/share)/applications/gates-local.desktop
// and icons/hicolor/{scalable,512x512}/apps/gates-local.{svg,png}. A file
// already there with other content is renamed to <name>.prev-<time> first.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { DESKTOP_ID, renderDesktopEntry } from "../src/desktop-entry.ts";

const { values } = parseArgs({ options: { exec: { type: "string" }, "exec-arg": { type: "string", multiple: true } } });
if (values.exec === undefined || values.exec === "") {
  console.error("usage: node scripts/install-linux.ts --exec <program> [--exec-arg <arg>]...");
  process.exit(2);
}
const exec = [path.resolve(values.exec), ...(values["exec-arg"] ?? [])];
const dataHome = process.env["XDG_DATA_HOME"] || path.join(homedir(), ".local", "share");
const assets = path.resolve(import.meta.dirname, "..", "assets");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

function place(target: string, write: (file: string) => void, same: (file: string) => boolean): void {
  mkdirSync(path.dirname(target), { recursive: true });
  if (existsSync(target)) {
    if (same(target)) return;
    renameSync(target, `${target}.prev-${stamp}`);
  }
  write(target);
  console.log(`wrote ${target}`);
}

const sameBytes = (source: string) => (file: string) => readFileSync(file).equals(readFileSync(source));

const entry = renderDesktopEntry(exec);
place(
  path.join(dataHome, "applications", `${DESKTOP_ID}.desktop`),
  (file) => writeFileSync(file, entry),
  (file) => readFileSync(file, "utf8") === entry,
);
for (const [dir, ext] of [["scalable", "svg"], ["512x512", "png"]] as const) {
  const source = path.join(assets, `icon.${ext}`);
  place(path.join(dataHome, "icons", "hicolor", dir, "apps", `${DESKTOP_ID}.${ext}`), (file) => copyFileSync(source, file), sameBytes(source));
}
