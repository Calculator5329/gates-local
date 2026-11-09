import { constants } from "node:fs";
import { mkdir, open, realpath, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { TurnMessage } from "./types.ts";
import { imageDimensions, visionTokens } from "./image-header.ts";
import { OMITTED_IMAGE } from "./window.ts";

const MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_PATH = /^images\/paste-[a-f0-9-]+\.(png|jpeg|webp|gif)$/;

/** T3 Code ChatView.tsx image-only prompt at d137c5081ac5efb2b8ea9aec8b334e1bb4d0182a (MIT). */
export function imagePrompt(message: TurnMessage): TurnMessage {
  return message.role === "user" && message.images?.length && !message.content.trim()
    ? { ...message, content: "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]" }
    : message;
}

/** Validate before any load or save. Saved paths are confined to random pasted-image names. */
export function checkAttachments(images: readonly string[]): void {
  if (images.length > 8) throw new Error("Attach up to 8 images per message.");
  for (const image of images) {
    if (IMAGE_PATH.test(image)) continue;
    const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
    if (!match || match[2]!.length > Math.ceil(MAX_BYTES / 3) * 4) throw new Error("Paste a GIF, PNG, JPEG or WebP image, up to 10 MB each.");
    const bytes = Buffer.from(match[2]!, "base64");
    if (bytes.length > MAX_BYTES || bytes.toString("base64") !== match[2]) throw new Error("Paste a GIF, PNG, JPEG or WebP image, up to 10 MB each.");
    imageDimensions(bytes, match[1]!);
  }
}

/** Image bytes live on disk, keeping thread replies and reloads below the socket's message limit. */
export async function saveAttachments(dataDir: string, images: readonly string[]): Promise<string[]> {
  await mkdir(path.join(dataDir, "images"), { recursive: true });
  const root = path.join(await realpath(dataDir), "images");
  if (await realpath(root) !== root) throw new Error("The image folder is not available.");
  const saved: string[] = [];
  const created: string[] = [];
  try {
    for (const image of images) {
      if (IMAGE_PATH.test(image)) { saved.push(image); continue; }
      const comma = image.indexOf(",");
      const ext = image.slice(11, image.indexOf(";"));
      const name = `images/paste-${randomUUID()}.${ext}`;
      await writeFile(path.join(dataDir, name), Buffer.from(image.slice(comma + 1), "base64"), { flag: "wx", mode: 0o600 });
      created.push(name);
      saved.push(name);
    }
    return saved;
  } catch (error) {
    await Promise.all(created.map(name => unlink(path.join(dataDir, name))));
    throw error;
  }
}

async function readAttachment(dataDir: string, image: string): Promise<Buffer> {
  if (!IMAGE_PATH.test(image)) throw new Error("An attached image is not available. Paste it again.");
  const filename = path.join(await realpath(dataDir), image);
  if (await realpath(filename) !== filename) throw new Error("An attached image is not available. Paste it again.");
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("An attached image is not available. Paste it again.");
    return await handle.readFile();
  } finally { await handle.close(); }
}

/** The initial window bounds this read. Parse input dimensions before final context admission. */
export async function accountImages(dataDir: string, messages: readonly TurnMessage[], info: Readonly<Record<string, unknown>> = {}): Promise<{ messages: TurnMessage[]; omitted: boolean }> {
  const output: TurnMessage[] = [];
  let omitted = false;
  for (const [index, message] of messages.entries()) {
    const images: string[] = [], tokens: number[] = [];
    let missing = 0;
    for (const image of message.images ?? []) {
      try {
        const mime = image.startsWith("data:") ? image.slice(11, image.indexOf(";")) : image.slice(image.lastIndexOf(".") + 1);
        const bytes = image.startsWith("data:") ? Buffer.from(image.slice(image.indexOf(",") + 1), "base64") : await readAttachment(dataDir, image);
        tokens.push(visionTokens(imageDimensions(bytes, mime), info));
        images.push(image);
      } catch (error) {
        if (index === messages.length - 1) throw new Error("An attached image is no longer available or could not be read. Paste it again; your words are kept.", { cause: error });
        missing++;
      }
    }
    if (!message.images?.length) { output.push(message); continue; }
    omitted ||= missing > 0;
    output.push({ role: message.role, content: message.content + (missing ? `\n${OMITTED_IMAGE}` : ""), ...(images.length ? { images } : {}), imageTokens: [...tokens, ...Array.from({ length: missing }, () => 0)] });
  }
  return { messages: output, omitted };
}

/** Only images in the fitted window are read and resent. Generated assistant images never become vision input. */
export async function visionHistory(dataDir: string, history: readonly TurnMessage[]): Promise<TurnMessage[]> {
  return Promise.all(history.map(async m => {
    if (!m.images?.length) return m;
    const images = await Promise.all(m.images.map(async image => {
      return (await readAttachment(dataDir, image)).toString("base64");
    }));
    return { ...m, images };
  }));
}
