// Clipboard metadata only. Never opens, stats or reads a copied file.
const hasControls = (value: string) => [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const PATH_FORMATS = ["text/uri-list", "application/x-kde4-urilist", "x-special/gnome-copied-files", "x-special/nautilus-clipboard"] as const;
type PathFormat = typeof PATH_FORMATS[number];
/** Electron 45 wraps unmapped platform formats; accept only these file-list names. */
export const pathClipboardTypes = (types: readonly string[]): (PathFormat | `electron application/osclipboard;format="${PathFormat}"`)[] => PATH_FORMATS.flatMap(format =>
  ([format, `electron application/osclipboard;format="${format}"`] as const).filter(type => types.includes(type)));
export function parseClipboardPaths(text: string, platform: string): { paths: string[]; skipped: boolean } {
  const paths: string[] = [];
  let skipped = false;
  const lines = platform === "win32" && /^(?:[a-z]:\\|\\\\)/i.test(text) ? text.split("\0") : text.split(/[\r\n\0]+/);
  for (const line of lines) {
    try {
      if (hasControls(line)) { skipped = true; continue; }
      if (platform === "win32" && /^(?:[a-z]:\\|\\\\)/i.test(line)) { paths.push(line); continue; }
      if (!line.startsWith("file://")) continue;
      const uri = new URL(line);
      if (uri.search || uri.hash || uri.username || uri.password) continue;
      let pathname = decodeURIComponent(uri.pathname);
      if (hasControls(pathname)) { skipped = true; continue; }
      if (platform === "win32") {
        pathname = pathname.replace(/^\/([a-z]:)/i, "$1").replaceAll("/", "\\");
        if (uri.hostname && uri.hostname !== "localhost") pathname = `\\\\${uri.hostname}${pathname}`;
        if (!/^(?:[a-z]:\\|\\\\)/i.test(pathname)) continue;
      } else if (uri.hostname && uri.hostname !== "localhost") continue;
      paths.push(pathname);
    } catch { /* Malformed URI or percent escape: skip that entry. */ }
  }
  return { paths: [...new Set(paths)], skipped };
}

export const clipboardPaths = (text: string, platform: string): string[] => parseClipboardPaths(text, platform).paths;
