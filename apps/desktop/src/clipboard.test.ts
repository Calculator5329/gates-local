import { describe, expect, it } from "vitest";
import { clipboardPaths, pathClipboardTypes } from "./clipboard.ts";

it("recognizes only file-list formats, including Electron's raw OS wrappers", () => {
  expect(pathClipboardTypes(["text/plain", 'electron application/osclipboard;format="x-special/gnome-copied-files"', "text/uri-list", 'electron application/osclipboard;format="application/x-kde4-urilist"', 'electron application/osclipboard;format="unrelated-format"'])).toEqual([
    "text/uri-list", 'electron application/osclipboard;format="application/x-kde4-urilist"', 'electron application/osclipboard;format="x-special/gnome-copied-files"',
  ]);
});

describe("clipboard file paths", () => {
  it("skips every decoded C0 or DEL control instead of inserting extra lines", () => {
    for (const platform of ["linux", "win32"]) {
      for (const control of [...Array.from({ length: 32 }, (_, n) => n), 127]) {
        const prefix = platform === "win32" ? "file:///C:/docs/" : "file:///srv/docs/";
        expect(clipboardPaths(`${prefix}a%${control.toString(16).padStart(2, "0")}b.pdf`, platform)).toEqual([]);
      }
    }
  });
  it("decodes URI lists, spaces, unicode and percent escapes, excluding remote URIs", () => {
    expect(clipboardPaths("# comment\r\nfile:///srv/docs/a%20b.pdf\r\nfile:///srv/%E9%9B%AA%2520.png\nhttps://example.com/no\nfile:///srv/bad%zz\n", "linux")).toEqual(["/srv/docs/a b.pdf", "/srv/雪%20.png"]);
    expect(clipboardPaths("copy\nfile:///srv/picture.png\nfile://remote/share/no", "linux")).toEqual(["/srv/picture.png"]);
    expect(clipboardPaths("file:///C:/My%20Files/%E9%9B%AA.png\nfile://server/share/a%20b.pdf\nhttps://example.com", "win32")).toEqual(["C:\\My Files\\雪.png", "\\\\server\\share\\a b.pdf"]);
  });
  it("accepts absolute Windows drives and UNC paths, refusing relative names", () => {
    expect(clipboardPaths("C:\\a b.pdf\0D:\\two.pdf\0relative.png\0", "win32")).toEqual(["C:\\a b.pdf", "D:\\two.pdf"]);
  });
});
