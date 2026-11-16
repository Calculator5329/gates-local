// external: Linux Wayland compositors take a window's icon from the desktop file named by its app id.
export const DESKTOP_ID = "gates-local";

const RESERVED = /[ \t\n"'\\><~|&;$*?#()`]/;

export function execArg(arg: string): string {
  const percent = arg.replaceAll("%", "%%");
  if (arg !== "" && !RESERVED.test(arg)) return percent;
  return `"${percent.replace(/["`$\\]/g, "\\$&")}"`;
}

export function execValue(exec: readonly string[]): string {
  if (exec.length === 0) throw new Error("exec needs a program");
  if (exec[0]?.includes("%")) throw new Error("the program path cannot contain %");
  // eslint-disable-next-line no-control-regex -- control characters are what this line refuses
  for (const arg of exec) if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(arg)) throw new Error("exec arguments cannot hold a control character other than tab");
  return exec.map(execArg).join(" ").replaceAll("\\", "\\\\").replaceAll("\t", "\\t");
}

export function renderDesktopEntry(exec: readonly string[]): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Gates Local",
    "Comment=Chat with AI models on this computer",
    `Exec=${execValue(exec)}`,
    `Icon=${DESKTOP_ID}`,
    `StartupWMClass=${DESKTOP_ID}`,
    "Terminal=false",
    "Categories=Utility;Development;",
    "",
  ].join("\n");
}
