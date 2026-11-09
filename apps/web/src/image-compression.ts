// Adapted from T3 Code lib/imageCompression.ts at d137c5081ac5efb2b8ea9aec8b334e1bb4d0182a (MIT).
import { MAX_IMAGE_BYTES } from "./paste.ts";

/** Keep small images verbatim; shrink oversized images using T3's resolution and quality ladder. */
export async function compressImage(file: File): Promise<File> {
  if (file.size <= MAX_IMAGE_BYTES) return file;
  if (file.size > 50 * 1024 * 1024) throw new Error("This image is too large to attach. Use an image under 50 MB; pasted images are compressed to 10 MB.");
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error("This image could not be read."); }
  try {
    const base = Math.min(2048, Math.max(bitmap.width, bitmap.height));
    for (const factor of [1, 0.75, 0.55]) {
      const scale = Math.min(1, base * factor / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      const mime = canvas.toDataURL("image/webp").startsWith("data:image/webp") ? "image/webp" : "image/jpeg";
      if (mime === "image/jpeg") { ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.92, 0.85, 0.78, 0.68]) {
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, mime, quality));
        if (blob && blob.size <= MAX_IMAGE_BYTES) return new File([blob], mime === "image/webp" ? "pasted.webp" : "pasted.jpeg", { type: mime });
      }
    }
    throw new Error("This image is too large to attach, even after compression to 10 MB.");
  } finally { bitmap.close(); }
}
