// The Linux desktop entry. Wayland compositors (KDE among them) pick a
// window's icon and launcher from the desktop file whose name matches the
// window's app id, which Electron takes from package.json "desktopName"
// (gates-local.desktop). Without that file KDE draws its generic icon.

export const DESKTOP_ID = "gates-local";

/** Characters the Desktop Entry spec reserves in an Exec argument: the argument must be quoted. */
const RESERVED = /[ \t\n"'\\><~|&;$*?#()`]/;

/**
 * One Exec argument, Exec layer only: a literal % becomes %%, and an
 * argument with a reserved character (or an empty one) goes in double quotes
 * with " ` $ \ backslash-escaped inside.
 */
export function execArg(arg: string): string {
  const percent = arg.replaceAll("%", "%%");
  if (arg !== "" && !RESERVED.test(arg)) return percent;
  return `"${percent.replace(/["`$\\]/g, "\\$&")}"`;
}

/**
 * The Exec value as written in the file: the quoted arguments, then the
 * string-value layer every desktop-entry string goes through (\ as \\,
 * tab as \t). Other control characters cannot be written and are refused.
 */
export function execValue(exec: readonly string[]): string {
  if (exec.length === 0) throw new Error("exec needs a program");
  // GLib (gio, GNOME) looks the program up before it expands %%, so a
  // program path with a % never launches, whichever way it is written.
  if (exec[0]?.includes("%")) throw new Error("the program path cannot contain %");
  // eslint-disable-next-line no-control-regex
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
