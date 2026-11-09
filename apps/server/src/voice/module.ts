// Inspired by Milo's milo/server.py transcription flow; implemented here for
// Gates Local's authenticated RPC, without its companion-specific corrections.
import * as S from "effect/Schema";
import { randomUUID } from "node:crypto";
import { WireError } from "@gates-local/contracts";
import type { Handlers } from "../ws/server.ts";

const MAX_BYTES = 44 + 16000 * 2 * 60;
const Transcript = S.Struct({ text: S.String });
const error = (message: string) => new WireError("voice", message);

/** IP literals only: no DNS rebinding, redirects, credentials or remote speech APIs. */
export function whisperAddress(value: string): string {
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" || u.username || u.password || u.search || u.hash || u.pathname !== "/" ||
      !(u.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(u.hostname))) throw 0;
    return u.origin;
  } catch { throw error("Use a loopback HTTP address such as http://127.0.0.1:8178 in Settings › General."); }
}

/** Accept exactly the bounded 16 kHz mono PCM format our recorder produces. */
function audioBytes(audio: string): Buffer {
  if (audio.length > Math.ceil(MAX_BYTES / 3) * 4)
    throw error("The clip is too large or invalid. Record at most 60 seconds.");
  const b = Buffer.from(audio, "base64");
  if (b.toString("base64") !== audio || b.length < 46 || b.length > MAX_BYTES || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 16) !== "WAVEfmt " ||
    b.readUInt32LE(4) !== b.length - 8 || b.readUInt32LE(16) !== 16 || b.readUInt16LE(20) !== 1 || b.readUInt16LE(22) !== 1 ||
    b.readUInt32LE(24) !== 16000 || b.readUInt32LE(28) !== 32000 || b.readUInt16LE(32) !== 2 || b.readUInt16LE(34) !== 16 ||
    b.toString("ascii", 36, 40) !== "data" || b.readUInt32LE(40) !== b.length - 44 || (b.length - 44) % 2)
    throw error("Invalid WAV clip. Record at most 60 seconds of microphone audio.");
  return b;
}

export function createVoiceModule(deps: { settings(): { whisperUrl?: string }; timeoutMs?: number }) {
  const active = new Map<number, { id: string; controller: AbortController }>();
  const transcribe = async (audio: string, signal?: AbortSignal) => {
    const configured = deps.settings().whisperUrl;
    if (!configured) throw error("Connect a local whisper.cpp server in Settings › General first.");
    const url = whisperAddress(configured);
    const bytes = audioBytes(audio);
    // A fixed byte body also avoids a FormData encoder continuing to enqueue
    // into an aborted fetch stream during cancellation on Node.
    const boundary = `speech-${randomUUID()}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n--${boundary}\r\nContent-Disposition: form-data; name="temperature"\r\n\r\n0\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
      bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const deadline = AbortSignal.timeout(deps.timeoutMs ?? 20_000);
    try {
      const response = await fetch(`${url}/inference`, { method: "POST", body, headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }, redirect: "error", signal: signal ? AbortSignal.any([deadline, signal]) : deadline });
      if (!response.ok) throw error("whisper.cpp did not answer successfully. Check the local server, then retry.");
      // Bound the response too, including chunked replies, rather than allocating arbitrary JSON.
      const reader = response.body?.getReader();
      if (!reader) throw error("whisper.cpp returned an invalid answer.");
      let result = "";
      try {
        const decoder = new TextDecoder();
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          result += decoder.decode(part.value, { stream: true });
          if (result.length > 32_000) throw error("whisper.cpp returned an oversized answer.");
        }
        result += decoder.decode();
      } finally { await reader.cancel(); }
      const decoded = S.decodeUnknownSync(Transcript)(JSON.parse(result));
      const text = decoded.text.trim();
      if (!text || /^\s*(\[[^\]]*\]|\([^)]*\))\s*$/.test(text)) throw error("Nothing heard. Try again closer to the microphone.");
      return { text };
    } catch (e) {
      if (signal?.aborted) throw error("Dictation cancelled.");
      if (deadline.aborted) throw error("Transcription timed out. Check whisper.cpp, then retry.");
      if (e instanceof WireError) throw e;
      throw error("whisper.cpp did not answer with a valid transcript. Check the local server, then retry.");
    }
  };
  const handlers = {
    "voice.check": async ({ url }) => {
      const address = whisperAddress(url);
      try {
        const r = await fetch(`${address}/health`, { redirect: "error", signal: AbortSignal.timeout(deps.timeoutMs ?? 3000) });
        await r.body?.cancel();
        if (!r.ok) throw 0;
        return { ready: true };
      } catch { throw error("whisper.cpp did not answer. Start it yourself, check the address, then connect again. Gates Local never starts or stops it."); }
    },
    "voice.transcribe": async ({ audio, id }, ctx) => {
      if (active.has(ctx.clientId) || active.size >= 2) throw error("A transcription is already running. Wait for it to finish.");
      const controller = new AbortController();
      active.set(ctx.clientId, { id, controller });
      try { return await transcribe(audio, ctx.signal ? AbortSignal.any([controller.signal, ctx.signal]) : controller.signal); }
      finally { active.delete(ctx.clientId); }
    },
    "voice.cancel": ({ id }, ctx) => {
      const job = active.get(ctx.clientId);
      if (job?.id === id) job.controller.abort();
      return {};
    },
  } satisfies Partial<Handlers>;
  return { transcribe, handlers };
}
