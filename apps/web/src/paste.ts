// Behavior follows T3 Code chat/ChatComposer.tsx at d137c5081ac5efb2b8ea9aec8b334e1bb4d0182a (MIT).
// Native file-manager paths are the owner's explicit exception to image-first paste.
import type { ClipboardEvent } from "react";
import type { ModelInfo } from "@gates-local/contracts";
import { getState, setState } from "./store.ts";
import { insertAtCursor } from "./draft-insertion.ts";

if (typeof window !== "undefined" && typeof window.addEventListener === "function") window.addEventListener("gates-local:native-paste", event => {
  const ta = event.target;
  const result: unknown = (event as CustomEvent<unknown>).detail;
  if (!(ta instanceof HTMLTextAreaElement) || ta !== document.activeElement || !ta.isConnected) return;
  if (!result || typeof result !== "object" || !("paths" in result) || !Array.isArray(result.paths) || !result.paths.every((item): item is string => typeof item === "string")) return;
  if (!("version" in result) || result.version !== getState().draftVersion) return;
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
  e.preventDefault();
  const ta = e.currentTarget;
  const files = Array.from(e.clipboardData.files);
  const text = e.clipboardData.getData("text/plain");
  const start = ta.selectionStart, end = ta.selectionEnd;
  const insert = (value: string) => {
    if (!ta.isConnected || !value) return;
    insertAtCursor(ta, value, { start, end });
  };
  if (!files.length) return insert(text);
  setState(s => ({ pasting: s.pasting + 1 }));
  void (async () => {
    switch (pasteKind([], files)) {
      case "paths": return;
      case "text": insert(text); return;
      case "unavailable": setState({ notice: "This browser cannot provide file paths. Paste the full path as text." }); return;
    }
    // Reserve slots before image reads, so overlapping pastes cannot overfill the composer.
    const room = MAX_IMAGES - getState().draftImages.length - reserved;
    const candidates = files.filter(f => f.type.startsWith("image/"));
    const accepted = candidates.slice(0, Math.max(0, room));
    if (accepted.length < candidates.length) setState({ notice: `Attach up to ${MAX_IMAGES} images per message.` });
    reserved += accepted.length;
    try {
      for (const file of accepted) {
        try {
          if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error("Attach GIF, JPEG, PNG or WebP images.");
          const prepared = file.size <= MAX_IMAGE_BYTES ? file : await (await import("./image-compression.ts")).compressImage(file);
          const image = await readImage(prepared);
          setState(s => ({ draftImages: [...s.draftImages, image] }));
        } catch (error) { setState({ notice: error instanceof Error ? error.message : "This image could not be read." }); }
      }
    } finally { reserved -= accepted.length; }
  })().catch(() => setState({ notice: "The clipboard could not be read. Try pasting again." })).finally(() => setState(s => ({ pasting: s.pasting - 1 })));
}

let reserved = 0;
