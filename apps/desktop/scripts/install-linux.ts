// Installs the Gates Local launcher and icon for this Linux user, so the
// app menu lists it and the window shows its own icon.
// Run: node scripts/install-linux.ts --exec <program> [--exec-arg <arg>]...
// Writes $XDG_DATA_HOME (default ~/.local/share)/applications/gates-local.desktop
// and icons/hicolor/{scalable,512x512}/apps/gates-local.{svg,png}.
// The logic is src/linux-install.ts.

import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { installLinux, linuxDataHome } from "../src/linux-install.ts";

const { values } = parseArgs({ options: { exec: { type: "string" }, "exec-arg": { type: "string", multiple: true } } });
if (values.exec === undefined || values.exec === "") {
  console.error("usage: node scripts/install-linux.ts --exec <program> [--exec-arg <arg>]...");
  process.exit(2);
}
installLinux({
  dataHome: linuxDataHome(process.env, homedir()),
  exec: [path.resolve(values.exec), ...(values["exec-arg"] ?? [])],
  assets: path.resolve(import.meta.dirname, "..", "assets"),
  now: new Date(),
  log: (line) => console.log(line),
});
