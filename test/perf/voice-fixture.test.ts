import { expect, test } from "vitest";
import { wav } from "../../apps/server/src/voice/testing.ts";
import { fakeVoice } from "./voice-fixture.ts";

test("the existing fake transcription stays held until the input probe releases it", async () => {
  const voice = await fakeVoice();
  try {
    expect((await fetch(voice.url + "/health")).ok).toBe(true);
    const held = voice.hold();
    const body = new FormData(); body.append("file", new Blob([Buffer.from(wav(), "base64")]), "speech.wav");
    let finished = false;
    const response = fetch(voice.url + "/inference", { method: "POST", body }).then(value => { finished = true; return value; });
    await held.arrived; expect(finished).toBe(false); held.release();
    expect(await (await response).json()).toEqual({ text: "spoken words" });
  } finally { await voice.close(); }
});
