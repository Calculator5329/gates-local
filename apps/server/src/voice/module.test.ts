import { afterEach, describe, expect, it } from "vitest";
import { createVoiceModule } from "./module.ts";
import { fakeWhisper, wav } from "./testing.ts";
import { once } from "node:events";
import { createServer } from "node:http";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((f) => f())); });
async function setup(text = "spoken words", timeoutMs = 500) {
  const fake = await fakeWhisper(text);
  cleanups.push(fake.close);
  const settings = { whisperUrl: fake.url };
  const voice = createVoiceModule({ settings: () => settings, timeoutMs });
  return { fake, settings, voice };
}
describe("local dictation", () => {
  it("bounds chunked transcript answers, cancels the response and frees the client's slot", async () => {
    let oversized = false;
    let closed: Promise<unknown> | undefined;
    const text = "a".repeat(32_000 - JSON.stringify({ text: "" }).length);
    const server = createServer(async (req, res) => {
      for await (const part of req) { void part; /* Drain the actual WAV request. */ }
      res.writeHead(200, { "content-type": "application/json" });
      if (!oversized) { res.end(JSON.stringify({ text })); return; }
      closed = once(res, "close");
      res.write('{"text":"');
      res.write("a".repeat(32_000));
      // No end: the size guard must cancel rather than await EOF or the deadline.
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test listener");
    const voice = createVoiceModule({ settings: () => ({ whisperUrl: `http://127.0.0.1:${address.port}` }), timeoutMs: 1000 });
    const transcribe = () => voice.handlers["voice.transcribe"]({ id: "bounded", audio: wav() }, { clientId: 1 });
    expect(await transcribe()).toEqual({ text });
    oversized = true;
    await expect(transcribe()).rejects.toThrow("oversized answer");
    expect(closed).toBeDefined();
    await closed;
    oversized = false;
    expect(await transcribe()).toEqual({ text });
  });
  it("does nothing until connected, then posts an in-memory WAV to whisper", async () => {
    const { voice, fake, settings } = await setup();
    expect(await voice.transcribe(wav())).toEqual({ text: "spoken words" });
    expect(fake.requests).toBe(1);
    settings.whisperUrl = "";
    await expect(voice.transcribe(wav())).rejects.toThrow(/Settings/);
    expect(fake.requests).toBe(1);
  });
  it("refuses remote destinations and redirects before audio can leave loopback", async () => {
    const { voice, settings, fake } = await setup();
    for (const url of ["https://example.com", "http://localhost", "http://127.0.0.1@evil.test", "http://0.0.0.0", "file:///speech"]) {
      settings.whisperUrl = url;
      await expect(voice.transcribe(wav())).rejects.toThrow(/loopback/);
    }
    settings.whisperUrl = fake.url;
    fake.mode = "redirect";
    await expect(voice.transcribe(wav())).rejects.toThrow(/answer/);
  });
  it("checks real WAV size and duration instead of trusting a claimed duration", async () => {
    const { voice, fake } = await setup();
    for (const audio of ["!", Buffer.from("not audio").toString("base64"), wav(61), "A".repeat(2_600_000)]) {
      await expect(voice.transcribe(audio)).rejects.toThrow(/clip|WAV/);
    }
    expect(fake.requests).toBe(0);
    expect(await voice.transcribe(wav(60))).toEqual({ text: "spoken words" });
  });
  it("cancels only the requesting client's job and clears its busy slot", async () => {
    const { voice, fake } = await setup();
    fake.mode = "slow";
    const ctx = { clientId: 1, signal: new AbortController().signal };
    const running = voice.handlers["voice.transcribe"]({ id: "one", audio: wav() }, ctx);
    const result = expect(running).rejects.toThrow(/cancelled/);
    await expect(voice.handlers["voice.transcribe"]({ id: "two", audio: wav() }, ctx)).rejects.toThrow(/already running/);
    voice.handlers["voice.cancel"]({ id: "one" }, { clientId: 2 });
    await expect(voice.handlers["voice.transcribe"]({ id: "two", audio: wav() }, ctx)).rejects.toThrow(/already running/);
    voice.handlers["voice.cancel"]({ id: "one" }, ctx);
    await result;
    fake.mode = "ok";
    expect(await voice.handlers["voice.transcribe"]({ id: "two", audio: wav() }, ctx)).toEqual({ text: "spoken words" });
    const controller = new AbortController();
    fake.mode = "slow";
    const disconnected = voice.handlers["voice.transcribe"]({ id: "three", audio: wav() }, { clientId: 1, signal: controller.signal });
    const ended = expect(disconnected).rejects.toThrow(/cancelled/);
    controller.abort();
    await ended;
  });
  it("names silence, malformed replies, service failure and timeout", async () => {
    const { voice, fake } = await setup("", 50);
    await expect(voice.transcribe(wav())).rejects.toThrow(/Nothing heard/);
    fake.mode = "invalid";
    await expect(voice.transcribe(wav())).rejects.toThrow(/answer/);
    fake.mode = "error";
    await expect(voice.transcribe(wav())).rejects.toThrow(/answer/);
    fake.mode = "slow";
    await expect(voice.transcribe(wav())).rejects.toThrow(/timed out/);
    await fake.close();
    await expect(voice.transcribe(wav())).rejects.toThrow(/not answer/);
  });
});
