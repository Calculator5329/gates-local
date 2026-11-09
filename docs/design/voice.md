# Voice after dictation

Stage 1 is manual dictation into the existing draft. Stage 2 is a separate,
explicit voice conversation mode. This note designs stage 2; no TTS,
automatic send, voice activity detection or continuous microphone is built.

## What Milo teaches us

Read-only references: Milo's `README.md` (How a turn works, Measured latency),
`docs/latency.md`, `docs/voices-and-upstream.md`, `milo/hearing.py`,
`milo/speech_audio.py`, and the audio and cancellation paths in
`milo/server.py` and `milo/conversation.py`, at revision
`fc73a80c3274f32b0772a2d594fa31e09f868a84`. No files were ported.

Keep its sentence-at-a-time speech, cancellation by turn identity, and local
audio. Leave out its wake-free companion session defaults, automatic word
corrections for the owner's vocabulary, personality, router and voice effects.
Dictation should preserve what was recognised so the person can edit it.

Milo measured four synthetic audio turns in each reference run, with
whisper.cpp large-v3-turbo on GPU, a chat model that fit, and Pocket TTS on
two CPU threads. These are Milo measurements, not Gates Local results:

| Timing | Idle reference | Busy reference | Gates Local target to measure |
| --- | --- | --- | --- |
| Request received to transcription done | 75 ms p50 | not reported | under 150 ms p50 for a 3-second clip |
| Request to first model token | 186 ms p50 | 670 ms p50 | under 250 ms idle; under 750 ms busy |
| Request to first audio at client | 404 ms p50 | 850 ms p50 | under 500 ms idle; under 1 s busy |
| Cancel to server stream closed | not measured | 14.5 ms p50, 80 ms max | under 100 ms, zero stale playback |

The idle run was 2026-09-12, busy 2026-09-24. A 350 ms silence gate happens
before those request timings. It must be measured separately and tuned for
natural pauses. Client audio arrival is not proof that sound reached ears.

## The turn loop

The same microphone control gains an explicit **Voice conversation** choice.
Manual Dictate stays the default. In conversation mode it reads Listening,
Transcribing, Answering or Speaking, keeps an elapsed indicator, and always
offers Stop/Esc. No wake word. A first version should use headphones.

1. Capture bounded local PCM. A configurable silence detector ends the turn;
   show the recognised words and preserve a manual stop fallback.
2. Transcribe through the same authenticated local client. Each utterance and
   response gets an identity and cancellation signal, independent of thread data.
3. Send only in explicitly enabled conversation mode. Stream the model's
   answer into the normal chat view and into a sentence buffer. Never speak
   private reasoning, tool payloads or raw Markdown fences.
4. Queue a completed sentence for synthesis while the model produces the
   next one. An optional first-clause boundary, after enough text, can reduce
   initial silence; measure intelligibility before adopting it.
5. Stream PCM chunks to the client and play them in order. Record playback
   acknowledgement separately from generated text. Interrupted speech must
   not be treated as something the person heard; the text chat can still
   retain the full generated answer with its interrupted status.
6. Talking over playback immediately stops local audio, discards queued
   chunks, and sends cancellation for that response identity. Abort generation
   and queued synthesis. Drop every late packet for the old identity before
   accepting the next utterance. Echo cancellation alone does not prove this
   works with speakers; measure false interruptions with real hardware.

## Real choices

| Option | What it buys | What it gives up |
| --- | --- | --- |
| Pocket TTS on CPU, recommended first | Milo's measured streaming path; no extra GPU claim; reusable warmed voice state | CPU contention can raise latency; Python runtime/model setup; each voice's provenance needs checking |
| Another local CPU TTS engine behind the same sentence interface | Can simplify installation or support more languages | New voice quality and latency measurements; may lose incremental chunk streaming |
| Local GPU TTS | Potentially higher quality or more languages | Competes with chat and protected whisper; cannot run until the existing GPU lease and measured VRAM fit admit it; may delay speech enough to erase the gain |

No cloud fallback. Never unload, restart or reconfigure whisper. Prefer CPU
TTS so speaking can overlap generation without a new GPU occupant. A GPU
option needs measured memory admission and existing lease coordination; it
cannot bypass the chat/image rules. Pocket TTS voice licenses vary by source;
do not label every preset CC0. Audition and document a redistributable voice
before choosing a default.

Stage 1 leaves the PCM capture, authenticated transcription, bounded clips,
per-client request identity, abort propagation and late-result rejection open
for this loop. It deliberately adds no continuous listening, auto-send,
sentence scheduler, TTS runtime or history policy. Those remain stage 2 work,
with first-audio and interruption measurements required before acceptance.
