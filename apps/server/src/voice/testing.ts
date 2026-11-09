// A loopback-only whisper stand-in. Never contacts a real speech service.
import { createServer } from "node:http";

export function wav(seconds = 1): string {
  const b = Buffer.alloc(44 + 32000 * seconds);
  b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(b.length - 44, 40);
  return b.toString("base64");
}

export async function fakeWhisper(text = "spoken words") {
  const state = { mode: "ok", requests: 0, text, url: "", close: async () => {} };
  const server = createServer(async (req, res) => {
    if (req.url === "/health") { res.writeHead(200).end("{}"); return; }
    if (req.url !== "/inference" || req.method !== "POST") { res.writeHead(404).end(); return; }
    state.requests++;
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const body = Buffer.concat(parts);
    if (!body.includes(Buffer.from("RIFF")) || !req.headers["content-type"]?.includes("multipart/form-data")) { res.writeHead(400).end(); return; }
    if (state.mode === "slow") return;
    if (state.mode === "redirect") { res.writeHead(302, { Location: "https://example.com" }).end(); return; }
    if (state.mode === "error") { res.writeHead(503).end(); return; }
    res.writeHead(200, { "Content-Type": "application/json" }).end(state.mode === "invalid" ? "{}" : JSON.stringify({ text: state.text }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fake address");
  state.url = `http://127.0.0.1:${address.port}`;
  state.close = async () => { server.closeAllConnections(); if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve())); };
  return state;
}
