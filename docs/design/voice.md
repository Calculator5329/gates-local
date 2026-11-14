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

## What a bundled voice would ship, and its licence

Read 2026-11-13 (chat row 43) for the four voices on the listening page, before
anything is bundled into this MIT app. Sources are the licence files inside
the downloaded wheels and the projects' model cards, as they read that day.
Where a source says nothing, the row says unclear; nothing here is legal advice.
"Ship" means: may this file go inside the Gates Local installer next to MIT code.

| Voice | Item (version read) | Licence | Where the licence text is | Ship inside the MIT installer? | Notice it needs |
| --- | --- | --- | --- | --- | --- |
| Pocket TTS | `pocket-tts` Python package 3.1.0 | MIT | `LICENSE` in the wheel; MIT on the GitHub repository | Yes | The MIT text. The wheel's copy has no copyright line. |
| Pocket TTS | Weights and tokenizer, `kyutai/pocket-tts-without-voice-cloning`, English (219.0 MB) | CC BY 4.0 | Model card metadata only; no licence file in the download | Yes, with attribution | Credit Kyutai, name CC BY 4.0 with a link, say if changed. The model card also lists prohibited uses (impersonation or cloning without consent, misinformation, fraud, harassment); whether that list binds beyond CC BY is unclear. |
| Pocket TTS | Voice `marius` (state from `voice-donations/Selfie.wav`, per `pocket_tts/utils/utils.py`) | Source audio CC0; the state file sits in the CC BY 4.0 weights repository | `kyutai/tts-voices` README: voice donations "licensed as CC0" | Yes, as far as stated; the state file's own licence is not stated (unclear) | None for CC0 (a citation is asked only for academic work); covered by the weights' CC BY notice |
| Pocket TTS | Voice `javert` (state from `voice-donations/Butter.wav`) | Same as marius | Same as marius | Same as marius | Same as marius |
| Pocket TTS | PyTorch CPU 2.8.0 | BSD-3-Clause, with many bundled third-party licences | `LICENSE` (491 KB, includes the third-party texts) and `NOTICE` in the wheel | Yes | Ship `LICENSE` and `NOTICE` as they are |
| Kokoro | Kokoro-82M weights | Apache 2.0 | Model card metadata only; no licence file in the download | Yes | The Apache 2.0 text. The card lists CC BY training audio (Koniwa tnc, CC BY 3.0; SIWIS, CC BY 4.0); whether the weights must credit it is unclear. |
| Kokoro | `kokoro-v1.0.onnx`, the ONNX conversion from the kokoro-onnx GitHub release | Not stated | Release page says only "optimized f32 version from taylorchu/kokoro-onnx" | Unclear | Unclear |
| Kokoro | Voice `af_heart` in `voices-v1.0.bin` (54 voices) | Not stated | `VOICES.md` states no licence for voice files; the repository label is apache-2.0; the release that ships the file states none | Unclear | Unclear |
| Kokoro | `kokoro-onnx` Python package 0.6.1 | MIT | `LICENSE` in the wheel | Yes | The MIT text |
| Kokoro | `phonemizer` 3.4.0, required by kokoro-onnx | GPL-3.0-or-later | `LICENSE` in the wheel and its metadata | Unclear: GPL allows shipping with its source and licence, but it loads into the same process as the voice code, and what that means for the rest of the installer is a legal question | GPL 3 text and a source offer |
| Kokoro | `espeakng-loader` 0.2.4 with `libespeak-ng.so` and `espeak-ng-data` | Loader: MIT (GitHub label; the wheel states none). espeak-ng: GPL-3.0-or-later; the data files' licence is not stated separately | espeak-ng README | Unclear, as phonemizer | GPL 3 text and a source offer |
| Piper | `piper-tts` 1.8.0 (OHF-Voice/piper1-gpl), with `espeakbridge.so` and `espeak-ng-data` inside | GPL-3.0-or-later, plus one Apache 2.0 file (g2pW) | `COPYING` and `licenses/LICENSE.g2pW-Apache-2.0` in the wheel | Unclear, as phonemizer. The older MIT `rhasspy/piper` was not checked. | GPL 3 text, the Apache 2.0 text, a source offer |
| Piper | `en_US-lessac-high.onnx` (113.9 MB) | Repository label MIT; trained on the Blizzard 2013 Lessac corpus, whose licence is research only | `rhasspy/piper-voices` metadata; `MODEL_CARD` links the dataset licence at cstr.ed.ac.uk | Unclear. The dataset licence allows "Research Purposes only", excludes "the development, marketing, commercialisation, sale or licencing of voice synthesis" products, and forbids letting third parties use the materials. It does not say whether that reaches a model trained on them. | Unclear |
| Kokoro, Piper | ONNX Runtime 1.30 and 1.32 | MIT | `LICENSE` and `ThirdPartyNotices.txt` in the wheel | Yes | The MIT text and `ThirdPartyNotices.txt` |

What this means for the pick, without deciding it: Pocket TTS with marius or
javert is the only set with no GPL part and no file whose licence is wholly
unstated. Its open points are the voice state files' own licence (their
source audio is CC0, the repository they ship in is CC BY 4.0) and the model
card's use list. Kokoro as packaged here brings GPL
phonemizing and two files with no stated licence. Piper brings a GPL runtime
and a voice trained on research-only data.

Not read: the Python dependencies under each voice besides the rows above
(Pocket TTS: numpy, scipy, sentencepiece, safetensors, einops, huggingface-hub,
fastapi, uvicorn, pydantic, typer, requests and their own dependencies), a
Python interpreter if one ships, and any non-Python runtime (for example ONNX
Runtime for Node) that a bundled voice might use instead of these wheels.
