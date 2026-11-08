// The Linux desktop entry. Wayland compositors (KDE among them) pick a
// window's icon and launcher from the desktop file whose name matches the
// window's app id, which Electron takes from package.json "desktopName"
// (gates-local.desktop). Without that file KDE draws its generic icon.

export const DESKTOP_ID = "gates-local";

/** Quote one Exec argument per the Desktop Entry spec. */
export function execArg(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(["`$\\])/g, "\\$1")}"`;
}

export function renderDesktopEntry(exec: readonly string[]): string {
  if (exec.length === 0) throw new Error("exec needs a program");
  for (const arg of exec) if (/[\n\r]/.test(arg)) throw new Error("exec arguments must be one line");
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Gates Local",
    "Comment=Chat with AI models on this computer",
    `Exec=${exec.map(execArg).join(" ")}`,
    `Icon=${DESKTOP_ID}`,
    `StartupWMClass=${DESKTOP_ID}`,
    "Terminal=false",
    "Categories=Utility;Development;",
    "",
  ].join("\n");
}
