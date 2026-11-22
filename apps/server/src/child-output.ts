import type { Readable } from "node:stream";

// why: a child that prints without end keeps only its last `max` characters in the server
export function childOutput(pipe: Readable, max: number, over?: () => void): () => string {
  let text = "";
  let full = false;
  pipe.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
    if (text.length <= max) return;
    text = text.slice(-max);
    if (!full) { full = true; over?.(); }
  });
  return () => text;
}
