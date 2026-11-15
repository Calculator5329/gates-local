const SAMPLES_PER_SECOND = 16000;
const LONGEST_CLIP_SECONDS = 60;
const MONO = 1;

export async function captureAudio(stream: MediaStream, overflow: () => void, signal: AbortSignal) {
  // why: the context does the resampling to this rate.
  const context = new AudioContext({ sampleRate: SAMPLES_PER_SECOND });
  try {
    signal.throwIfAborted();
    const chunks: Float32Array[] = [];
    let samples = 0;
    const source = context.createMediaStreamSource(stream);
    // external: Electron and phone browsers run a ScriptProcessor from the page itself; an AudioWorklet needs its own hosted file.
    const node = context.createScriptProcessor(4096, MONO, MONO);
    const mute = context.createGain();
    mute.gain.value = 0;
    node.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      if (samples + data.length > SAMPLES_PER_SECOND * LONGEST_CLIP_SECONDS) { overflow(); return; }
      chunks.push(data.slice()); samples += data.length;
    };
    source.connect(node); node.connect(mute); mute.connect(context.destination);
    const close = () => {
      signal.removeEventListener("abort", discard);
      node.onaudioprocess = null;
      source.disconnect(); node.disconnect(); mute.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      if (context.state !== "closed") void context.close();
    };
    const discard = () => { close(); chunks.length = 0; };
    signal.addEventListener("abort", discard, { once: true });
    await context.resume();
    signal.throwIfAborted();
    return {
      discard,
      finish() {
        close();
        const bytes = new Uint8Array(44 + samples * 2);
        const v = new DataView(bytes.buffer);
        const text = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
        text(0, "RIFF"); v.setUint32(4, bytes.length - 8, true); text(8, "WAVEfmt ");
        v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
        v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
        text(36, "data"); v.setUint32(40, samples * 2, true);
        let at = 44;
        for (const chunk of chunks) for (const n of chunk) { v.setInt16(at, Math.max(-1, Math.min(1, n)) * (n < 0 ? 32768 : 32767), true); at += 2; }
        chunks.length = 0;
        let binary = "";
        for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        return btoa(binary);
      },
    };
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    if (context.state !== "closed") void context.close();
    throw error;
  }
}

export function insertTranscript(draft: string, cursor: number, transcript: string) {
  const at = Math.max(0, Math.min(draft.length, cursor));
  const before = draft.slice(0, at), after = draft.slice(at);
  const added = `${before && !/\s$/.test(before) ? " " : ""}${transcript}${after && !/^\s/.test(after) ? " " : ""}`;
  return { draft: before + added + after, cursor: at + added.length };
}
