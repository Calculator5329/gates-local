# Local voice to text

Dictation is off until you connect a speech server. It uses a running
whisper.cpp HTTP server on this computer, never a cloud speech API or the
browser's Web Speech service. Gates Local only makes client requests. It
never installs, starts, stops, restarts or reconfigures whisper.cpp.

If you already run whisper.cpp, leave it running as it is. In Settings ›
General › Voice to text, enter its loopback HTTP address (for example
`http://127.0.0.1:8178`) and click **Connect**. The server must provide
`GET /health` and multipart `POST /inference`, with `response_format=json`
returning a `text` field. If you do not have one, follow the
[whisper.cpp server setup](https://github.com/ggml-org/whisper.cpp/tree/master/examples/server)
yourself first, choosing a model and GPU allocation that fit alongside chat.
Connecting checks health; it does not load or manage a speech model.

The address must use HTTP and a loopback IP literal (`127.0.0.1` or `[::1]`),
without credentials, query parameters or a path. `localhost` is deliberately
not accepted: IP literals avoid DNS changing an audio destination. Redirects
are refused. The address is interpreted on the computer running Gates Local's
server, including when you open the app on a phone.

Click **Dictate** in the composer, allow microphone access, speak, then click
again to stop. **Ctrl+Shift+Space** also starts or stops; **Esc** discards the
recording or cancels transcription. Listening shows elapsed seconds. Each
clip must stay below 60 seconds. Transcription times out after 20 seconds.
The transcript is inserted at your current draft cursor without replacing
existing words, and is never sent automatically. Check it before pressing Send.
Undo removes the inserted transcript as one edit; redo restores it.
Send, Queue, clearing the draft or switching to another draft cancels pending
dictation. If a drawer prevents insertion, the recognised words are kept in
a selectable plain line under the composer when it is visible again. They
are never inserted into the drawer's search field.

Audio is mono, 16 kHz PCM WAV, held in memory only. It is not saved in the
thread database or written to disk by Gates Local. The configured whisper
server controls its own handling of uploaded audio. Leaving the thread,
opening Settings, closing the page or losing the app connection releases the
microphone and cancels outstanding transcription. Cancelling while waiting
for browser permission also stops any stream that arrives later.

On a phone, use the app's existing HTTPS access path. Plain network HTTP
cannot use the microphone; the control explains the secure-context requirement.
The phone sends its clip over that authenticated connection to your Gates
Local computer, which forwards it only to the configured loopback speech server.
The desktop permits microphone audio only for its own main client frame.
Camera, screen capture and all other permissions remain denied.

- Permission denied: allow microphone access for this app in the OS or browser.
- No microphone: connect one and check the OS input device.
- Server did not answer: check your existing server and its address, then retry.
- Nothing heard: speak closer to the microphone and record again.
- Clip too long: record a shorter passage; the draft is left intact.
- Timed out: check that whisper.cpp can finish a short clip, then retry.

Disconnect in Settings to turn dictation off. It leaves whisper.cpp running.
Automated tests use fake microphone audio and a fake server on a temporary
loopback port. A real microphone and real recognition quality still need a
person's check.
