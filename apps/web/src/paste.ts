// Behavior follows T3 Code chat/ChatComposer.tsx at d137c5081ac5efb2b8ea9aec8b334e1bb4d0182a (MIT).
// Native file-manager paths are the owner's explicit exception to image-first paste.
import type { ClipboardEvent } from "react";
import type { ModelInfo } from "@gates-local/contracts";
import { setState } from "./store.ts";
import { insertAtCursor } from "./draft-insertion.ts";
import { type DraftKey, currentDraftKey, getDraft, replaceDraft } from "./drafts.ts";
import { type RefusedFile, refuseFiles, sizeOf } from "./refused-files.ts";

if (typeof window !== "undefined" && typeof window.addEventListener === "function") window.addEventListener("gates-local:native-paste", event => {
  const ta = event.target;
  const result: unknown = (event as CustomEvent<unknown>).detail;
  if (!(ta instanceof HTMLTextAreaElement) || ta !== document.activeElement || !ta.isConnected) return;
  if (!result || typeof result !== "object" || !("paths" in result) || !Array.isArray(result.paths) || !result.paths.every((item): item is string => typeof item === "string")) return;
  if (!("version" in result) || result.version !== getDraft().version) return;
  if (!("start" in result) || typeof result.start !== "number" || !("end" in result) || typeof result.end !== "number") return;
  if (result.paths.length) insertAtCursor(ta, result.paths.join("\n"), { start: result.start, end: result.end });
  if ("skipped" in result && result.skipped) setState({ notice: "Some copied file paths contain control characters and were skipped." });
  if ("failed" in result && result.failed) setState({ notice: "The clipboard could not be read. Try pasting again." });
});

export const MAX_IMAGES = 8;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export function pasteKind(paths: readonly string[], files: readonly Pick<File, "type">[]): "paths" | "images" | "unavailable" | "text" {
  if (paths.length) return "paths";
  if (files.some(f => f.type.startsWith("image/"))) return "images";
  return files.length ? "unavailable" : "text";
}

export function imageReason(models: readonly ModelInfo[] | undefined, model: string | undefined, images: readonly string[], label: (tag: string) => string = tag => tag): string | null {
  if (!images.length || models?.find(m => m.name === model)?.capabilities?.includes("vision")) return null;
  const other = models?.find(m => m.capabilities?.includes("vision"));
  return `${model === undefined ? "The selected model" : label(model)} cannot see images. ${other ? `Pick ${label(other.name)}, which reads images` : "Download a model that reads images"}, or remove the attachments.`;
}

const readImage = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.addEventListener("load", () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("This image could not be read.")), { once: true });
  reader.addEventListener("error", () => reject(new Error("This image could not be read.")), { once: true });
  reader.readAsDataURL(file);
});

/** Capture clipboard data during the event: browsers clear the DataTransfer after it returns. */
export function paste(e: ClipboardEvent<HTMLTextAreaElement>): void {
  const files = Array.from(e.clipboardData.files);
  // Native text paste is one undoable edit. Multiline insertText is slow and
  // emits thousands of input events for a large paste.
  if (!files.length) return;
  e.preventDefault();
  const key = currentDraftKey();
  const version = getDraft(key).version;
  setState(s => ({ pasting: s.pasting + 1 }));
  void (async () => {
    if (pasteKind([], files) === "unavailable") { setState({ notice: "This browser cannot provide file paths. Paste the full path as text." }); return; }
    await addImages(key, version, files.filter(f => f.type.startsWith("image/")));
  })().catch(() => setState({ notice: "The clipboard could not be read. Try pasting again." })).finally(() => setState(s => ({ pasting: s.pasting - 1 })));
}

const SENDABLE = /^image\/(png|jpeg|webp|gif)$/;
const BY_EXTENSION: Readonly<Record<string, string>> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", jfif: "image/jpeg", webp: "image/webp", gif: "image/gif" };

/** A file's image type, from the browser or, when it gives none, from the name (T3 Code does the same). */
export function imageTypeOf(file: Pick<File, "name" | "type">): string {
  if (file.type && file.type !== "application/octet-stream") return file.type;
  return BY_EXTENSION[file.name.split(".").pop()?.toLowerCase() ?? ""] ?? file.type;
}

