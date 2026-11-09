import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fakeWhisper, wav } from "../../apps/server/src/voice/testing.ts";

export function fakeMicrophoneFile() {
  const cache = path.join(homedir(), ".cache", "gates-local-perf"); mkdirSync(cache, { recursive: true });
  const file = path.join(mkdtempSync(path.join(cache, "audio-")), "speech.wav");
  const audio = Buffer.from(wav(2), "base64");
  for (let i = 44; i < audio.length; i += 2) audio.writeInt16LE(Math.sin((i - 44) / 2 * 440 * Math.PI * 2 / 16000) * 3000, i);
  writeFileSync(file, audio);
  return file;
}

const noop = () => {};
function latch() {
  let resolve = noop;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Same fake Whisper protocol as voice.spec.ts; optional gate only isolates arrival handling. */
export async function fakeVoice() {
  const backend = await fakeWhisper();
  let pending: { arrived: ReturnType<typeof latch>; release: ReturnType<typeof latch> } | undefined;
  const server = createServer((req, res) => {
    void (async () => {
      const parts: Buffer[] = [];
      for await (const part of req) parts.push(Buffer.from(part));
      if (req.url === "/inference" && pending) { pending.arrived.resolve(); await pending.release.promise; }
      const reply = await fetch(backend.url + (req.url ?? "/"), { method: req.method, headers: { "content-type": req.headers["content-type"] ?? "application/json" }, ...(req.method === "POST" ? { body: Buffer.concat(parts) } : {}) });
      res.writeHead(reply.status, { "content-type": "application/json" }).end(Buffer.from(await reply.arrayBuffer()));
    })().catch(error => { res.destroy(error instanceof Error ? error : new Error(String(error))); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fake voice has no loopback port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    hold() {
      pending = { arrived: latch(), release: latch() };
      return { arrived: pending.arrived.promise, release: pending.release.resolve };
    },
    async close() {
      pending?.release.resolve();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await backend.close();
    },
  };
}