interface DroppedItem {
  readonly kind: string;
  getAsFile(): File | null;
  webkitGetAsEntry(): { readonly isDirectory: boolean } | null;
}

/**
 * T3 Code's splitTransferredFiles (chat/workspaceFileDrop.ts at c55db3e9c7,
 * MIT): a dropped folder arrives as a File too, named like a file and sized
 * by the platform, and only its entry says it is a folder.
 */
export function splitDropped(data: { readonly files: ArrayLike<File>; readonly items?: ArrayLike<DroppedItem> }): { files: File[]; folders: string[] } {
  if (data.items === undefined) return { files: Array.from(data.files), folders: [] };
  const files: File[] = [];
  const folders: string[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file === null) continue;
    if (item.webkitGetAsEntry()?.isDirectory === true) folders.push(file.name);
    else files.push(file);
  }
  return { files, folders };
}

/**
 * Files from the "+" menu's chooser or a drop. Images take the pasted-image
 * path (same limits, compression and chips). Anything else is refused at a
 * chip that says why: messages carry text and images only.
 */
export function attachFiles(files: readonly File[], folders: readonly string[] = []): Promise<void> {
  if (!files.length && !folders.length) return Promise.resolve();
  const key = currentDraftKey();
  const version = getDraft(key).version;
  const images: File[] = [];
  const refused: Omit<RefusedFile, "id">[] = folders.map(name => ({ name, size: 0, folder: true, library: true, reason: `${name} is a folder. A message carries text and images only, so its files cannot be sent. Add the folder to your Library and the model can read its files with its tools.` }));
  for (const file of files) {
    const type = imageTypeOf(file);
    if (SENDABLE.test(type) && file.size === 0) refused.push({ name: file.name, size: 0, library: false, reason: `${file.name} is empty (0 bytes), so there is no image to send.` });
    else if (SENDABLE.test(type)) images.push(type === file.type ? file : new File([file], file.name, { type }));
    else if (type.startsWith("image/")) refused.push({ name: file.name, size: file.size, library: false, reason: `${file.name} is not an image type the model can read. Attach GIF, JPEG, PNG or WebP images.` });
    else refused.push({ name: file.name, size: file.size, library: true, reason: `Messages carry text and images only, so ${file.name} (${sizeOf(file.size)}) cannot be sent. Add it to your Library and the model can read it with its tools.` });
  }
  refuseFiles(key, refused);
  if (!images.length) return Promise.resolve();
  setState(s => ({ pasting: s.pasting + 1 }));
  return addImages(key, version, images)
    .catch(() => setState({ notice: "The files could not be read. Try again." }))
    .finally(() => setState(s => ({ pasting: s.pasting - 1 })));
}

/** The one image path for paste, the chooser and drops. */
async function addImages(key: DraftKey, version: number, candidates: readonly File[]): Promise<void> {
  // Reserve slots before image reads, so overlapping pastes and drops cannot overfill the composer.
  const room = MAX_IMAGES - getDraft(key).images.length - reserved;
  const accepted = candidates.slice(0, Math.max(0, room));
  if (accepted.length < candidates.length) setState({ notice: `Attach up to ${MAX_IMAGES} images per message.` });
  reserved += accepted.length;
  try {
    for (const file of accepted) {
      try {
        if (!SENDABLE.test(file.type)) throw new Error("Attach GIF, JPEG, PNG or WebP images.");
        if (file.size === 0) throw new Error(`${file.name || "The pasted image"} is empty, so there is no image to send.`);
        const prepared = file.size <= MAX_IMAGE_BYTES ? file : await (await import("./image-compression.ts")).compressImage(file);
        const image = await readImage(prepared);
        if (getDraft(key).version === version) replaceDraft(key, { images: [...getDraft(key).images, image] }, true);
      } catch (error) { setState({ notice: error instanceof Error ? error.message : "This image could not be read." }); }
    }
  } finally { reserved -= accepted.length; }
}

let reserved = 0;
