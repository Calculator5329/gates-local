# Roadmap

Transplanted from the incubator seed roadmap on 2026-11-07. Items run in
order; `AGENTS.md` names the owns paths. Every "whisper unchanged" check
compares its PID and VRAM before and after, and the fake runtime's call log
never shows a whisper stop, start or restart.

## Now: slice 1, desktop chat and models

*2026-11-11, picker freshness:* The first opening waits for current fit answers
after a GPU change or completed model load, including when intent had already
warmed the old answers. Explicit errors settle the barrier; failed startup
reads still leave the picker usable. An already open picker retains readable
history during refresh. The performance harness applies CPU throttling to its
fresh picker sessions as well as its main journey.

*2026-11-10, picker warms on intent and thread measurements:* The picker
keeps its complete-first-view barrier and warms its fit cache only on hover,
keyboard focus or pointer-down, never at idle, while a reply runs or while a
model loads. After a reply, focus-then-Enter opens in 40.45 ms instead of
292.73 and a hand click in 120.63 instead of 287.20, both faster over 4 rounds,
with the same fit-check count as before in every measured session. A scripted
click with no hover first still waits about 293.38 ms for its checks; making that
case fast needs faster checks while keeping its first answers current. A hover
that leaves without opening costs one warm (5 checks).
Broad thread-open rows end at the first screen and retain full-fill `-mounted`
twins; old release reports used the full fill for the plain rows and are labeled
accordingly.

- [ ] <!-- workspace:id=work:bd43faf2-3ad7-5ce0-a367-796c4579aea1 --> A click on the model button with no hover first still waits about 293 ms for its fit checks. Each check reads the GPU again on the server.
      *Accept:* the checks for one opening share one GPU reading, the first view waits for current answers, and the scripted-click row is measured faster.
- [ ] <!-- workspace:id=work:a685bc32-2449-5e0b-8625-2a38dfb08221 --> The page's record of which models are loading is never reset on reconnect. A "ready" message lost across a reconnect leaves a model shown as loading, and the picker then never warms for the rest of the session (it still opens, as slowly as before). In the code before the picker warm-up.
      *Accept:* a reconnect reads the load states again, shown by a test that drops the ready message.
- [ ] <!-- workspace:id=work:86339694-3177-51df-8f04-7808d922bef8 --> The model used last is kept in the page only, so a reload or a restart starts new chats on the default again.
      *Accept:* the server keeps one app-wide last-used model; a new chat after a restart starts on it, and a second window agrees.
- [ ] <!-- workspace:id=work:15d9fb0b-e9fa-5869-ab20-abd8734989da --> The page throws away the answer to its own `models.load` and waits for the pushed state, and it keys a load by model only, so two context sizes of one model share one loading mark.
      *Accept:* a failed load shows its reason on the composer that asked, and a load at 16k does not mark the 32k row as loading.
- [ ] <!-- workspace:id=work:6a2527cb-d90e-58ff-a765-2a74a27da126 --> A first message to a model that a preload is already loading starts its own wait behind that load.
      *Accept:* the turn joins the running preload, shown by one residency read and one generate for the pair.
- [ ] <!-- workspace:id=work:44254433-4354-58d3-ba51-04fdcd40fd17 --> The Default card in Settings shows the app's pick before anyone picks, while New thread starts on the model used last; the two can name different models with no saved default.
      *Accept:* decide which one the card means and say it once on the card.
- [x] <!-- workspace:id=work:eee4b8c7-1d1d-5fa8-af4d-274277beda34 --> Thinking and tool calls in a reply are one control. Today each tool call is its own row, a second round of thinking grows inside the first thought above those rows and pushes them down, its label says "Thought for" while the model thinks again, and the bottom row says "Writing" during it.
      *Done 2026-11-11:* "A reply's thinking and tool calls fold into one chip"; follow-ups under "Work chip, review follow-ups".
- [ ] <!-- workspace:id=work:7d4370b7-afe9-5e0f-b438-8ea1d02fca00 --> A reply stopped while the model was thinking reads "Show thinking" and its pill can change width at Stop.
      *Accept:* the stopped thought keeps its seconds and its box.
- [ ] <!-- workspace:id=work:6a3a902b-86b2-59ec-b753-dda94ddcd3a8 --> Live thoughts are checked with the test model only. Try a real thinking model, the desktop window and the phone width.

*Measured 2026-11-09:* Native launch now includes Electron and the supervised
server, with separate phase markers and import counters. Startup imports fell
from 396 to 291; main initialization and same-thread reconnect have qualified
timing improvements. Whole launch, cold composer and first-run readiness still
need lower-noise measurements before claiming an overall improvement. Reconnect
keeps exact saved text and the existing offline/download ordering tests.

*Done 2026-11-09, input performance:* A 50,000-character multiline paste is one
native undoable edit, with 69.2 ms median latency versus 19,135.0 ms in the paired
comparison. Draft writes start on edits; recovery retains the last completed
transaction, while unload of active or pending work is best effort. Two browser
repetitions passed selection, Undo/Redo, subsequent typing, reload, images,
voice and queue checks. The original reload check had a screenshot delay;
the review follow-up removes it. Queue and first-words pacing stay unchanged.

*Done 2026-11-09, persistence review:* Text edits reuse unchanged attachments;
one transaction runs while one replaceable latest snapshot waits. Existing
combined drafts migrate to separate metadata and attachment records atomically.
Ten edits with 90 MiB of attachments submitted 655 string-payload bytes in the
browser diagnostic instead of about 900 MiB. The direct-reload check now captures
its screenshot after recovery, with the unload durability limit documented.

*Done 2026-11-09, shared-scope draft review:* A text edit checks the stored
attachment revision in its write transaction before reusing a local payload.
Another tab's replacement or clear cannot mix its images with the last writer's
words. Recovery probes use fresh module/store state, including the held-write
probe. Legacy migration and the bounded metadata-only single-tab path remain.

- [ ] <!-- workspace:id=work:4a67ae55-fe9f-548f-8749-1318755bce48 --> Download rows: say Ollama is stopped instead of Rechecking when the runtime is down.

- [x] <!-- workspace:id=work:ba90d67f-9fcc-5806-b1b8-66998aaf2d92 --> Tooltip layer closes an open tooltip when its target's `data-tip` changes (done 2026-11-11 with the sidebar footer: the tip follows its anchor's new words in place)

- [ ] <!-- workspace:id=work:0a5c2069-fd11-5ce8-ab69-dc95e6abf647 --> Update ask in the footer: when Go finds that only the update's target changed, no line is marked and the screen reader status says just "Changed:". Say what changed. The status region is also in the page from the first render, so its first words may not be announced; check with a screen reader.
- [ ] <!-- workspace:id=work:3bed893c-95bb-50a1-8273-f79de8250400 --> The update ask tells the server's activity lines apart by matching their words (`update-work.ts` against the strings built in the server's `main.ts`). A reworded server line would fall through to "must finish before the update", which is untrue for a reply. Send a kind and a count with each line and build every word in the client.
- [ ] <!-- workspace:id=work:69f9ff9e-cbc0-5a39-8474-2714f488329e --> Settings › General: the Update button still asks with the browser's dialog (`update-install.ts`). Use the footer's ask, or its lines in our own dialog. The sentence under it ("Falls back to … if a step fails.") can be shortened at the same time.
- [ ] <!-- workspace:id=work:1c1f4645-fb03-5c2a-8da8-60dd55b65f5a --> Footer update ask: Go dismisses the shown result before the install's outcome is known. Keep it until the outcome arrives.
- [ ] Settings › Updates on a clone whose remote has no release tags, with Get every change off: every check comes back as the main channel and the row drops it, so it says "Not checked yet" again and never offers the update. Fix on the server: drop the last check and send `update.changed` when the switch changes, and stop comparing channels in `SettingsUpdates.tsx`. That also stops the footer offering the other choice's commit after the switch flips (nothing installs it: the install checks again first).
- [ ] Settings › Updates on a phone that only listens: the release page link grows the second row from 73 to 110 px at 390 px, because it is drawn outside `.upd-acts`. Reserve the line or keep the link in the tip, and add a 390 px listener step to the spec.
- [ ] Settings › Updates: a failed Download stays shown over a newer check (`outdated()` covers only a failed check).
- [ ] Settings: an accent name this version does not know (a file written by a newer version) fails the whole settings decode, so every setting goes back to its default. Drop the unknown value and keep the rest; the same holds for any later choice list.
- [ ] The desktop app keeps no server log: the server's output is thrown away, so a reply that failed cannot be looked into afterwards. Keep a small rolling log in the app's data folder.
- [ ] Pictures: the thumbnail encoder (WebAssembly) is proved in the packaged Linux build only. Run the packaged Windows build once and ask for a thumbnail before the Pictures screen ships.
- [ ] Pictures: `THIRD_PARTY_NOTICES.md` in the repo does not list the WebP encoder and the PNG reader yet; only the packaged notices file does.
- [ ] Pictures: backfill time on a large library is not measured, and the phone listener's thumbnail route has no test.
- [ ] Pictures round 3: Compare, Save all, Delete; timing journeys with 5,000 pictures.
- [ ] Image defaults: the style bench should report winners for Icons, Text and logos, and Painterly and concept art. Until then the Defaults menu has no row for those three.
- [ ] The shell tool description could show a quoted dot command, such as `sqlite3 db ".schema elements"`. A model that writes `sqlite3 db .schema elements` passes "elements" as a separate SQL argument and the call fails.
- [ ] Settings row 6: Models is its own pop-up (done 2026-11-13). Usage, wider and shorter, and Settings as a pop-up in the same style are next.
- [ ] Settings › Advanced at 360 px: a fit table that arrives late can push the rows below it. Give the table its room from the first frame.
- [ ] The suggested chat models are a data file now, but a new list still needs an app update. Fetching a signed list between updates needs a key and the owner's go.
- [ ] <!-- workspace:id=work:ac0688c8-5c8a-5e45-9db3-ff28388854c2 --> A tooltip that kept its left edge while its anchor's words changed can end up no longer over its anchor when the anchor moved a long way. Keep the old edge only while it still overlaps the anchor.
- [ ] <!-- workspace:id=work:8f735c71-ed2b-50ce-af38-4f7fb674a909 --> An installed copy with a bad release signature: the footer's click that opens the release page is not built; it opens Settings.
- [ ] <!-- workspace:id=work:fc4fd672-4932-5890-95b8-e2804d8dcdb5 --> Footer browser specs for the fix rounds (errors cleared by good news, the ask re-read at Go, Escape order) were written with their fixes and were not each watched failing in a browser first; the unit tests for the same rules were.
- [ ] <!-- workspace:id=work:7e2a1ab5-0243-5df4-af60-1c19313125cb --> Escape in the footer's ask is handled in the capture phase, ahead of any dialog a later change opens above it (older than the footer work).
- [ ] <!-- workspace:id=work:aea0540e-2704-5bfa-a6a6-f41ee69c8d04 --> In browser tabs, drafts for every thread share one stored record per host, so two tabs can overwrite each other's draft list (older than the footer work; the desktop window is not affected).

- [ ] <!-- workspace:id=work:7d12a936-de06-5b7b-a3f8-f1a17ec67102 --> Text held as a possible tool call (up to 8,000 characters) is lost when the app itself ends the turn: a runtime change, another chat taking the model, or the app closing. The close message then says the reply so far was saved when that part was not. The app would have to drain the turn before ending it.
- [ ] <!-- workspace:id=work:277115b2-0437-544a-b7ac-874675af8ede --> A JSON answer whose first key is `arguments`, `parameters`, `action_input` or `tool_input` is held until its second key closes or 8,000 characters pass. Release as soon as that key's value opens with anything but `{` or `"`.
- [ ] <!-- workspace:id=work:9c0a9e49-b5ad-5213-93a8-55baa24135cb --> Try the text-call recovery with the real model that wrote `{"action": "image", …}` as its reply (it is checked with the test model only), and note whether copied text that happens to be a call should be blocked from running.
- [ ] <!-- workspace:id=work:0abd5443-0ef6-5d82-8919-785a4a5037ea --> A call written as text is shown as text, not run, in these cases: inside thinking tags written inline; with a no-break space, byte-order mark or form feed around the object; with duplicate keys; when the quoted bare string keeps its quotes. And on a round where the tool definitions were dropped to fit the context, nothing is recovered.
- [ ] <!-- workspace:id=work:059d62f7-ae30-5953-bd9d-5fd01ae3eba6 --> Tool definitions are checked for `type`, `required`, unknown keys and `minimum` only. A definition that later uses `maximum`, `enum` or a length limit would have that keyword ignored when a text call is checked.
- [ ] <!-- workspace:id=work:f4db7a72-619e-51bd-877b-fa83159c10a9 --> No test covers Stop landing after the tool-phase deadline already fired (the held text is then dropped).

- [ ] <!-- workspace:id=work:835820d7-09e1-5ef8-ae5d-e027a7d3613e --> Phone drawer: the New thread button's centre sits about 8 px left of the close button above it and about 4 px left of the thread rows' menu buttons. Line the three up.

- [ ] <!-- workspace:id=work:d6f9ccae-85c3-5fbb-8144-9701313e3fcf --> Show each model's measured speed on the installed-model rows in Settings › Models and on the model picker's rows (the data and the small component landed 2026-11-11; nothing renders it yet). The browser spec should then read the number from the row, with a fixture that sets its own token count.
- [ ] <!-- workspace:id=work:b7c16486-811b-5ff4-b102-bbbcae47de41 --> A model's measured speed can stay on a page left open past the 14-day window with no chat in between; it corrects on the next finished reply or reload. Drop it on time without a polling timer (for example when the window is shown again).

- [ ] <!-- workspace:id=work:ac143e6e-95f6-5116-a351-159edf9b6db9 --> Send a non-image file by path (owner decision 2026-11-11): the app keeps a copy of an attached file with the thread, the model is told the file's name and reads it in pieces with its read tool, and the message shows a file chip. Today a non-image file becomes a "not sent" chip that blocks Send.
- [ ] A queued message waiting on a reply in another chat shows no reason in its tray row; say which chat it waits on.
- [ ] Queued messages are kept in the page only, so a reload or restart drops them. Save them with the thread's draft.
- [ ] Dictation that is running when Dictate becomes held (a reply starts) is discarded with no word. Keep the words, or say they were dropped.
- [ ] `Voice.tsx` records when Dictate came back in a `useEffect`, so a click in the same frame can slip past the double-click guard. Use `useLayoutEffect`.

- [ ] Text size: removed from Settings 2026-11-13 because it did not work (owner). Think it through before adding it back: what it scales (chat only, or every screen), how it shows on the phone, and a browser check at each size.
- [ ] <!-- workspace:id=work:f14a8e12-81be-5e22-b536-c6e83c659b45 --> The model picker is placed when it opens and is not placed again when the window is resized while it is open.
- [ ] <!-- workspace:id=work:429d2e26-ea6a-5741-a4f3-a493e0274206 --> No browser spec covers the "this model cannot see images" message for an image picked with "Attach a file", the 8-image limit reached through a drop, or the file chooser at phone width.
- [ ] <!-- workspace:id=work:e2c7100d-e7e6-59b0-87d1-f31241b341db --> Dropping files is proven with synthetic drag events only. Try a real drag from the desktop into the desktop window, and a dropped folder end to end (unit test only today).
- [ ] <!-- workspace:id=work:148c4e5e-87c5-5429-8cf7-709ba730f126 --> Under reduced motion only Dictate's spinner holds still; the shared `.spin` rule still turns in seven other places (update checks, tool rows and status, two banners, the maker mark). Fix the shared rule.
- [ ] <!-- workspace:id=work:981392c1-7213-5ef6-9031-9cd0c746d284 --> While a reply runs, Stop's tooltip says "Enter queues your message" even when a "not sent" chip will block the queue.

Known limit: reloading in the seconds while a send is being accepted can lose
that message. Keep the message recoverable across that reload in a future pass.

- [x] <!-- workspace:id=work:ba9367e2-4e63-5198-81ec-5dbc61eff392 --> Ignore pasted images that finish loading after the draft is replaced.
      *Done 2026-11-09:* “Give each chat its own unsent draft, held outside the application store” checks the source slot's replacement identity.
- [x] <!-- workspace:id=work:6d2c35d9-1890-5227-9084-041c804362af --> Remove a confirmed retry from background replies so it no longer looks active.
      *Done 2026-11-09:* “Hold every running reply in one turn map with one reducer” replaces the source chat's turn in the map.
Follow-up (TC-02): Add a server-side size limit or eligibility check before hover-preloading very large thread histories.

*In progress 2026-11-08:* Clipboard buttons share a fallback, truthful feedback
and focus/selection restoration. Browser coverage is in `test/e2e/copy.spec.ts`;
the real desktop permission-denial case is in `test/e2e/copy-desktop.spec.ts`.

*In progress 2026-11-08:* The composer uses one changing Send/Stop/Update
button, with Queue for a touch draft during a reply. The render probe failed
on the prior commit's two-button states. A reserved status row keeps Stop
reachable while typing or editing. Presses stay bound to their starting action
and reply, with held-key repeats suppressed until release. Browser interactions
are covered in `composer-action.spec.ts` and `composer-press.spec.ts`.

- [x] <!-- workspace:id=work:418c8874-a153-5afd-bc19-9d2504e5ff48 --> Scaffold the pnpm workspace (`apps/desktop`, `apps/server`, `apps/web`,
      `packages/contracts`, `packages/harness`) with `CLAUDE.md`, roadmap,
      changelog and `pnpm verify` (typecheck, lint, unit tests).
      *Accept:* `pnpm verify` exits 0 on a fresh clone and non-zero on a
      planted type error.
- [x] <!-- workspace:id=work:2b0bbe35-2dca-5b7c-96bd-2083d97a26f1 --> Contracts: one WebSocket, typed RPC and push channels, Effect Schema
      decode at both ends.
      *Accept:* a malformed message is refused at the boundary with a named
      error; round-trip tests cover every channel.
      *Done 2026-11-07:* 7fddd5d and 8741597; named decode errors and the wire-mirrors test.
- [x] <!-- workspace:id=work:92903769-ac74-5c41-8bf8-51fcebae0efb --> Thread store: SQLite WAL, completed messages and interrupted replies persisted.
      *Accept:* killing the server mid-stream keeps completed messages and the last saved partial, marked interrupted.
      *Updated 2026-11-09:* “Keep the words of a reply that is stopped, fails or is cut off” writes the first words, then at most once a second.
- [ ] <!-- workspace:id=work:d33c371c-75b7-5e3a-b211-091795aba823 --> Runtime discovery: reuse a healthy Ollama; start an app-owned one when
      none answers; never adopt or stop a service the app did not start.
      *Accept:* `pnpm verify:chat` covers existing, stopped, missing and
      wrong-service-on-port with fakes; one real run finds this machine's
      Ollama.
      *Status 2026-11-07:* built in 4eb5af2 with fakes and one real read-only discovery; no `pnpm verify:chat` script exists yet, so the accept line is open.
- [ ] <!-- workspace:id=work:a5c05b84-f413-5c13-ba03-88fa60c68c0d --> Own-folder Ollama (D1): get a pinned version into the app folder, check
      its hash, run it without root or a package manager.
      *Accept:* with Ollama off PATH, first launch installs and runs it; a bad
      hash refuses with a usable message and leaves nothing half-installed.
      *Status 2026-11-07:* install path built and hash re-read in 4eb5af2; the off-PATH first-launch install has not run for real (1.5 GB download).
- [ ] <!-- workspace:id=work:0bc2794e-815d-528b-b157-120dd656a6a4 --> Model list from the runtime, refreshed on focus; no settings step
      before the first chat.
      *Accept:* a model pulled in a terminal appears in the picker without a
      restart.
- [x] <!-- workspace:id=work:ae4ba4f7-b4a9-5325-b094-80cb7177ef91 --> Electron main supervises the server; a server crash shows a restart
      control, not a blank window.
      *Accept:* killing the server process shows the error state; restart
      brings the thread back.
      *Done 2026-11-07:* 2290627; headless Electron 45 smoke, kill then Restart back at #thread=42.
- [ ] <!-- workspace:id=work:70e50906-9d79-5021-b756-4fbd075cac6d --> First turn: streamed reply with explicit per-request `num_ctx` (16k
      floor) and a fit check against measured free VRAM with whisper running.
      *Accept:* a real streamed reply on this machine at 16k, whisper
      unchanged; when no model fits 16k, a refusal names the shortfall.
      *Status 2026-11-07:* real 16k reply beside whisper through `streamTurn` (e54cafc); the same turn through the desktop app waits on `apps/web`.

- [ ] <!-- workspace:id=work:d1a8d497-afe1-5133-a6c9-a6adb0a9a891 --> Visual direction: round 1 of twelve GPT-image directions (all
      rejected), round 2 as T3 Code-shaped HTML harnesses in black and gray
      with green, scored by the council hill climb in
      `docs/design/council-rubric.md`, then tokens in `apps/web`.
      *Accept:* Ethan names the direction; a tokens file and the restyled
      shell land, checked against the picked mockups.
      *Picker checkpoint 2026-11-08:* the owner approved the fixed T3-style
      maker/list/context layout, memory-needed row metrics and context memory
      bars. The picker uses real inline maker marks, favorites,
      clean labels and a two-step phone picker. Monochrome and usable-memory
      scale are provisional defaults while icon/bar treatments are chosen.
      The broader visual-direction item stays open.

- [ ] <!-- workspace:id=work:4b3b6776-404e-5fdf-b306-f0908c5e2f23 --> Picker: cancel a pending row or size pick when the open thread changes,
      so Ctrl+N during a memory check does not apply it to the new chat.

- [x] <!-- workspace:id=work:47a64e0b-8d3e-5763-8022-def80b846256 --> Packaged renderer Origin: measure what Origin the `file://` renderer's
      WebSocket upgrade carries in a real packaged Electron run and allow it
      in `apps/server/src/main.ts`.
      *Accept:* the packaged app connects; a page from any other origin
      still gets 403.
      *Status 2026-11-07:* measured `Origin: file://` (403) in a real
      unpackaged dist run, so the client moved to its own scheme,
      `gates-local://app` (`apps/desktop/src/client-protocol.ts`). In that run
      the app's upgrade got 101 and `file://`, `null`, `http://evil.example`
      and `gates-local://other` got 403.
      *Completed 2026-11-09:* the real Linux AppImage sends
      `Origin: gates-local://app` and gets 101; all four foreign origins
      still get 403 with a valid token. Run `installer-linux-first-run`;
      first-run screen and packaged update refusal observed. Extraction
      mode with the test sandbox disabled; normal desktop launch remains
      unverified. See `docs/releasing.md`.
      *Windows verified 2026-11-09:* the actual installed NSIS build returned
      bridge `ready`, rendered the missing-runtime first-run screen, sent
      `gates-local://app` with 101 and refused all four foreign origins with
      403. This was a non-interactive SSH run; desktop launch and SmartScreen
      remain unobserved.
- [ ] <!-- workspace:id=work:2150ced9-ffda-51fd-837d-af03704fad1b --> First-run model pick on real models: `chooseModel()` takes the smallest
      installed model, so on this machine the first run recommends
      `nomic-embed-text` (an embedding model, `/api/show` capabilities
      `["embedding"]`) as "the best model for your GPU", and `verdictOf`
      labels its 2048-token context refusal "Not enough memory at 16k".
      *Accept:* an embedding-only model is never picked or offered for chat;
      the pick is the best installed chat model that fits; a context-limit
      refusal names the limit; an E2E with an embedding model installed.
- [ ] <!-- workspace:id=work:9de15378-a1cb-5428-99e8-2debc34026ec --> App-owned models store: `/var/lib/ollama` is read-only to this user,
      so an app-owned Ollama cannot see or pull into the system models.
      Pick `OLLAMA_MODELS` for the owned server and show it in settings.
      *Accept:* with the system Ollama stopped, the owned server pulls a
      model into the app folder and the picker lists it.
- [ ] <!-- workspace:id=work:3eab9e6e-bae9-57c3-bd28-a5a5b278448d --> `AppErrorCode` (turn-active, runtime-not-ready, wont-fit, cancelled,
      shutting-down) moves from `apps/server/src/app.ts` into
      `packages/contracts` so the client switches on a typed code.
- [ ] <!-- workspace:id=work:e5f54fe9-4806-5e9f-b84f-c11253a2ddb3 --> Fit with two loaded models: `/api/ps` reported 5.92 GB where the
      runner held 6926 MiB (e54cafc). Measure the two-model case before the
      fit check trusts `/api/ps` for more than one runner.
- [x] <!-- workspace:id=work:e0b86596-5c8e-5d82-909d-68f5160dd088 --> Fit gate when the GPU is unreadable: refuse a load with the shared reading's reason, also shown on a refused send.
      *Done 2026-11-09:* “One truth about the GPU: a failed reading is not "no GPU"” distinguishes confirmed absence from an unreadable device.
- [ ] <!-- workspace:id=work:8d55a4c7-87fa-5e11-8871-8e74319b3a25 --> Owned Ollama port: 11435 is fixed; take it from an environment knob
      when 11435 is busy with another service.
- [x] <!-- workspace:id=work:6038c5bb-f547-54c0-8048-5106e6b2d528 --> Stopped replies retain text, thinking, tool steps and an interrupted marker after reload.
      *Done 2026-11-09:* “Keep the words of a reply that is stopped, fails or is cut off” routes endings through `runTurn`'s final save in `apps/server/src/app.ts`.
- [x] <!-- workspace:id=work:74ac98c1-70c4-54a8-b7f8-efe9a7fa546e --> Shutdown stops the owned Ollama even when ComfyUI's close stalls past the hard deadline.
      *Done 2026-11-09:* “Recover from a render crash, and quit without leaving anything running” adds the deadline stop in `apps/server/src/shutdown.ts`.
- [ ] <!-- workspace:id=work:cf0d95d4-92c3-5e83-9cb9-e618033d1682 --> Cancel a turn that waits for the GPU: a turn queued behind an image
      job holds no claim yet, and Stop only aborts once the claim lands.
      *Accept:* a test queues a turn behind a held image claim, presses
      Stop, and the turn ends cancelled with the image job untouched.
- [ ] <!-- workspace:id=work:8775fff1-7abd-5633-b650-d73e80993fc9 --> Windows process trees: nobody has watched a real Ollama's
      runner processes end when the app stops it on Windows. The pinned build
      puts each runner in a kill-on-close job object (read in its source at
      the pinned tag), so `child.kill()` should be enough. Do not add
      `taskkill /T` without a measured leak: it follows recorded parent
      process numbers, which Windows does not clear, so it can end an
      unrelated program (review of the Windows pass, 2026-11-11). *Accept:* on a Windows machine with a model loaded, stopping the app-owned
      Ollama leaves no `ollama*.exe` process.
- [ ] <!-- workspace:id=work:559de703-5cf5-5bec-948c-b3ebdfb333ba --> Thinking pill follows the model: add `ModelInfo.capabilities` from
      `/api/show` and grey the pill out for a model without "thinking"
      (the server already drops `think` for those, 24877a4).
      *Accept:* picking gemma3 greys the pill; picking qwen3.5 lights it.
- [ ] <!-- workspace:id=work:c958fcf0-2eab-5488-8b83-32a071fe311e --> Tools default reaches the turn (439a230): an E2E that sets Tools off
      in Settings and sees a turn with no tool definitions in the request.
- [x] <!-- workspace:id=work:920bf6fb-58cb-5846-9c98-f204d89a3fef --> `think` on a model without thinking: run 2026-11-07 on the real
      runtime, HTTP 400 `"gemma3-abliterated:12b-q4" does not support
      thinking` in 18 ms, nothing loaded (evidence log).
- [ ] <!-- workspace:id=work:9b302caf-d3f3-5f92-96d4-e6f6cef20f87 --> A shell over its cap must not look like a low-memory desktop: every
      `gates-shell-*` scope that hits `MemoryMax=512M` ends with result
      oom-kill. Plasma's kded `oom_notifier` then tells the user "the system
      is low on memory" and names the scope. On 2026-11-07, `sandbox.test.ts`
      (the 1 GiB allocation case) fired about 130 of them across the lanes,
      and a real user would get one for each command over the cap. Candidate:
      `OOMPolicy=continue` on the scope plus reading the scope's
      `memory.events` `oom_kill` count before collect, so the model still
      hears "went over its 512 MB cap" when `sh` swallows the 137. The hub
      filters these out for now (workspace-tools `oom_notify.py`, 307359f).
      *Accept:* the cap test passes, the scope's unit result is not oom-kill,
      and a shell `python3 …; echo ok` that goes over the cap still reports the
      cap to the model.
- [x] <!-- workspace:id=work:69296d23-d669-50f8-9b37-432855294a8a --> Source updates for a git clone: `pnpm run app-update` (`--check`,
      `--channel main|release`) and Settings › General › Updates (version,
      manual checks plus desktop automatic checks, "Update and restart" in the
      desktop app, the result on the next start).
      *Accept:* a failed install or build leaves the clone on the commit it
      had, installed and built again; tracked changes and local commits
      refuse with nothing changed; releases follow semver and never go
      backwards; the tests run on temporary repositories only, behind a
      guard that refuses any other folder.
      *Done 2026-11-07:* lane/update; checked on Linux, Windows by reading
      only (changelog). *Hardened 2026-11-08* after review: ignored files
      are never overwritten, one update per clone, a cut-off update is
      finished by the next, a timeout ends the whole process tree. A second
      review round: a live owner is never taken over, a process that could
      not be stopped holds later runs off, a going-back never resets over
      work done during the update, and a part-way checkout is named.
      *Extended 2026-11-08 (code and unit checks only):* desktop checks the
      clone's git remote after 15 seconds, then hourly; the default-on
      automatic-check preference can disable future git processes and
      network requests. No automatic installs. A fixed sidebar slot beside
      Settings offers the update, with shared retry and interruption
      confirmation. Browser/window proof and restart-gap timing await the
      runner. The JavaScript bundle currently exceeds its existing budget.
      *Runtime proof 2026-11-09:* three focused browser tests and eight real
      source-update checks passed through the approved virtual-screen runner
      using throwaway clones/local remotes only. Success, failed-build
      rollback, interrupted text after reopening and manual start were
      exercised. Closed-window gaps: 4.293 s success, 5.782 s rollback with
      cached offline dependencies and fake services. Windows remains unproven.

*Drafts and queue, review follow-ups:*

- [x] <!-- workspace:id=work:2f0d4982-c718-5fe4-bcfa-9631a94a4d7d --> Each chat has an independent draft outside the application store; queued edits keep a backup.
      *Done 2026-11-09:* “Give each chat its own unsent draft, held outside the application store”; `drafts.ts`, `draft-persistence.ts` and `session/chat.ts` implement the rules in `docs/decisions.md`.
- [ ] <!-- workspace:id=work:a1677d16-f15f-5a35-9874-003d0b744e7a --> Draft persistence: a later save in another window replaces the whole saved record in `draft-persistence.ts`.
      *Accept:* edits in two windows recover both chats' latest words after reload, including attachments.
- [ ] <!-- workspace:id=work:619330ac-ce2b-58ea-82fe-aaef1f191d9f --> Draft startup: words typed during the IndexedDB read are not saved until another change, because `watchDraft` subscribes after restoration.
      *Accept:* hold the read, type, release it, then reload without another edit and recover the words.
- [ ] <!-- workspace:id=work:9910392e-7d4f-5cba-8d20-4cc4ca593217 --> Draft recovery: one malformed queued row makes `recoverDraft` reject the record, including its saved chat drafts.
      *Accept:* a bad queue row leaves valid queued rows and draft slots recoverable.
- [ ] <!-- workspace:id=work:6a743bca-bfda-5ee9-97cd-6649910d248c --> Retrying `watchDraft` can replace an unchanged in-memory queue with the saved queue in `draft-persistence.ts`.
      *Accept:* retry persistence with an existing queue and retain its current rows, order and held state.
- [ ] <!-- workspace:id=work:65a5597f-86b6-5c56-9b4e-f676b095e755 --> Edit on a sent message replaces the current draft without a backup in `Thread.tsx`'s `UserBubble`.
      *Accept:* editing and then cancelling or sending preserves the earlier unsent draft.
- [ ] <!-- workspace:id=work:35f11948-721a-5afd-8730-2671bebfd1a9 --> Two overlapping first sends can leave a stray draft in the first created chat (`session/threads.ts`, `session/chat.ts`).
      *Accept:* hold both creates, change the draft between sends, then settle them in either order without a duplicate unsent copy.
- [ ] <!-- workspace:id=work:de7b1aba-7295-5561-807d-d618b11f8554 --> Editing another queued row can overwrite changed words left by a confirmed queued edit; `beginQueuedDraft` retains only the older backup.
      *Accept:* late-confirm an edited row, change its words, then edit a second row and recover both unsent copies.
- [ ] <!-- workspace:id=work:11662a8b-85ac-5fcb-9c6a-80c177a213f1 --> A refused send after its chat is deleted can recreate an orphan draft and a notice pointing to that deleted chat in `session/chat.ts`.
      *Accept:* delete during a held send, refuse it, and offer a reachable recovery location without an orphan slot.
- [ ] <!-- workspace:id=work:555f410f-d8e8-5be6-ad19-9ccc07f5d8d1 --> Changing chats makes `sameAttachments` rewrite the entire attachment payload even when image strings are unchanged.
      *Accept:* repeat chat switches with large image drafts and measure bounded metadata writes without rewriting unchanged images.
- [ ] <!-- workspace:id=work:71dfdff3-43f0-54d6-9e19-9253d76a3663 --> Draft close/reload durability remains best effort: pagehide only requests the active IndexedDB commit and cannot save a pending snapshot synchronously.
      *Accept:* measure abrupt-close recovery; evaluate a synchronous text mirror without copying large attachments into it.
- [ ] <!-- workspace:id=work:91fb9dbf-7ca0-5d18-be0b-47ef2b68f1a3 --> Repeat the prepared-bundle attachment benchmark after the per-chat draft change; the earlier 90 MiB result predates its slot layout.
      *Accept:* retain submitted bytes and recovered text/images for text edits and chat switches using the current bundle.
- [ ] <!-- workspace:id=work:118b8438-49e8-5f79-b8fb-848f9ac88ef7 --> A late confirmation of a queued message being edited ends the edit without giving the draft a new identity (`confirmCopy` in `session/chat.ts`), so a dictation or paste still arriving lands in the now-standalone draft.
      *Accept:* late-confirm an edited queued row while a dictation or paste is held, and the late words are dropped or kept by a recorded rule, with a test.
- [ ] <!-- workspace:id=work:a4f6ff07-e57c-5c71-9c16-1063e2008ae7 --> Erasing the box and retyping identical words while a first send's chat is being created clears the retyped copy when the send settles (`send` in `session/chat.ts`, queued and ready paths).
      *Accept:* hold the create, retype the same words, settle it, and keep the retyped draft.
- [ ] <!-- workspace:id=work:f30c4c8a-8cad-5d2f-ad96-d65c7fa0cda5 --> New thread pressed on the new-chat screen drops an image paste still being read; before per-chat drafts an image read had no such guard.
      *Accept:* decide whether a pending image survives New thread on the same screen; `paste-desktop.spec.ts` fixes only the file-path case.

*Replies, rendering and shutdown, review follow-ups:*

- [x] <!-- workspace:id=work:e3945bec-492b-5b34-baea-50a612c2fed7 --> A render crash offers retry and, after an app retry, window reload while drafts remain outside React.
      *Done 2026-11-09:* “Recover from a render crash, and quit without leaving anything running”; `ErrorBoundary.tsx` and its recovery journey.
- [ ] <!-- workspace:id=work:1124fbb6-fa9b-5562-8779-f5ee5f3623c9 --> Show the first error line in the render-failure notice in `ErrorBoundary.tsx`; currently the detail is available only through Copy error.
      *Accept:* a thrown error's useful first line is visible and the full error still copies.
- [ ] <!-- workspace:id=work:a2ea4a34-6420-5718-a0d3-d4a08b1f8416 --> Reload window in `ErrorBoundary.tsx` calls reload without requesting draft persistence first.
      *Accept:* an app failure after an edit requests the pending save before reload and reports the same durability limits as ordinary reload.
- [ ] <!-- workspace:id=work:885ecfb9-1cdd-508b-a9ba-ecb6606b94bc --> A shutdown deadline between `service.start()` and recording `owned` in `image/module.ts` can leave the app-started ComfyUI running.
      *Accept:* hold post-start inspection, trigger the deadline, and stop only the unit started by this run.
- [ ] <!-- workspace:id=work:6ef1ece0-46a2-5bf1-adee-9cb8e76aec0e --> Measure server stderr behavior when the desktop dies: `main.ts` writes to the parent's pipe without an error listener.
      *Accept:* close that pipe during logging and confirm an EPIPE cannot interrupt owned-runtime cleanup.
- [ ] <!-- workspace:id=work:7c28a0dd-6431-5775-971c-26536cc31d5c --> Prove shutdown with real Ollama runner descendants and real systemctl, plus native Windows process handling; current shutdown tests use throwaway children and service fakes.
      *Accept:* success and deadline paths leave no owned runtime, and external services remain running.
- [ ] <!-- workspace:id=work:edbcd7e6-9a5a-5027-909a-117b503a0db1 --> Other windows retain deleted or retry-replaced messages until history reload; `threadsChanged` refreshes the index and invalidates previews only.
      *Accept:* delete or retry in one window and observe exact current history in another without reconnecting.
- [ ] <!-- workspace:id=work:4df8720c-58e9-55c3-b9e4-2aa9ac841c98 --> Retry removes the earlier partial when the new question is admitted, even if the new reply fails before its first word (`app.ts`, `session/chat.ts`).
      *Accept:* a pre-word retry failure leaves the earlier partial recoverable without duplicating the question.
- [ ] <!-- workspace:id=work:27b69c41-ef51-5019-96ec-c65adf933f1a --> Retry after an image card asks again instead of replacing the unfinished turn because `retriedRows` requires every following row to be interrupted.
      *Accept:* retry with an intervening image card preserves the image and produces the intended single question/reply pair.
- [ ] <!-- workspace:id=work:02577bfa-238b-583c-94bd-82567ef200ff --> A tool reply stopped on its last token is saved interrupted, while a plain reply's completion wins the same race in `app.ts`.
      *Accept:* exercise both endings through the real harness and confirm the chosen completion rule with every word and tool step retained.
- [ ] <!-- workspace:id=work:16f8dbbf-4410-5e33-b411-0670ca2afc72 --> Overlapping thread/message deletes share a set marker; the first owning operation can clear it while another delete is pending in `app.ts`.
      *Accept:* overlap two held deletes and keep new admission refused until both finish.
- [ ] <!-- workspace:id=work:321b3581-f2ce-546d-bf51-ac5d435b3628 --> Rerun `test/e2e/real-smoke.spec.ts` after the interrupted-reply change; its real-model journey was updated but not exercised by that landing.
      *Accept:* a real streamed reply, Stop and server restart retain the completed and interrupted messages as specified.

*Long threads and model fit, review follow-ups:*

- [x] <!-- workspace:id=work:ab0f2f0a-f777-5cd5-b288-87ca6dc420cb --> Open a long thread with its last 40 turns, then mount older turns in idle slices while holding the reader's place.
      *Done 2026-11-09:* “Open long threads at their last turns and keep saved replies out of the store”; typing now runs zero store selectors after the per-chat draft change.
- [x] <!-- workspace:id=work:42f3dee9-3ced-515a-8271-14de5ffc56c6 --> Send retains its pre-load fit verdict until a fresh post-load report arrives.
      *Done 2026-11-09:* “Keep Send steady when a picked model finishes loading”; the formerly intermittent toolbar journey passed 60 repetitions with fakes.
- [x] <!-- workspace:id=work:f58122ba-b60b-50cf-93a6-a8654450b80f --> Whole-thread backfill does more work despite the faster first screen: the recorded 2,000-message comparison rose from 643 to 2,989 ms CPU task time.
      *Done 2026-11-09:* “Mount a long thread's older turns in a third of the time”; one job compared first-screen and `-mounted` rows: whole mount 3,012 to 953 ms CPU task time, first screen unchanged within noise, no row slower.
- [ ] <!-- workspace:id=work:e10ac9e4-a55f-592f-aa2b-39d37d3e76e2 --> Whole-thread mount of a 2,000-turn thread still costs about 950 ms of tasks, above the 643 ms recorded before long threads opened at their last turns; one trace reading puts most of the rest in React rendering turns above the view.
      *Accept:* attribute the remainder in the perf comparison, then compare mounting on demand (scroll, Find) against always mounting before choosing.
- [ ] <!-- workspace:id=work:d2b26db4-2611-5eba-bf16-66baa081190e --> The history-load error line sits one turn's gap below the last turn since turns carry their own gap (it was flush); derived from the rules in `styles.css`, not looked at in a browser.
      *Accept:* view it on wide, narrow and touch screens and either keep the gap or restore the flush position without a rule that reads the previous turn.
- [ ] <!-- workspace:id=work:e5acc555-615d-5f42-8267-a8d279b29ad3 --> Older turns mounted above the view no longer fade in; a turn mounted just above the top edge can be partly visible when it appears.
      *Accept:* scroll up fast into the backfill in a browser and decide whether the missing fade is noticeable.
- [ ] <!-- workspace:id=work:f4058164-fc2d-505b-aeba-850140f41156 --> Startup CSS is 13.022 KiB gzip against its 13 KiB soft target after the per-turn gap rules (12.979 before).
      *Accept:* the build prints no startup CSS warning, by trimming rules or by a recorded decision to move the target.
- [ ] <!-- workspace:id=work:2c2cf019-23eb-5b40-ad63-bc82721ccf01 --> Saved replies that streamed during this visit keep six `useStore` subscriptions for the timeline's lifetime in `LiveReply`.
      *Accept:* finish many replies in one open chat and show that retained subscriptions do not grow per saved reply.
- [ ] <!-- workspace:id=work:a2661a16-a279-5107-88aa-7ec500defce8 --> `markdown.tsx` runs `matchMedia` for every code block/table through `useEdges`.
      *Accept:* a fully mounted long thread shares the viewport check while keeping overflow fades correct on narrow screens.
- [ ] <!-- workspace:id=work:b896849a-9d90-5ca4-ac8a-5374c92450ae --> `AttachmentImages` subscribes separately to origin and token for every user turn with images.
      *Accept:* mounting many image turns does not add two global-store subscriptions per turn, and authenticated images still load.
- [ ] <!-- workspace:id=work:0048d992-d4e2-59fc-9601-419892c6d803 --> Browser Find during idle backfill cannot search turns not yet mounted by `Timeline`.
      *Accept:* finding text in an older held-back turn reveals that turn before reporting no match.
- [ ] <!-- workspace:id=work:13596ca1-006d-51df-8d92-4dcf423973ea --> Verify scroll position when top turns are deleted; current `long-thread.test.ts` checks surviving mounted rows, not the browser's view.
      *Accept:* delete above a scrolled reader and keep the visible turn in place in the browser journey.
- [ ] <!-- workspace:id=work:df5bb3b7-c7f9-5847-83f6-6ad00ec56329 --> Verify `Timeline` anchoring in Firefox/Safari, including its timer fallback when requestIdleCallback is absent.
      *Accept:* bounded first mount, complete backfill and stable scroll position in each supported engine.
- [ ] <!-- workspace:id=work:a912dd15-2545-5781-b854-126e49381517 --> Verify streaming while older turns backfill in the long-thread browser journey; current coverage separates those actions.
      *Accept:* stream during backfill with no lost words, detached reader or broken follow-to-end behavior.
- [ ] <!-- workspace:id=work:7b28fd7b-6671-5fa9-b038-5b9c3ddcc12b --> History can change a live reply's owner from a pending/answer key to its user-message key, remounting it in `Timeline`.
      *Accept:* delay history across a live reply and retain the reply's DOM and disclosure state when history arrives.
- [ ] <!-- workspace:id=work:f7b624dc-e9f9-5c72-a060-a135832be07d --> The stick-to-end ResizeObserver can undo a scroll assigned in an animation-frame callback before the scroll listener clears `stick`.
      *Accept:* scroll from that callback during backfill and keep the requested reader position.
- [ ] <!-- workspace:id=work:c4d16987-5cb6-53ea-8d23-e21803f52bab --> Deleting the user message between two replies can give both the same `reply:` owner key in `Timeline`.
      *Accept:* remove that message and retain both replies with distinct keys and stable content.
- [x] <!-- workspace:id=work:6327fe6f-c001-5916-aa4c-7e9fdd2bad6c --> Image fit rereads free VRAM immediately after unload in `image/module.ts`; delayed reclamation can produce a false refusal.
      *Accept:* hold VRAM reclamation after a successful unload and wait within a bounded read loop before refusing.
      *Completed 2026-11-11:* after the unloads the fit reads the GPU every 250 ms until free memory covers the need or 20 s pass; a cancel ends the wait. Checked against a test GPU reader only.
- [ ] <!-- workspace:id=work:25435160-b10d-5f49-9f80-058db4ba46d0 --> `planLoad` has no explicit-versus-default context provenance, so it cannot safely offer a smaller default while respecting a deliberate context pick.
      *Accept:* a default may step down to a fitting context while an explicit size retains its choice and truthful refusal.
- [ ] <!-- workspace:id=work:df33005b-e223-558e-a587-00377eb43b07 --> Missing model context metadata is published as a 4k maximum by `runtime/models.ts`, so the picker/fit panel calls it the model's actual limit.
      *Accept:* absent metadata is labelled unknown or conservative, and a reported maximum remains authoritative.
- [ ] <!-- workspace:id=work:e942de90-b6a2-5aa3-94b1-266259c70f5e --> `parseGpuTotals` and GPU status use only the first NVIDIA card; a multi-card machine can receive advice for the wrong memory pool.
      *Accept:* two-card fixtures and a real check agree on which card Ollama uses and whose occupants are counted.
- [ ] <!-- workspace:id=work:7560b1d6-d0aa-572f-a938-b25ca0e59a8c --> CPU-only fit does not credit RAM another loaded model would release (`fitWithReadings`, `planLoad`).
      *Accept:* measure available memory with a resident CPU model before adding reclaim credit, avoiding mmap double counting.
- [ ] <!-- workspace:id=work:bc118a3f-f036-50f1-8bf1-91308c6d543b --> Confirmed NVIDIA absence is reread on every check in `readNvidiaSmi`; a broken-driver absence costs two reads and a pause each time.
      *Accept:* a bounded cache avoids repeated confirmation while a recovered device becomes visible promptly.
- [ ] <!-- workspace:id=work:599adb1b-c8e5-5162-9459-0826989fe3c6 --> Verify GPU failure wording and admission on real Windows, AMD and Intel hardware; `gpu-failures.md` describes behavior currently checked with fakes.
      *Accept:* missing executable, unavailable driver and unreadable readings produce the documented status and load decisions.
- [ ] <!-- workspace:id=work:9fce0f69-41da-58d7-b87e-c1e9304beb9c --> Verify the held Send verdict through a real GPU/Ollama model load; `composerFit`'s browser evidence uses the fake runtime.
      *Accept:* no load-time refusal flash, and a genuine refusal after loading still appears.
- [ ] <!-- workspace:id=work:c51519fb-c9cb-5fa5-80e9-5b7d091f2285 --> Model-list refresh silently swallows RPC errors in `session/models.ts`, leaving an old list without an explanation.
      *Accept:* a failed refresh keeps usable cached rows and offers a visible, truthful retry state.

*Phone and Library, review follow-ups:*

- [x] <!-- workspace:id=work:99f6c9b4-78cf-500c-943a-c3cd53362fcd --> Phone permissions come from a required contract row; read-tool path escapes are refused before disk access.
      *Done 2026-11-09:* “Make the phone chat-only, and check a read path before touching the disk”; phone Retry is read-only discovery.
- [ ] <!-- workspace:id=work:95f303cf-ff2b-5754-be60-04c154a75494 --> Reduce phone read responses: `settings.get`, `sources.list` and `gpu.status` still expose full settings, source paths and process details.
      *Accept:* phone-specific projections carry only chat/status fields and desktop reads retain their full shape.
- [ ] <!-- workspace:id=work:66ca88c4-2098-56d3-8b49-1ab815157cdf --> The read tool distinguishes an escaping symlink from a missing path in `packages/harness/src/tools.ts`.
      *Accept:* both refusals reveal no facts about the target outside the Library source.
- [ ] <!-- workspace:id=work:3d81b8a1-79c5-531c-9cce-88fda08d1e69 --> Verify read-tool containment on native Windows, including NUL and alternate-data-stream names; injected platform tests do not exercise the Windows filesystem.
      *Accept:* valid source reads work and hostile names cannot read or contact anything outside the source.
- [ ] <!-- workspace:id=work:61736857-2858-563a-99eb-c4ecf1758782 --> Verify Retry from a real phone against real Ollama; fake and unit checks cannot prove recovery on that connection.
      *Accept:* rediscover a stopped-then-restarted runtime without starting or installing one from the phone.
- [ ] <!-- workspace:id=work:7184b430-e6cf-5c69-9efc-326b33ae6b2f --> Drive the phone's runtime-error sentence in a browser (`FirstRun.tsx`); the instruction to retry on the computer has unit coverage only.
      *Accept:* a refused/error runtime shows the useful computer action and the phone cannot perform a privileged retry.
- [ ] <!-- workspace:id=work:09c3acc4-ad82-5517-beb5-32d601ec0f3a --> Extend the phone tap-through journey to confirmation and menu actions; `phone.spec.ts`'s broad sweep reaches only first-tap writers.
      *Accept:* those paths offer no forbidden mutation, with the exhaustive server method-table test retained.

*Whole first frame, review follow-ups:*

- [ ] <!-- workspace:id=work:0a695dc7-75db-5946-8a75-26f2a58da1a8 --> The Download tab's group placeholder comes back when the context size changes mid-visit, and first run's `waited` flag never clears (`ModelDownloads.tsx`, `FirstRun.tsx`).
      *Accept:* a context change regroups in place with no placeholder, and a second wait in one visit is bounded again.
- [x] <!-- workspace:id=work:1c4aa5fa-e686-5042-865d-222669e5e248 --> First run goes from "Ready to chat" to "Checking memory" and back when something outside the app moves GPU memory.
      *Done 2026-11-11:* "One memory answer for every screen"; the server's next fit table replaces the verdict in place.
- [ ] <!-- workspace:id=work:c4453c4f-2bef-50b9-a034-74d567ecdce9 --> Decide whether a Recommended row that now spills into system memory stays under Recommended; today only "does not fit" moves it out.
      *Accept:* one rule, written in `docs/design.md`, and a test for the spilling case.
- [ ] <!-- workspace:id=work:fc39d851-10b1-5cc4-a49f-9e580f32a5c2 --> The "uses system memory" group title drops its suffix while a recheck runs (`ModelDownloads.tsx`).
      *Accept:* the title keeps its last words until the new verdict is in.
- [ ] <!-- workspace:id=work:516a18cf-d146-532f-9076-42131a5c09b1 --> "Connecting…" has no way forward when the server never answers: no Retry and no "still connecting" line (`FirstRun.tsx`, `Banner.tsx`).
      *Accept:* after a stated bound the screen offers one action or names what to check, and says nothing untrue before it.

*Chat window trim, review follow-ups:*

- [x] <!-- workspace:id=work:2f2898c8-a1d5-5fe8-a0b0-fa79e8a129a3 --> A Stop hides a real failure that arrives after it: stop, leave the chat, and a later `model-not-found` leaves no note and no message anywhere (`session/turn.ts`, `settle` in `session/chat.ts`); the `settle` guard has no test.
      *Done 2026-11-11:* "Stop follow-ups, and browser tests that wait for the app's data"; only an abort counts as the Stop, the later failure is said once under the reply; the guard's test goes red without it.
- [x] <!-- workspace:id=work:426a78ac-aafe-5fcc-9fc1-ec23c705527d --> A first answer word that arrives between Stop and the server's cancel sets `textAt`: the saved pill's seconds differ from the live pill's and the square can gain seconds too (`session/chat.ts`; by reading, not reproduced).
      *Done 2026-11-11:* "Stop follow-ups, and browser tests that wait for the app's data"; words after Stop are dropped.
- [x] <!-- workspace:id=work:63e1916b-623f-5c9a-b313-8f1fe368237a --> A tool step the person stopped reads "stopped" live and is saved and shown as "failed" (`Thread.tsx`, `app.ts`, `keepStoppedWords`).
      *Done 2026-11-11:* "Stop follow-ups, and browser tests that wait for the app's data"; saved as `"error"` with `stopped: true`, shown as stopped.
- [ ] <!-- workspace:id=work:25fd9761-b8ac-5db9-b616-a53122419763 --> On desktop, clicking the pencil on a queued message while a reply runs shifts Dictate and the model button 38 px; they shift back when the reply ends.
      *Accept:* the owner picks where Stop sits while a queued message is edited (holding an empty slot from the moment a message is queued was tried on 2026-11-11 and taken out: it moved the same shift to every queued message); nothing in the row moves on the pencil click or on Enter, and a browser check reads equal left edges at both moments.
- [ ] <!-- workspace:id=work:bb688358-2d42-5866-9c6c-1deaca30c0fc --> A stopped reply that is only an image shows no stop square.
      *Accept:* the square leads that row too, with the same tooltip.
- [ ] <!-- workspace:id=work:0a7960eb-4f24-5510-9751-35814ba811a3 --> Model picker: the cut point of a long name moves when "Checking…" becomes a size; the disk size and the tag are shown nowhere (`Picker.tsx`). The keyboard tip that stayed open after typing was fixed on 2026-11-11.
      *Accept:* the name's room is fixed before the size arrives, and the tag and disk size have one place.
- [ ] <!-- workspace:id=work:328ba710-331e-5b4d-8477-7312d1035483 --> Tests held too thinly: `screen-overlay.test.ts` no longer states that Search opened, and Usage at a narrow width is uncovered. (The cut-name tip's unit test and the Usage cells' tips were done on 2026-11-11.)
      *Accept:* a unit test per rule that fails when the rule is removed.

*Library databases list, review follow-ups:*

- [ ] <!-- workspace:id=work:76e38a5f-5619-58c1-853a-9dba7ed24e02 --> A starter question can be dropped with nothing said: the chosen model's abilities are still unknown, another question is being asked, or a paste is in flight; `send` returns and the new chat shows only the person's own draft (`session/chat.ts`, `starter.ts`). A question the server refuses leaves its text only on the Settings button.
      *Accept:* every path that does not send a question says why in the new chat, and a unit test per path fails when the notice is removed.
- [ ] <!-- workspace:id=work:39839908-2e57-5e02-8137-baab8bee0690 --> A double click meant to cancel a download can cancel and then start it again when the poll answers between the two presses (`LibraryImports.tsx`).
      *Accept:* the second press of a double click does nothing on either branch; a unit test holds it.
- [ ] <!-- workspace:id=work:d032552b-f3cb-5bdb-a9e0-53ebacc81c00 --> A question asked while a reply runs: the stop warning sits over the person's own draft, "Stop and send" sends the question, and typing drops it silently. While a question's chat is being created, the person's own Send does nothing (`Composer.tsx`, `session/threads.ts`).
      *Accept:* the warning names the question it will send, and a Send pressed during the create goes out or says why not.
- [ ] <!-- workspace:id=work:627ef5a9-fee3-5006-977b-3458de0e296e --> Library rows, states that read wrong: a downloaded sample in `error` says "Download it to ask these."; the phone offers questions when the computer has tools off; a table count that throws loses the whole list and Refresh does not bring it back; old counts stay beside a failed refresh; KB and MiB on one page; Remove is one click.
      *Accept:* each state says one true thing, and Remove asks once.
- [ ] <!-- workspace:id=work:b1566abd-edda-5cd3-b114-2117e13808f9 --> Library tests held too thinly: a failed create on the queued question path; the licence test passes with one sample's licence changed (any "MIT" in the file matches); the over-100 % clamp and the chat-model check survive mutation; the browser journey's wait for a part-filled button has about 1.6 s to land on a slow machine and never measures the row during the check.
      *Accept:* each named mutant fails a test, and the journey's wait states a condition that does not depend on the machine's speed.
- [ ] <!-- workspace:id=work:86a8c045-ad11-5aa2-b0d4-e781d58f1f52 --> Library words and samples, the owner's call: "Sample ·" starts four rows; "Add a database" sits beside "Add database…"; a question sends at once (the other option fills the message box); tell the model each sample's quirks (World Cup dates are days since 1970; Northwind's 1997 views have no 1997 orders); two larger samples.
      *Accept:* the owner picks, and the row says each thing once.

*One fit table, review follow-ups:*

- [ ] <!-- workspace:id=work:31927474-23ee-57f0-920f-8d1050a26245 --> A GPU reading that keeps failing reads as still checking: first run says "Checking memory" with a running dot for as long as it fails, every picker row stays busy and cannot be picked, and only the picker's footer names the cause. A failed build, or one model's reading failing, shows "–" with no reason and no retry (`fit-table.ts` `answers`, `fit/table.ts`).
      *Accept:* after a stated bound each screen says once that memory could not be read and why, offers a retry, and a later table replaces it in place.
- [ ] <!-- workspace:id=work:135756d8-8fa1-546d-b411-607551116537 --> A table that never comes: a rebuild that never finishes leaves the old table shown; a row the table lacks is never asked for again (the old client retried with backoff); "Start chatting" is enabled while first run is still checking; `recommendedEntry` changes its offer when the table lands after the one-second bound.
      *Accept:* each wait has a bound and one true thing to say after it; an offer already shown does not change under the pointer.
- [ ] <!-- workspace:id=work:b4b6f3f1-23a6-5212-8009-b0440f2d4cf8 --> The dropped build checks "a load is open now", not "a load opened while this build read", and the loader's `prune` can empty the set early when a model is reloaded at another context (`fit/table.ts`, `runtime/load.ts`).
      *Accept:* a build that overlapped any load is dropped, held by a test that opens and closes a load inside one build.
- [ ] <!-- workspace:id=work:4b5be8b8-6f22-5592-907f-4bcf27703bd2 --> Not wired as table triggers: a settings change, and ComfyUI going busy or idle without a 64 MiB move of GPU memory. The one line that refreshes the catalog when a download finishes (`services.ts`) has no test.
      *Accept:* each trigger rebuilds the table once, and removing the download line fails a test.
- [ ] <!-- workspace:id=work:b13d1697-e79d-52df-ae7d-c5b2947ee2a1 --> A negative measured offset is carried to much larger contexts with no second real measurement behind it; unsafe if real growth from 16k to 64k is a third steeper than the estimate (`fit/fit.ts`).
      *Accept:* a carried offset is bounded by context distance, or a second measurement is taken before it is trusted.
- [ ] <!-- workspace:id=work:3c11e60d-0935-5916-b1ac-5f8aacb08e14 --> The perf counter `session-fit-checks` now counts hydration's one `fit.table`, so it does not compare with older baselines; old helper names remain in `docs/design/shell.html` and `docs/perf-method.md`; the dead `.pk-cost.skel` halves sit in about 15 selectors.
      *Accept:* the counter is renamed or rebaselined, and the dead names and selectors are gone.
- [ ] <!-- workspace:id=work:381cb334-9c6b-52f3-9713-b285120cb91c --> Fit answers, the owner's call: a memory change replaces a verdict in place (built); the other options are to withdraw it on every change, or only when no new table has come after a few seconds. A pick made before the first table does nothing; it could be held and applied when the table lands.
      *Accept:* the owner picks; `docs/design.md` states the rule.

*Main reds, follow-ups:*

- [ ] <!-- workspace:id=work:b797504b-f046-53db-b7e2-048b8260b92b --> `test/e2e/real-smoke.spec.ts` still waits for `.stop-note` after a person's Stop, which the chat window trim replaced with the stop square and its seconds. It needs a real Ollama, so no landing run shows it red.
      *Accept:* the journey expects the stop square's seconds as `streaming.spec.ts` does, and is run once against a real model with the owner's go.
- [ ] <!-- workspace:id=work:f70791ab-8948-5db4-9d57-45e64ef558b2 --> The three load-only waits (`runtime-wrong.spec.ts` twice, `sidebar-footer.spec.ts` at 320 px) were seen green on a quiet machine only; the app-copy `runtime-wrong` wait was never seen red. Before the runtime is read the footer gear opens Settings at General: a person who clicks that early lands on a different section than a moment later.
      *Accept:* three full suites in a row pass these tests under four shards, and the gear either waits for the runtime or opens the same section before and after.
- [ ] <!-- workspace:id=work:2642d7c2-779f-5e7a-ba98-f487cee0c551 --> One chunk rule decides which screens preload the picker's files, held by `chunks.spec.ts` in a browser only; a new import from `Picker.tsx` in a Settings file puts the picker back into Settings' preload with no unit check.
      *Accept:* a build check fails when the Settings chunk's preload list names the picker chunk or its CSS.

*Image setups (batch 3), review follow-ups:*

- [ ] <!-- workspace:id=work:f0448ec5-60b7-5cde-abdf-a3074eca7330 --> `SaveImageAdvanced` and the other dynamic-combo widgets are refused (14 of ComfyUI's templates, among them plain Z-Image).
      *Accept:* a dynamic combo is read from `/object_info`, and `image_z_image` converts and fills.
- [ ] <!-- workspace:id=work:0be787cf-d31d-5d32-a131-8aa42b7098ef --> The converter's expected graphs are hand-written; none was compared with ComfyUI's own "Export (API)".
      *Accept:* the Klein, SDXL and Z-Image fixtures each match a graph exported from a real ComfyUI.
- [ ] <!-- workspace:id=work:16582237-693e-56c3-a76c-241912f0bb6f --> The default ignores fit: a 6 GiB card with Klein installed defaults to Klein, which every send refuses.
      *Accept:* the default is the best setup that fits this machine's free memory.
- [ ] <!-- workspace:id=work:db9ff7d6-f6c4-56dd-83f2-a7cdab53bcf1 --> Setup memory estimates are padded guesses (Klein 10 GiB, SDXL 9 GiB) while the overnight GPU matrix ran Klein under an 8 GiB cap and SDXL Lightning at 4 GiB with offload.
      *Accept:* each estimate comes from the matrix, and cards with 6 to 10 GiB free get a setup.
- [ ] <!-- workspace:id=work:aec90311-7093-5141-8b0f-fef677d0950d --> No setup for cards under 8 GiB: Klein needs the FP4 text encoder there, and the app has no SD 1.5 fallback.
      *Accept:* a 4 GiB and a 6 GiB fake card each get a runnable default.
- [ ] <!-- workspace:id=work:0090fa59-7645-50b8-82e0-8a5089cda0f2 --> MOSS-Image (Apache-2.0) is the only new model whose licence allows it as a default; it is not offered.
      *Accept:* the owner picks in the GPU-matrix gallery, and the pick is a setup.
- [ ] <!-- workspace:id=work:cf59726c-1d1e-5e17-83e6-a0dcb56d5316 --> A final file that already exists is downloaded again, and any ComfyUI folder kind is accepted as a download directory (IR3-05).
      *Accept:* an existing file with the right size and sha is skipped, and only model folder kinds are allowed.
- [ ] <!-- workspace:id=work:ab35b87d-deb9-56c0-ad6c-d89d55054cfe --> The size control changes every node whose width and height equal the latent's, including a deliberate fixed upscale (IR3-10).
      *Accept:* only nodes fed by the latent's size, or the latent itself, change.
- [ ] <!-- workspace:id=work:80df94ad-aee3-59b4-ade2-0f7c29dff427 --> A Klein all-in-one file in `checkpoints/` says "no Klein setup" instead of where it belongs; few-step models are found by file name only.
      *Accept:* the reason names `diffusion_models`, and a merged Lightning file with a plain name gets few-step settings from its header or is marked unknown.
- [ ] <!-- workspace:id=work:d2bf7cae-4d37-5487-b65a-a269e930b9c7 --> Free space is checked before a range mismatch resets the download to zero, so a full disk fails mid-file with a raw error (IR3-45).
      *Accept:* the check runs after the reset, and a full disk gives a sentence.
- [ ] <!-- workspace:id=work:6cd5f667-747e-5fdb-8717-83c502a738d6 --> A first download with no recorded sha is pinned as whatever arrived; Hugging Face's `x-linked-etag` is the sha256 for large files (IR3-46).
      *Accept:* a first download is checked against `x-linked-etag` when it is a sha256.
- [ ] <!-- workspace:id=work:e2473e59-0f5a-5e5c-818f-ea84f76cecb8 --> Listing setups from files on disk while ComfyUI is stopped and was never read is not done; only the last read list is kept.
      *Accept:* with ComfyUI stopped and never read, the picker lists setups whose files are in the model folders.
- [ ] <!-- workspace:id=work:1018bb42-a7af-5ac7-8ff3-7fe0ba1c8eb1 --> A download that ends with a checksum warning shows nothing on its row; the "Start ComfyUI" press has no browser test with a managed fake.
      *Accept:* the warning shows on the row, and a journey starts a fake managed service from the empty picker.
- [ ] <!-- workspace:id=work:b3b368c9-d82f-5b76-a183-203f9f28258e --> A thread whose first default picture fails or is stopped has no image model of its own, so it follows the latest pick from any thread until its first picture finishes (IR3-61; pinning at send stuck such threads on files that were not installed, IR3-80). Picking the default exactly while it renders is replaced by what it settles to (IR3-82).
      *Accept:* a pending default is told apart from a pick, a failed first default keeps the thread on its own choice, and a later send still settles.
- [ ] <!-- workspace:id=work:32b63544-ea5c-5943-9ddd-ae18e06d4f6c --> A default cancelled or failed before it settled keeps unsettled Klein on its card; once another thread picks, its Retry runs Klein as sent and fails for missing files the person never chose (IR3-90). One test passes through the last-picture fallback instead of the fill (IR3-92).
      *Accept:* Retry of such a card settles again, and the fill has a test of its own.
- [ ] <!-- workspace:id=work:715ac08c-0134-58a7-94c5-2182460dbb3c --> `listThreads` runs a correlated subquery for every thread with no image choice of its own: 27 ms against 0.3 ms at 300 threads of 400 messages (IR3-64).
      *Accept:* a one-off fill of old threads' choice from their last picture, and the subquery gone.
- [ ] <!-- workspace:id=work:0e939612-9434-5885-9f0a-d571f4eb64c3 --> The picker's group order is a copy of the server's list; a renamed group sorts last without a word. A LoRA is its own row, not a switch on its base.
      *Accept:* one shared order constant; one row per base with its LoRAs to switch on.
- [ ] <!-- workspace:id=work:fb6e20f5-5b13-5feb-b698-4a02201a9782 --> Three picker behaviours are guarded by browser journeys only (stale download after a reconnect, the placeholder cleared after a refusal, a phone pick that skips Settings has a unit test now); the `stopped:false` path of Stop has none.
      *Accept:* each has a unit test seen red against its mutant.

*Image batch 2, review follow-ups:*

- [ ] <!-- workspace:id=work:d745eb0d-63dd-564b-bb41-1cdeb24b3e6e --> The image picker and the server still differ in four cases, none new: ComfyUI on a port other than 8188 (the picker credits only a python process on 8188, the server credits ComfyUI's own memory at any address); a remote ComfyUI (the server skips the fit, the picker marks against the local GPU); how much an unload frees (the picker estimates from a `size_vram` split, the server measures after); and Ollama not ready (the picker can say it stops the chat model while the server can unload nothing).
      *Accept:* the picker's mark comes from a verdict the server computed, or each case has a test that gets the same answer from both.
- [ ] <!-- workspace:id=work:a009aa60-86fd-545f-8942-54d94a11c16b --> A reply whose first output is a tool call counts its model as used only at the first text or thinking token (`app.ts`, the loader's first-token call). The one-line change is wrong: the tool turn sends a "note" step before the model answers when the context is too small for tools.
      *Accept:* a model's first real tool call marks it used, the note step does not, and a loader test holds both.
- [ ] <!-- workspace:id=work:02e96676-2709-5b18-bad5-ea96e8f86425 --> Image model rows no longer say when a model is too big at every size; only the size column does, after a hover or a pick. A pick of a too-big size is allowed and Send gets the refusal.
      *Accept:* a model with no size that fits is marked on its own row, once.
- [ ] <!-- workspace:id=work:7cdee6d2-8b2a-5639-86e9-0566078371ba --> Amber means "stops the chat model first" in the image picker and "spills into system memory" in the chat picker.
      *Accept:* one colour means one thing across both pickers, or the owner rules that the tooltip is enough.
- [ ] <!-- workspace:id=work:515f46cf-b615-5f70-aff3-a6c8eb568c87 --> The image fit has no safety margin on either side now, and the setups' needs are padded guesses, not measurements (the real-GPU runs are a roadmap item above).
      *Accept:* each setup's need is measured, and the fit carries a margin only if a measured run shows one is needed.
- [ ] <!-- workspace:id=work:493df8d6-4717-5e53-bba8-5373cd2a6563 --> `real-check.ts --warm` (a warm model, one turn, then the image) was written and has never been run; it needs the owner's go for a run on a real GPU.
      *Accept:* one run on a 16 GB card, its output kept with the swap run's.
- [ ] <!-- workspace:id=work:dc7886d1-0005-55f7-82f4-258e268217d3 --> Two image-look journeys were never seen failing for their own reason: the thread-switch width test failed in setup on the old main, and the Image-on composer row test is a guard. Neither sees what moves when Image itself is pressed.
      *Accept:* each is seen red against a named mutant, and a journey measures the row before and after the Image press.
- [ ] <!-- workspace:id=work:ce0b5803-6fba-50f4-a550-050af132a579 --> The composer's model button, the owner's call: with the name whole, the mic moves about 17 px when Image is turned on or off (built). The other options are a pinned width that cuts the name, or the short name alone on the button with the size left to the picker. Also his: the phone's Make images row says "On" with a grey dot when images are not offered, with the reason beside it.
      *Accept:* the owner picks; nothing under the pointer moves on the press.

*Work chip, review follow-ups:*

- [x] <!-- workspace:id=work:d686ec35-610b-5fa8-b37a-de1789e93542 --> A tool call cut short by Stop shows "stopped" while the reply is live and is saved as failed, so after a reload its chip is red.
      *Done 2026-11-11:* "Stop follow-ups, and browser tests that wait for the app's data"; one fix with the trim follow-up above.
- [ ] <!-- workspace:id=work:cc76f951-d121-550c-9cfe-2adc58fabbcd --> A reload loses the order of thinking and calls inside the chip and the thinking seconds, because neither is saved with the message.
      *Accept:* the saved message carries the times; a reloaded reply opens to the same list and the same number.
- [ ] <!-- workspace:id=work:5e30a5dc-d7fb-53f6-a7b2-1372ab0384d2 --> A finished image step counts as a call in the chip; before the chip it was hidden once the image card showed.
      *Accept:* decide whether an image is a call in the count, and say it once.
- [ ] <!-- workspace:id=work:a3401491-dd13-54bc-b25e-fefa10f035b1 --> A reply this window joined part-way shows no thinking time at all, although the server knows when the turn began.
      *Accept:* the replayed start carries the thinking time so far, or the chip says the time is unknown in its tip.
- [ ] <!-- workspace:id=work:948a47ed-3fce-57f8-ae44-185d5dfa0ab4 --> The line beside an opened call's `$` hides `source`, `limit`, `offset` and `timeoutMs`.
      *Accept:* the opened call shows every argument the model sent.
- [ ] <!-- workspace:id=work:8c16196b-90a8-5d77-b7ca-bff62c209798 --> A round of thinking that finishes while it is being read closes under the reader.
      *Accept:* something the reader opened stays open until they close it.
- [ ] <!-- workspace:id=work:004760a1-fe17-569b-9fc9-d6300d45fe6c --> The chip and the thought line are under 44 px tall on touch, and a call's scrolling box is a focusable element inside a button role.
      *Accept:* 44 px touch targets, and the box is reachable by keyboard without a control nested in a control.
- [ ] <!-- workspace:id=work:0dc7d255-833e-5ccb-86cd-a6c69e342385 --> The chip's count, its closed default and the 360 px rule are held by browser journeys only, and the stopped case with different numbers on the bulb and the square (2 and 18) is held by a unit test only, never seen in a browser.
      *Accept:* a unit test for the count and default, and one journey with a long call before Stop.
- [ ] <!-- workspace:id=work:7d7a0fb4-8099-51bd-a145-a2b931b6130c --> After a toggle the page follows the end only from within 2 px in a finished reply but from 120 px in a reply still being written. The second rule is reasoned, not measured.
      *Accept:* a journey opens a chip in a live reply 100 px from the end and shows what the reader sees.
- [x] <!-- workspace:id=work:efbf4018-f971-5e1a-b85a-11f500f40dda --> `waitReady` in the browser fixtures returns while the app is still booting, since the composer is no longer blocked then. Specs that read state once right after it race under load; two were patched one line at a time.
      *Done 2026-11-11:* "Stop follow-ups, and browser tests that wait for the app's data"; `#app[data-ready]`; the lane's full suite after: 551 ran, 1 failed (a clipboard read, listed below).
- [ ] <!-- workspace:id=work:d12d9455-b436-59b5-9ad5-d86cc83ba737 --> The owner's calls on the chip: the stop square keeps its seconds whenever the reply has calls (built); a reply that thinks and calls nothing keeps the old thought line, not a bulb-only chip (built).
      *Accept:* the owner picks, or leaves both as built.

*Thread fill, follow-ups:*

- [x] <!-- workspace:id=work:180d1664-abdf-5468-84b9-816cc3c56a56 --> A 2,000-turn thread takes over a second to finish mounting after it opens (cold click 1083 ms on the perf night of 2026-11-11; the owner: anything over 1000 ms is a problem).
      *Done 2026-11-11:* "A 2,000-turn thread finishes mounting in about half the time"; all four mounted readings under 1000 ms in a same-run compare.
- [ ] <!-- workspace:id=work:ecb32772-69cd-550b-b556-e4f4a3f445c3 --> The 120-turn idle slice was measured on one machine at full speed. On a much slower one a slice could take long enough to be felt while the reader types or scrolls during the fill.
      *Accept:* the fill's longest gap between frames and typing during the fill, measured with the CPU slowed four times, for 40 and 120; the slice size follows the reading.
- [ ] <!-- workspace:id=work:f35a34b1-23cf-51c9-9f27-11adc14eecbf --> The first idle callback can mount a second, 120-turn slice before the frame that shows the thread when the browser gives it more than 20 ms.
      *Accept:* a reading of the readable time on a machine that gives long idle deadlines, or the first callback stops after its first slice.
- [ ] <!-- workspace:id=work:b20cbda0-157a-5a5f-8f2e-4b5284aa54e9 --> The fill's timer path (browsers without idle callbacks) has no browser run.
      *Accept:* the long-thread journey passes with `requestIdleCallback` removed, or the path is dropped for the browsers the app ships in.

*Windows pass, follow-ups:*

- [ ] <!-- workspace:id=work:6583b646-957d-5858-baaf-1507d0a36b30 --> Four tests in `apps/server/src/runtime/runtime.test.ts` fail on native Windows. Three expect an `ollama` found on PATH to be used, which the Windows runtime never does, so they cannot pass there. The fourth starts the app's copy and stops it; it passed alone in 8.4 s but times out at the 5 s limit in a whole-file run.
      *Accept:* the three are skipped on Windows with the reason or given a Windows expectation, and the fourth has a limit that fits or its slow step is named and fixed; the file is green on native Windows.
- [ ] <!-- workspace:id=work:c6c1c7fa-e5ce-56c3-87b2-a6b043710bab --> A first-time person's run on Windows has not been observed with a real runtime: install, the first-run screen, the app installing its own Ollama, a model pull and a first chat, on a machine with a discrete GPU.
      *Accept:* one such run recorded in `docs/releasing.md`, with what the person saw at each step, the SmartScreen warning included.
- [ ] <!-- workspace:id=work:bb8d45d4-fad9-50a9-835b-6ed3c478940d --> A normal launch of the AppImage (mounted through FUSE) has not been observed on the Linux test machine, which has no FUSE 2 library; the packaged checks run it another way.
      *Accept:* one double-click or plain command-line launch recorded on a machine with FUSE 2.
- [ ] <!-- workspace:id=work:1b35f6d5-6547-5d51-bf5b-46a164b89c94 --> The plain-build update check cannot check the release page link while nothing is published, so that check was taken out.
      *Accept:* after the first release, the plain-build check requires the link to be the real release page.

*Installed update, follow-ups:*

- [ ] <!-- workspace:id=work:c7b8d073-9353-562b-a7e8-c6cd907ffd27 --> A token launch that the watcher kills when it stops the update before the swap (a group kill, so the AppImage runtime never cleans up) leaves its extraction, about 130 MB, in the temporary folder. Nothing sweeps it later: the sweep removes only empty folders.
      *Accept:* a packaged run that stops a token launch at that point, then shows the extraction removed by the stop or by the next start.
- [ ] <!-- workspace:id=work:63eba894-da8d-5dc3-b33e-1f2fa109ac35 --> A result can be shown twice: the watcher dies after the new version is accepted but before it writes the cleanup step; the person dismisses the result in the new version, which deletes the record; the next launch resumes the watcher, finds no result and writes it again, and the start after shows it again as new.
      *Accept:* a routing test that kills the watcher at that point, dismisses, and expects no second showing.
- [ ] <!-- workspace:id=work:1b9406ba-efee-5fc8-b594-eb38acc7cc79 --> A dismiss from the phone can race `tokenWait`: if the person dismisses the result on the phone before the token launch's 500 ms poll sees it, the launch finds no result carrying its token and says the watcher died, though the update finished.
      *Accept:* a routing test that dismisses at that moment and expects the launch to open, with the fix that makes it pass.
- [ ] <!-- workspace:id=work:ac372022-b5ab-5bbe-8659-7dc43445d95a --> A renamed program file or a lowercase `.appimage` is not itself replaceable: such a launch reads the update and defers to the copy the transaction names, and never offers Restart to update.
      *Accept:* the owner decides whether these copies update themselves; if yes, a packaged run that updates a renamed file.
- [ ] <!-- workspace:id=work:49a34201-96ed-560d-a83b-eb29a54077db --> In the earlier-failure state, Settings still shows "Open the release page" under the dismiss sentence. The web hides it today only by its own rule, so it would have to match words to hide it here.
      *Accept:* the server sends an explicit field for the release page link, the web reads it, and the row shows the sentence alone.
- [ ] <!-- workspace:id=work:400a8bcc-3704-5d8e-a185-f1ff65146b15 --> Reading the transaction at start throws on any error other than a missing file (a permission error, for one), which crashes the launch before any window.
      *Accept:* a routing test with an unreadable-by-permission transaction file that expects a page naming the file, not a crash.
- [ ] <!-- workspace:id=work:0400c398-7c7a-5784-90bd-08bcbaadb8bc --> A version that was just gone back from is downloaded and offered again at the next check.
      *Accept:* the owner picks A (hold that version until a newer one), B (offer it again with a note) or C (offer it again as now); A is the default if no pick comes, with a unit test for the hold.
- [ ] <!-- workspace:id=work:46e430a7-ea5f-53f5-8fea-76f62253efa9 --> `apps/server/src/update/run.test.ts:187`, the Ctrl+C test, failed once on timing and passed on rerun.
      *Accept:* the cause named from a red run, or 50 runs under load green.
- [ ] <!-- workspace:id=work:9c537b71-9c6c-555d-ad07-dfa3d5f71ce7 --> The packaged probe's dist folder keeps rigs from earlier runs, so a result folder can show old `-try2` rigs that did not happen in that run.
      *Accept:* each run starts with an empty rigs folder or names its own, and a result folder lists only its run's rigs.
- [ ] <!-- workspace:id=work:edcfc193-c426-5d2b-acef-b61f7dec20f6 --> The reboot path of W1 (the computer restarted after the approval) runs only in unit tests.
      *Accept:* one packaged or VM run that restarts between the approval and the replace, and shows the "did not start in time" note.
- [ ] <!-- workspace:id=work:f59e73fb-9283-527c-b190-79923dc64c95 --> A cleanup record that names another data folder (the folder moved or restored elsewhere) now lets the app start, but Restart to update then fails with "Could not validate the update with the app server", and the record and download are never removed. A record from a copy that is gone, read only by copies that cannot replace themselves, also stays until a copy in that data folder updates.
      *Accept:* such a record is finished or set aside by the next update, with a test, and Restart to update works.
- [ ] <!-- workspace:id=work:eae59795-6d08-5153-b2f3-6c8e6352b6ba --> A copy started while another copy's update is mid-way (before cleanup) says to start that copy, and names its old path; if that file was deleted, the only way in is deleting `updates/installed-update.json` by hand, and no page says so. A routed copy also checks for another copy before the update lock, so while copy A updates, copy B says "start that copy" instead of "updating".
      *Accept:* the page names the file to move back or the record to set aside, and the routed launch reads the lock first.

*Stop follow-ups, review follow-ups:*

- [ ] <!-- workspace:id=work:60838ab3-b463-5a24-8fd5-e6d32db812b0 --> `test/e2e/paste-desktop.spec.ts` reads the clipboard right after the native Copy without waiting: red once in a full suite, 15 of 15 alone.
      *Accept:* the read is polled, and the spec is green in three full suites.
- [ ] <!-- workspace:id=work:7bf0f0fa-c356-5f6c-93ef-ece6c0a692d3 --> `apps/server/test/app.test.ts` (Retry) failed once in a full verify and passed 3 of 3 alone.
      *Accept:* what it races is named and fixed, or the test is shown not to guard anything and removed.
- [ ] <!-- workspace:id=work:cf50e6fa-95e5-5a0d-bce7-6fcbc8d96df4 --> A turn ended by another load that needed the GPU marks its running call stopped through the same path as a runtime switch, but no test drives that case itself.
      *Accept:* one server test preempts a turn with a running call and reads the saved step.
- [ ] <!-- workspace:id=work:5ed487ed-ecf9-5321-9712-dc662fd276c8 --> A tool that fails on its own in the same instant a turn is halted is saved as stopped, since the halt drops the failure event (by reading, not reproduced; the same before this batch).
      *Accept:* reproduced in a test, then the failure wins; or shown unreachable.
- [ ] <!-- workspace:id=work:21127a45-c8f2-5850-a920-8d9072a2cdb1 --> After a Stop the server's saved reply can hold words that were dropped on screen, so a reload shows a few more words than the person saw (older than this batch).
      *Accept:* the saved reply ends where the screen did, or the difference is measured and accepted.
- [ ] <!-- workspace:id=work:63010974-f6f0-5a94-8bd5-c84eed47a226 --> A saved stopped step keeps its summary in the "-ing" form ("Searching your library · stopped").
      *Accept:* the owner picks the words for a call that was cut.

## Next: slices 2 to 4

- [ ] <!-- workspace:id=work:f1f9169a-4f22-5deb-93c4-018289b0be13 --> GPU lease: one app-owned heavy job at a time; chat, image, bench and
      dream each ask for one.
      *Accept:* `pnpm verify:gpu`: a second job waits; cancel and a crashed
      job both release the lease; whisper absent from the call log.
- [ ] <!-- workspace:id=work:aaf84c1c-752b-57ce-8fb6-e47a57c73a0d --> Fit and spill: measure free VRAM, then show RAM spill per model at
      16k, 32k and 64k in the picker.
      *Accept:* the numbers come from a measured load on this machine; an
      oversize job is refused, never attempted.
      *UI stability, 2026-11-08:* Context picks retain checked reports during
      refresh and reject replies from older memory readings. Expanded GPU
      details stay open. Library path editors keep the resting row's size
      below existing sources, alongside sample databases and repository
      imports. Model downloads keep their size and sorted position through
      progress, errors and installation. Settings controls and send notices
      keep surrounding controls steady; uncached threads explain that their
      conversation is loading. Initial Version metadata hydration remains
      a follow-up.
- [ ] <!-- workspace:id=work:1d516a86-fbdc-5de2-9546-47ae95907661 --> ComfyUI opt-in: discover or start the local install, unload app chat,
      run one image, restore chat.
      *Accept:* `pnpm verify:image` with a fake; one real image on this
      machine with progress, cancel, chat restored and whisper unchanged.
      2026-11-08: image turns have durable waiting/running/result/error
      cards, retry/cancel, restart recovery and terminal image-only batches.
      Review fixes give each failed attempt one accepted retry and preserve
      model answers for mixed tool batches. Image follow-ups keep invented
      URLs inert while their real job cards remain independent of model prose.
      Fake lifecycle coverage passes;
      all four image browser journeys pass, including retries across clients.
      Real-runtime acceptance remains open.
- [ ] <!-- workspace:id=work:efd92470-9e03-54a8-97a0-00dd3401270c --> Image presets measured in the room left beside whisper; a smaller
      preset or a refusal when the room is short.
- [x] <!-- workspace:id=work:6cb56f29-0648-5699-ac90-926de5dd53a7 --> A chat model that was already loaded when this app first used it is not counted as the app's own (`runtime/load.ts`), so an image never unloads it and is refused while that model holds the memory. Reported by the owner after a restart with a warm model.
      *Done 2026-11-11:* "An image takes the memory a loaded chat model holds, and the picker says so first"; a model a reply ran on, or any model in an Ollama the app started, is unloaded for an image; a model no reply touched is left alone and named.
- [ ] <!-- workspace:id=work:f982f32c-1dd3-55d6-8128-c60cd4c5f4a8 --> The image swap and the three setups on a real GPU: `real-check.ts --execute --swap-model` has never been run, and every setup's memory need is an estimate. Needs the owner's go.
      *Accept:* one run per setup on a 16 GB card with the measured need written into the setup, and one swap run that prints how long the unload and the wait took.
- [x] <!-- workspace:id=work:4442601c-3c32-51b4-8106-1c517b857cba --> The image picker and the server judge fit differently: the picker subtracts a 512 MiB margin and the server none, so inside that band the picker says "Stops chat" or "Too big" where the server does otherwise, and a refusal can name a setup the picker marks "Too big".
      *Done 2026-11-11:* "An image takes the memory a loaded chat model holds, and the picker says so first"; one function in contracts decides for the picker and the server, with no margin on either side.
- [ ] <!-- workspace:id=work:b1d89071-72da-568f-a5ea-766bb4e700e8 --> Image refusals, small holes: with several Ollama runners the byte count in the sentence can be another runner's (take this app's bytes from `/api/ps`); a file list that gains FLUX.2 Klein after ComfyUI starts stops the chat model and then refuses what was sent while offering that same setup; a refused pixel art offers plain SDXL, another look; a refusal on a file list that was never read starts ComfyUI first; the credit in `smallerFit` has no test.
- [ ] <!-- workspace:id=work:bbb27b74-f736-50f7-9038-ef22971aedcd --> After an image wait that times out or is cancelled the chat model stays unloaded and nothing says the next reply loads it again. With no setup listed Send is still allowed. A saved setup id that no longer exists throws on the tool path. Hidden retry rows still reach the chat model's context as "Image job" rows.
- [x] <!-- workspace:id=work:3bb9e774-1ee2-5909-94f1-1248928a4a8b --> Image picker look: the button cuts the setup name ("FLU… 1024×1024") with room to spare and two SDXL rows can cut to the same text; the same GB number is on every model row and again on every size row, and "Fits" shows three times; the composer button changes width on a thread switch with Image on.
      *Done 2026-11-11:* "An image takes the memory a loaded chat model holds, and the picker says so first"; short names on the button, the GB once per size row with a bar as the mark, a steady width on a thread switch.
- [x] <!-- workspace:id=work:6d0fa9f5-cc7e-5965-b5cf-36e40cb9ed16 --> Image setups as data files, one or two per hardware level, and the app fetches the missing model files into a known folder with progress and resume (today nothing is downloaded and the three setups are constants in `image/presets.ts`).
      *Done 2026-11-12:* "Image setups are ComfyUI workflows, with your own models listed and downloads in the picker"; the owner's direction changed the data files to ComfyUI workflows.
- [ ] <!-- workspace:id=work:34d1f23b-6d57-5ca2-ace4-e54040c89f17 --> `real-check.ts` keeps its database and image under a fixed folder name in the shared temp folder; give each run its own folder.
- [ ] <!-- workspace:id=work:d69f75c9-1b4a-5781-a36c-dd4bb9a21052 --> Turn loop in `packages/harness` (D3): pi's loop shape, a length stop
      fails every pending call, format-error budget, head/tail elision.
      *Accept:* `pnpm verify:tools`: a truncated call never runs; three bad
      calls in a row end the turn with a message; a 50k-character output
      reaches the model as 5k head plus 5k tail.
- [ ] <!-- workspace:id=work:f242d6e1-bef2-5fa0-a6e1-733289be3a9c --> Text-call parser for models without native tools, skipping anything
      inside `<think>`; input repair ("20" to 20, bash to shell).
      *Accept:* recorded transcripts from the qwen and gemma families parse;
      a call inside `<think>` never runs.
- [ ] <!-- workspace:id=work:9ffa91c9-4805-5ac9-8f2b-9992efb5e15f --> Four tools (`shell`, `read`, `note`, `image`).
      *Accept:* the measured tool block stays under 1,000 tokens.
- [ ] <!-- workspace:id=work:583d61d4-807a-5e2d-8eea-cec47bb90fce --> Sandbox: bwrap with a tmpfs root, read-only `/usr`, `VACUUM INTO`
      snapshots at `/data`, no home, no network.
      *Accept:* `WITH … DELETE`, `PRAGMA user_version=7`, a write under
      `/data`, a read of `$HOME` and a network call all fail; a SELECT
      returns rows.
- [ ] <!-- workspace:id=work:391f5985-8f37-5492-a375-69565838a47f --> Sources (D2): the docs library plus databases Ethan adds; snapshot
      refresh and freshness on screen.
      *Accept:* a snapshot of a live WAL database under concurrent writes is
      consistent; a fresh install connects nothing personal.
- [ ] <!-- workspace:id=work:ee5ef346-5832-5383-a0fe-8db10075a8d8 --> Context accounting: fixed prefix, a reserve for the reply and a
      summary, compaction at the selected window.
      *Accept:* a 16k thread that crosses its budget compacts and continues;
      the prefix bytes are identical across turns.

## Next: setup with an AI assistant (decision 2026-11-07)

- [ ] <!-- workspace:id=work:c21fe091-b851-5db9-89f8-9c3f58a6f715 --> Tier table (`setup/tiers.json`): the best text and image model per
      hardware tier (NVIDIA by VRAM, no GPU by system memory), dated.
      *Accept:* every entry names its source, download size, memory at 16k
      and license; the research behind it is in `docs/research/`.
- [ ] <!-- workspace:id=work:7cb6f429-529c-5443-b3cd-91999212715b --> `pnpm setup:probe`: device facts as JSON (OS, GPU vendor and memory,
      system memory, disk free, CPU, Ollama and ComfyUI found, models
      installed).
      *Accept:* fixtures for NVIDIA 16 GB with whisper, NVIDIA 8 GB, no GPU
      with 16 GB and no GPU with 8 GB; real runs on the maintainer's Linux machine and the Windows test machine.
- [ ] <!-- workspace:id=work:3069bb9d-1618-5be6-91db-7491fe69d987 --> `pnpm setup:plan`: the text model and context, the image model or
      none, the downloads and their sizes, each with a plain reason.
      *Accept:* each fixture gets its tier's picks; a plan never exceeds the
      measured free memory.
- [ ] <!-- workspace:id=work:376e3b6d-6b5a-563b-a40b-8263f3312e9d --> `pnpm setup:apply --yes`: Ollama, models and (when chosen) ComfyUI
      and image weights through the app's own install paths, resumable,
      with progress; refuses without `--yes`.
      *Accept:* with fakes, every step in order; a killed run resumes.
- [ ] <!-- workspace:id=work:e548375f-e4bd-5cb4-8f2c-f162fa1eebbf --> `setup/` folder: `AGENTS.md` (run, show, ask, apply, check, report),
      `CLAUDE.md` pointing to it, `README.md` for the manual path.
      *Accept:* a fresh agent on the Windows test machine told "look at this folder and set me
      up" gets a working app with only the user's yes; transcript in
      `docs/evidence/`.
- [ ] <!-- workspace:id=work:0343e439-dfb2-5169-a7ea-aa60c66bb273 --> Settings shows the same plan with no agent, and a "Set up with an AI
      assistant" line with the folder path and the sentence to say.
- [ ] <!-- workspace:id=work:274c94c9-caf5-5c57-ad1d-65eecc604e1b --> Every model name the app offers for download is a real, pullable
      name. The research (`docs/research/setup-tiers-2026-11.md` §1.1)
      found `qwen3.5:14b` does not exist (in `docs/design/shell.html`,
      `packages/contracts/src/testing.ts` and lane/build-runtime's
      `runtime/recommended.ts`), and three of Ethan's models are local
      aliases that fail on any other device.
      *Accept:* the download catalog is read from `setup/tiers.json`; a test
      fails on a catalog name that is not in it; tier entries store the
      pullable name (`hf.co/...:QUANT` or `namespace/name:tag`), never an
      alias.
- [ ] <!-- workspace:id=work:0fefb2a7-4da4-5dfe-9ec0-b6dbe74e5d5c --> Fit estimator counts implicit sliding-window layers. `/api/show` for
      gpt-oss and Gemma 3 names a window but no pattern, so `fit/estimate.ts`
      counts every layer as full: gpt-oss:20b computes 15.67 GB at 16k
      against 13.0 GB measured at 32K on a T4 (research §0.6), which wrongly
      refuses it on a 16 GB card.
      *Accept:* per-architecture default patterns (gptoss 1:1, gemma3 5:1)
      with fixture tests; one real load of `gemma3-abliterated:12b-q4` at
      16k on this machine within 10% of the estimate.
- [ ] <!-- workspace:id=work:e8ac931c-b912-5f7f-b657-a6476541dfb1 --> No-GPU plans turn thinking off by default (qwen3.5:2b took 4 min 37 s
      with thinking on, 4 s off, research §0.9); gpt-oss on CPU runs at
      "low". Image licences: Qwen-Image-2.1 (Qwen Research License) and
      SD-Turbo (Stability Community License) are never a default pick; a
      plan may offer one only as an opt-in with its licence named (SD-Turbo
      is the only measured CPU option under 32 GB of RAM).
      *Accept:* plan fixture tests for both.

## Voice: dictation now, conversation later

2026-11-08: manual voice to text is implemented as an optional local
whisper.cpp client. It inserts into the draft, never sends automatically,
and keeps audio in memory. Setup: `docs/setup/voice.md`. Unit probes cover
transcription, errors, cancellation, permissions and draft insertion. The five
browser journeys passed with fake microphone audio and a fake speech service,
including native undo/redo. The real microphone path is not tested.
Every draft replacement gets a new identity. Dictation keeps its original
identity from microphone start; insertion checks actual focus and retains
blocked transcripts as plain text. Connection checks observe saved speech
settings across windows. Earlier local saves cannot cancel a newer connection
choice. Capture code loads on the first microphone press,
while permission is requested, and voice configuration loads with Settings.

Voice conversation remains unbuilt. The planned turn loop is bounded mic
capture, silence detection, local transcription, streamed chat, sentence by
sentence CPU Pocket TTS, and immediate local playback cancellation when the
person talks over it. `docs/design/voice.md` compares CPU and GPU options,
documents Milo's measured 404/850 ms first-audio references and the latency
targets to validate here, and explains the request identities and PCM capture
that stage 1 leaves reusable. Manual Dictate stays available separately.

2026-11-13 (chat row 38, owner pick A, a try-out): talk mode is built
behind the microphone, off by default: hold to talk (the microphone, or
Space in an empty box), let go to send, the reply read a sentence at a
time by the device's own `speechSynthesis` voice (local voices only), a
speaker icon to turn it off. No voice is bundled.

- [ ] Choose the bundled CPU voice; the owner picks before anything ships. Measured on disk: Pocket TTS English weights 219 MB (`model.safetensors` 219,029,196 bytes plus a 59 KB tokenizer; Milo's measured path; the CC0-catalogued voices are marius, javert, bill_boerst, stuart_bell, with alba as Milo's reference); Kokoro 82M 354 MB (ONNX 325.5 MB plus 28.2 MB of voices); Piper `en_US-lessac-high` 114 MB.
      *Accept:* the chosen voice runs on the processor behind the same sentence reader (`apps/web/src/talk.ts` `Speaker`), with its first-audio time measured against `docs/design/voice.md` targets and its licence written down.
      2026-11-13 listening page (chat row 41; the pick is by ear, on the owner's hub): three replies (short, list, long paragraph) read sentence by sentence on 12 efficiency cores with no GPU, two runs. First sound: Pocket TTS 0.04 to 0.09 s on every reply (it streams within a sentence); Kokoro 0.19 s short, 2.3 to 2.5 s for a 35-word first sentence; Piper 0.07 s short, 1.2 s for the same sentence. Seconds of audio per second of work: Pocket 3.7 to 6.3, Kokoro 5.6 to 6.2, Piper 10.2 to 10.6. What each needs to run besides its weights: Pocket TTS needs PyTorch (715 MB installed, CPU build); Kokoro and Piper need ONNX Runtime (67 to 78 MB) with espeak-ng data. Pocket TTS leaves longer quiet after a sentence (up to 1.9 s for javert). Licences read 2026-11-13 (chat row 43): one table in `docs/design/voice.md`, "What a bundled voice would ship, and its licence". Pocket TTS is the only set with no GPL part; Kokoro as packaged brings GPL phonemizing and two files with no stated licence; Piper brings a GPL runtime and a voice trained on research-only data.
- [x] Stop on a reply also stops its reading and pulls back the sentences already handed to the voice (chat row 42, coordinator default named to the owner, 2026-11-13). A reply that fails is still read to its last written word. Any stop of the reply on screen counts, including one from another window; which window's Stop may stop a reply stays the open two-window row under Client ordering replay.
      *Proof:* `talk.test.ts` "Stop on a reply silences it" (red on dev: the queue kept "One.", "Two.", "Thr") and the Stop step in `test/e2e/voice.spec.ts` (red on dev: no cancel on Stop).

- [ ] <!-- workspace:id=work:467cf6a2-d944-5751-89dd-5115d78c96a6 --> Dictation cancellation is keyed twice: Composer remounts `Voice` by draft identity, while `Voice` also tears capture down on identity changes.
      *Accept:* consolidate the lifecycle in `Composer.tsx`/`Voice.tsx` while replacement, navigation and disconnect still release the microphone and reject late transcripts.

## Client ordering replay

2026-11-08: in-memory replay now explores speech Connect/Disconnect choices
across two windows and hydration, a send across disconnect/reconnect, and Stop
around acknowledgements. It runs the real session and store with fake transport
and stepped time. Three speech ordering bugs were rediscovered on older commits,
and all three are fixed. `docs/testing.md` explains
scenario constraints and replaying a printed order. These are diagnostic probes;
the existing suite and independent review still determine acceptance.

2026-11-08, SL-01: sender pushes now precede responses independently of hydration;
other-window deliveries are separate. Per-socket FIFO also covers foreign writes
and chat start broadcasts, with admission-time recipients retained on disconnect.
The wider graphs use 64 deterministic samples each, not an exhaustive claim.
A mutation limited to an own Connect push received during hydration passed the
old graph and failed the new one.

2026-11-08, RP-01: response emission is separate from writes and admission, so
batched broadcasts can precede both acknowledgements. An explicit witness found
an older response rolling back newer theme state and its DOM attribute. Shared
and per-model saves now keep newer pushes authoritative, with no-push response
fallback preserved. The seven scenarios remain 64 deterministic schedules each,
plus the explicit batched-write regression; coverage is sampled, not exhaustive.

2026-11-09: eight further guard-specific cases cover fit/preflight epochs, late
preloads, installed-model pushes, off-screen completion across reconnect, image
probes, update hydration and pull acknowledgement timeouts. All seven guard
removals failed for their intended reason. Three real bugs were fixed: stale
image readiness, restored update notes/lost checks, and disappearing download
progress. Runtime retry was excluded by the current server's serialization
guarantee. The combined replay runs 719 schedules; `docs/testing.md` records the
sampled and exhaustive portions. No browser is needed for these state checks.

2026-11-09, RS-01: reconnect reads pending server downloads in the first hydration
batch. Missed terminal events retire stale active rows, live jobs retain progress,
and newer buffered pushes win. First-model queued sends resume after installation;
an unavailable read preserves rows. Seven new replay cases add 262 schedules for
981 total, with explicit witnesses and the same 64-sample cap. Stale rows and
stale progress were watched failing before the fix. RS-02 remains unchanged.

2026-11-09, RS-01 wording: first-model queued messages explain a failed or cancelled
download at render time without changing the queue or reconnect reconciliation.
Offline replays preserve the entry and text, and real Composer rendering checks
cover connected failure, Cancel, editing, removal, retry and a live download
during a disconnect. All four stopped-download wording checks were watched red.
RS-03 remains dropped.

- [x] <!-- workspace:id=work:6f64f21a-3033-507f-aafe-f17f3bd1970b --> Keep running replies in one turn map and one reducer, including off-screen first-word time and reconnect snapshots.
      *Done 2026-11-09:* “Hold every running reply in one turn map with one reducer”; listed-only turns mark the sidebar without holding the queue.
- [ ] <!-- workspace:id=work:fbae140a-52c0-55b0-a978-0dd9a2362dc0 --> Stop during a replayed-send acknowledgment can miss the real running turn: `app.ts` returns a synthetic saved id and the client's replay branch clears its pending turn.
      *Accept:* replay returns the active id when present and a Stop at admission cancels it on the server.
- [ ] <!-- workspace:id=work:a99c6e69-d3f5-5b10-ba25-9e4303fbb829 --> A failure after fit passes but before the user row is saved emits no terminal event in `apps/server/src/app.ts`.
      *Accept:* another window clears the listed running marker without waiting for reconnect when admission fails there.
- [ ] <!-- workspace:id=work:c587a493-aab1-56bb-9bf4-37a11af524c5 --> Sending into a chat with a listed-only turn replaces its marker; a turn-active refusal drops it until the other client's start arrives (`session/chat.ts`).
      *Accept:* a held other-client start and refused local send retain the sidebar's truthful running state.
- [ ] Another window starts a reply in a chat while this window's send is still unanswered: this send is refused as turn-active, and this window's Stop then stops the other window's reply, which is the one on screen (chat row 32 edge case, 2026-11-13).
      *Accept:* the refused send keeps its words with a true line, and a browser test with two windows shows which reply Stop stops (the owner decides: only this window's own, or the reply on screen whoever sent it).
- [ ] <!-- workspace:id=work:0d656ff2-effc-5c4c-9ffb-9e3d65679a19 --> `oldTurns` in `session/chat.ts` only retires ids on terminal events, so missed terminals can grow the set for the session's lifetime.
      *Accept:* repeated missed endings stay bounded without allowing late events into a replacement turn.
- [ ] <!-- workspace:id=work:3226a596-aaa1-5051-914e-fe2f6a70a940 --> Exercise listed-turn send refusal and a listed turn's later start in the browser; `listed-turn.test.ts` currently proves those ordering paths in memory.
      *Accept:* the visible marker, controls and thinking clock follow the same rules under delayed delivery.
- [ ] <!-- workspace:id=work:41ca497f-e406-5a64-854b-f935d39c1f8a --> Add browser proof for the queued-edit late-confirmation race; session/persistence fixtures cover it, but `thread-drafts.spec.ts` does not drive it.
      *Accept:* hold confirmation, change the queued edit, then confirm, send and reload without losing either draft.
- [ ] <!-- workspace:id=work:552df8d8-5654-5441-a6d8-8870b694f013 --> Run the complete browser suite on the per-chat-draft head; its landing ran 14 specs, while the earlier full-suite pass predates it.
      *Accept:* a retained full-project result covers the current draft and turn-map integration.

## Next: measurement tooling

- [x] <!-- workspace:id=work:84ab98b2-f3ee-5357-b1a1-53e0880f6770 --> Record per-action CPU cost and work counts with a shuffle comparison and release history.
      *Done 2026-11-09:* “Add a performance comparison that counts work, and say what one job can see”; method and limits are in `docs/perf-method.md`.
- [x] <!-- workspace:id=work:096ae7c9-d7dd-5ac4-a3b1-c6c4dc616106 --> Separate unscoreable rows from noise, measure whole-thread mounts and type inside a fully mounted long thread.
      *Done 2026-11-09:* “Make the perf comparison say "not scored" and time a long thread's whole mount”; the same-run comparison exposed the backfill cost above.
- [ ] <!-- workspace:id=work:77855959-5fc4-5577-a95c-73680a4a0ee8 --> `score-next.ts`'s arrangement guard assumes only two extreme shuffles, which is false for tied lower quartiles at four rounds of two timed samples.
      *Accept:* tied data that cannot establish a reliable difference says not scored rather than within noise.
- [ ] <!-- workspace:id=work:8aa6f4f6-e027-55af-be64-777e0930ea38 --> Calibrate the new `-mounted` and `type-in-thread-2000` rows on a same-build job; their detectable sizes remain unknown in `docs/perf-method.md`.
      *Accept:* retain raw rows and simulated detectable sizes for both windows without treating the comparison limit as machine noise.
- [ ] <!-- workspace:id=work:d800b42c-fec8-5a5b-b8ae-ba7b8e2e1ed5 --> Run `perf:next` with its default group selection on the test runner; earlier jobs selected groups explicitly.
      *Accept:* an unfiltered job records every supported default group and its sampling plan inside the stated job budget.
- [ ] <!-- workspace:id=work:17af7eb8-33ef-5574-8f07-f76ad912c521 --> Prove missing-hook and late-hook refusals on a real page in `next.spec.ts`, not only through unit tests and the passing hook path.
      *Accept:* deliberately absent/late React counters fail with the named measurement error instead of zero work.
- [ ] <!-- workspace:id=work:ccb1cd26-49da-5eef-a0e3-d37495a865be --> Measure CPU throttling before using `next-compare.ts --throttle` to interpret changes; the option is implemented but uncalibrated.
      *Accept:* a same-build run states its noise and detectable sizes under the selected throttle.
- [ ] <!-- workspace:id=work:60e41e9c-a63e-5c28-bc6c-439f8bae8274 --> The detectable-size simulation uses 400 shuffles while real scoring uses 4,000; `docs/perf-method.md` records nine cells moving one step on a full replay.
      *Accept:* quantify or remove that approximation without presenting simulated cells as equally precise measurements.
- [ ] <!-- workspace:id=work:9496c561-7ebe-58f5-93e2-cf24392f9613 --> Cold-composer's first recording once ended before the sidebar loaded, counting 536 renders rather than 1,458; its probe still ends at the usable composer.
      *Accept:* distinguish composer readiness from complete initial sidebar work and retain comparable counters for each claimed window.
- [ ] <!-- workspace:id=work:857ee6b0-847e-570a-b8ef-b4b61020a923 --> The queue handoff's CPU/count window includes the previous reply finishing, while its wall window starts at the done marker (`next.spec.ts`, `perf-method.md`).
      *Accept:* isolate handoff work or label each reported window so the wider CPU change is never called handoff latency.
- [ ] <!-- workspace:id=work:cce39778-08c1-5077-842d-003f72074a63 --> Add a focused diagnostic test for `next.spec.ts`'s typing action; only recorded comparison rows currently prove that journey runs.
      *Accept:* wrong character, focus or end-state wiring fails the diagnostic without needing a full paired job.
- [ ] <!-- workspace:id=work:602e2a33-bd58-5e7d-bcce-b0ced6d2d02f --> A long thread that never fully mounts leaves the new later-end probe waiting until the general test timeout.
      *Accept:* an intentionally stalled backfill fails promptly with the missing mount count and action named.
- [ ] <!-- workspace:id=work:27cc6930-07f6-59f5-a97a-af395e2b8da1 --> Explain the measured typing wall-time rise from 35.15 to 43.22 ms despite lower script time in the long-thread comparison.
      *Accept:* a focused paired run and profile separate frame scheduling from extra app work before attributing the change.
      *Measured 2026-11-10:* the typing group reads about 42 ms from key to paint in every state, idle or streaming, short thread or 400 messages, with about 1 ms of script for each key. That points at frame timing on the test machine, not app work.
- [ ] <!-- workspace:id=work:93d20a76-5eac-55f5-961d-eb34a758e017 --> The release check's "typing during a stream" row has a fixed 50 ms limit, and idle typing misses it on the test machine as often as typing during a reply does. The row cannot tell what the reply adds.
      *Accept:* the row compares typing during a reply with idle typing measured in the same run, and fails on the difference.
- [ ] <!-- workspace:id=work:e65348a3-9ba1-5d8b-8be4-e35ef9a4768a --> Opening a long chat still forces one layout of the first 40 turns when the message box takes focus (about 35 to 50 ms on the test machine).
      *Accept:* opening the 400-message test thread on a fresh page shows no task over 50 ms in 5 of 5 runs, by mounting fewer turns on open.
- [ ] <!-- workspace:id=work:f66c5682-2627-58b7-89e2-9ae45cebd180 --> The typing timing group fits only 2 of 4 rounds in one test-machine job, so its time rows are never scored. With the new self-sizing message box, layout time for each piece of a reply in the 400-message thread read about 2 ms higher in 3 of 4 runs and equal in an earlier job.
      *Accept:* four rounds fit (two jobs, or one counter repetition after the first round), and the per-piece layout row is scored.
- [ ] <!-- workspace:id=work:914d2e33-f0ed-53c9-bbc1-0a07a0da8801 --> Firefox, and Safari versions without `field-sizing`, still measure the message box on every key and lay out the page.
      *Accept:* a measured layouts-per-key count on one of them, and a decision from it.
- [ ] <!-- workspace:id=work:8db4ff53-ea0c-5a87-b735-afbc5da7fa46 --> Retire the older `compare.ts`/`stats.ts` path after the new method has served a release; first-run and desktop-launch still depend on it.
      *Accept:* those groups have an equivalent supported home and recorded comparisons remain readable.

## Next: test suite health

- [ ] <!-- workspace:id=work:59afc336-b09f-5253-9af1-a8b0ecee7160 --> Test audit 2026-11-11, breaks still caught by nothing: an outside Ollama shown with the wrong version (`runtime/runtime.ts`), a relative data folder accepted by the Linux install (`desktop/src/linux-install.ts`), the Regenerate spinner, a stale "check failed" message, "0 KB" chips. Removing the wait for the image sweep before a thread delete changes nothing a test can see, so that wait is either not needed or not testable as written: decide which.
      *Accept:* one unit test per break, each watched failing against the break.
- [ ] <!-- workspace:id=work:8e68df74-337b-51af-bd80-94573ffc8d8d --> Test audit 2026-11-11, owner rulings held only by a browser spec (Copy code, the thread menu, queueing, the one Send button, Remove in the row menu, message Copy, the footer row, the pill label on hover and four more) and three held only by one (thoughts shown while thinking, a pasted file inserts its path, right-click opens the thread menu): a unit test where one is cheap, so a ruling does not depend on the slow suite alone.
- [ ] <!-- workspace:id=work:3ca142fc-e46a-5f5a-bc24-327d01ccacef --> Test audit 2026-11-11, trims not done: render-only cases left in `Composer.test.ts` and `FirstRun.test.ts` now that pressing tests sit beside them; six Composer states that expect "Send message" through one branch; tests pinned to script text, exact CSS substrings or exact HTML (status page, image claims, a regex over `styles.css`); the Gemma mark candidates spec that only saves a screenshot.
- [x] <!-- workspace:id=work:c5f7828f-71d6-577c-8b62-253b42121818 --> Give each unit run one scratch root, wait on state and keep SQL children from outliving their server.
      *Done 2026-11-09:* “Make the unit tests wait for state, clean up after themselves, and stop a query whose server died”; permission/link cleanup and cancellation have failing-first probes.
- [ ] <!-- workspace:id=work:66f9deb7-c573-5270-85f3-ef538418a946 --> Confirm repeated paste scenarios are isolated: `paste.spec.ts` counts matching prompts globally, and the fake kept its request log across resets until “Clear the fake Ollama's request log on every scenario reset”.
      *Accept:* the two image-send/edit paste cases pass repeated in one process without weakening request-count assertions.
- [ ] <!-- workspace:id=work:82586f85-d8af-5135-a722-a71f7a459366 --> Diagnose the intermittent release-cancellation report failure in `test/release.test.ts`'s “interrupting a running check” case.
      *Accept:* repeat under load with retained failure evidence and require the report plus confirmed child shutdown on every run.
- [ ] <!-- workspace:id=work:41c4ee7c-0188-5e88-aa9d-2796b112e730 --> Diagnose the intermittent process-group timing failure in `apps/server/src/update/run.test.ts`: it failed once inside a full `pnpm verify` on a busy machine and passed 3 of 3 alone.
      *Accept:* repeat the file under full load, name the case and the missed deadline, and make it wait on state so it passes every run.
- [x] <!-- workspace:id=work:5743ffbb-2350-5ab5-a971-a72e96d87b8b --> Diagnose the intermittent project-list check in `test/release-projects.test.ts`; the blocking/timing companion assertion failed once and then passed. Cause: Playwright exits right after printing the list, and a pipe's reader on a busy machine had not taken it all, so the list arrived cut short with exit status 0. The list now goes to a file and must end with its total line. Under full load: 5 failures in 12 runs before, 0 in 12 after.
      *Accept:* repeated project listings under load keep the functional companions in the blocking project with no timeout flake.
- [ ] <!-- workspace:id=work:854ba173-6dcb-55b2-b926-e25cad7cae67 --> Profile performance-fixture seeding: `test/perf/fixture.test.ts` now uses the run root and a 180-second setup bound, but the expensive real-store seed is unprofiled.
      *Accept:* attribute seed time and reduce unnecessary work while preserving the complete isolated 400-thread fixture.
- [ ] <!-- workspace:id=work:afaa4cbe-6194-5ecd-94c1-2556e1c8c3d8 --> State-wait helpers still give generic “condition not reached” messages, including `runtime/load.test.ts`'s `until`.
      *Accept:* forced readiness/shutdown failures name the missing state and keep their existing deadlines.
- [ ] <!-- workspace:id=work:2cbbff58-6e22-5bd9-b802-385daaf751fc --> The scratch sweep trusts directory mtime and wall time, so a forward clock jump over a day can remove a live run (`test/global-setup.ts`).
      *Accept:* simulate the jump with a live run and preserve its root while still collecting abandoned runs.
- [ ] <!-- workspace:id=work:29716ee3-290a-504c-a5db-ae99746955c6 --> A watch session idle over a day can be swept by another test invocation because the scratch root has no live-owner check.
      *Accept:* overlap an aged watch session and a fresh setup without losing the active session's files.
- [ ] <!-- workspace:id=work:1509e5e6-9819-51dd-9a5f-ba5765e45cd1 --> Scratch permission repair has a window between lstat and chmod where a directory could be replaced by a symlink in `test/global-setup.ts`.
      *Accept:* race that replacement and leave the outside target's permissions unchanged.
- [ ] <!-- workspace:id=work:39bfa3f4-a81e-58b7-aaf1-125e4b14571a --> Older scratch folders with the former names are not collected by the new run-prefix sweep.
      *Accept:* inventory and archive authorized old test/performance/GPU fixtures without touching unrelated files or live runs.
- [ ] <!-- workspace:id=work:579a8c2c-0d90-5b3b-b5c2-888063c2586e --> Verify stale-run cleanup against a genuinely day-old abandoned run; current cleanup evidence uses artificially aged fixtures.
      *Accept:* the next setup collects that run and preserves recent and linked paths.
- [ ] <!-- workspace:id=work:b1729469-e4fb-5dcf-99b0-6f04fc1d60e1 --> Verify the scratch-root, SQL-parent and cancelled-release changes on native Windows; the unit-hygiene landing used Linux checks.
      *Accept:* Windows keeps its temp-path rules, bounds cancellation and leaves no owned query child.
- [ ] <!-- workspace:id=work:005b7a72-a2c3-510c-96b1-3d21782b91a8 --> The default session harness answers `turns.active` with the empty contract sample unless a test overrides it.
      *Accept:* representative reconnect/queue tests include server-listed work so active-turn regressions cannot pass through an empty fixture.
- [ ] <!-- workspace:id=work:f3885671-23fc-5569-82cf-ec66b22e2ee6 --> The long-thread unit scroll model does not model browser anchoring independently; it cannot distinguish a content offset from a view offset.
      *Accept:* either offset bug fails the model, with the real browser drift journey retained as the position proof.
- [ ] <!-- workspace:id=work:1fb09f37-2be1-5c5d-bf0a-260f2031b1b1 --> The unexplained immediate-reload paste loss (`paste.spec.ts:67`, last typed character missing) was seen a second time on 2026-11-09 and not reproduced in 50 further runs across two hosts; IndexedDB unload remains best effort.
      *Accept:* retain a reproducible lifecycle trace if it recurs and distinguish an aborted pending write from a lost committed write.
- [ ] <!-- workspace:id=work:20af668e-d8f2-5996-9db1-8be1360d9370 --> The desktop paste journey (`test/e2e/paste-desktop.spec.ts`) needs a display and was outside the 14 browser specs run for the per-chat drafts change, which changed the paste guard; it went red on main for one landing.
      *Accept:* a change to `paste.ts`, `drafts.ts`, `Composer.tsx` or `apps/desktop/src/native-paste.ts` cannot land without that spec having run.
- [ ] <!-- workspace:id=work:f8500bc0-43c3-57ae-9bcd-c6807bc8a779 --> The stop-note mark test renders saved and user turns only (`thread-identity.test.ts`); a live reply's `noted` class and the `styles.css` rule that reads it are untested.
      *Accept:* read the gap under a stop note in a browser for a reply kept while its last words are still appearing.
- [ ] <!-- workspace:id=work:78a260ae-f934-5e92-8357-0f4dcc13926a --> The gap between timeline neighbours was measured for the per-turn gap change by a staging-only spec (four screen profiles, 12 and 2,000 turns, four stop-note states); nothing in the suite fails when a spacing rule changes a gap.
      *Accept:* keep one fast gap journey, or record that spacing changes are measured by hand before landing.
- [ ] <!-- workspace:id=work:543fdcd7-6967-54f0-93d7-18fb49288bd4 --> `composer-polish.spec.ts` "refused chips stay with their own thread across a thread switch" failed once in a browser run (the second file's chip never appeared after the file chooser) and passed 4 of 4 alone.
      *Accept:* repeat it under load, name the step that raced, and make it wait on state.
- [ ] <!-- workspace:id=work:401929a4-0929-5173-9777-085a40ec48cb --> `styles.css` and the session wiring in `session.ts` are edited by most screen changes at once (four open changes touched each on 2026-11-11), so they merge by hand.
      *Accept:* styles split per screen and session parts registered additively, so two screen changes merge without touching the same lines.
- [ ] <!-- workspace:id=work:3d565764-5f08-5010-9dd5-4ff0df759b71 --> Replace routine five-second journey warnings with the whole-suite budget; `budget-reporter.ts` still prints both after the suite trim.
      *Accept:* one complete-run report identifies budget overruns and expensive setup without per-journey warning noise.

## Later: slices 5 to 7

- [ ] <!-- workspace:id=work:c0cb50be-fb59-52f0-b9e6-bb7c914b700e --> Models and Usage open as pop-up panels over the chat; Settings stays its own screen (owner, 2026-11-11). Usage is built that way first; Models moves out of Settings into the same panel after.
- [ ] <!-- workspace:id=work:d17c769b-d526-568a-ba63-91a8c1b35a6b --> Usage file: any open error moves the file aside and starts empty. Only a corrupt file should move; a read-only file or a newer schema should run in memory and leave the file alone. The one-time fill compares raw clock times, so a clock moved back after a failed fill can count a reply twice and a reply stamped after the first open is never filled.
      *Accept:* a test per case (read-only, newer schema, clock moved back) with the file left as it was.
- [ ] <!-- workspace:id=work:16277434-f91e-59c9-b8a4-b894c9c36559 --> Usage counts nothing for a stopped reply or a benchmark, and the screen does not say so (owner decides whether a stopped reply's tokens count).
- [ ] <!-- workspace:id=work:f1f4dd1d-01c6-50fb-8a6d-ca3d0753d53e --> Usage screen: a read slower than 250 ms lets the chart and rows appear late (placeholders cover only the five numbers); rows reorder under the pointer when a reply finishes; the chart has no day labels; half-hour time zones put the hour that straddles local midnight wholly in one day; a ninth model shares a colour with the first; the whole file is read every time.
      *Accept:* nothing on the pop-up appears or moves after it opens, measured in a browser with a slowed read.
- [ ] <!-- workspace:id=work:f87db37c-b144-5abe-8e74-52c8bddfc640 --> Usage and Back: after a reload on the pop-up the first Back does nothing, and a close followed by a fast reopen can race `history.back()`. Usage returns focus to its icon, not the message box.
- [ ] <!-- workspace:id=work:09277be1-5e0b-5350-9310-f9b44ebc1389 --> Opening Usage or Settings while a dictation is being transcribed throws away the words already heard.
- [ ] <!-- workspace:id=work:d21037c3-719b-54b6-838d-a22f2d39e131 --> Sample databases that are more useful: starter questions that open a chat on the database and real public data are in (2026-11-11, "Library databases: one list…"); still open: the person's own chat history as a database, and a sample used as a model test.
- [ ] <!-- workspace:id=work:f68ef1fa-e2f8-5aa4-867e-a1c199c7fa0c --> Screens the owner has named for later: custom image generation workflows, custom benchmarks, fine tuning, a memory viewer, a gallery viewer.
- [ ] <!-- workspace:id=work:411e875c-2a37-5b28-a5ce-379b3bd446e0 --> Benchmarks: speed, tools and sql suites through the real turn code,
      recording model digest, runtime version, profile and harness revision.
      *Accept:* `pnpm bench:local --suite speed,tools,sql` writes a result
      file; a rerun on the same digest lands within the stated noise.
- [ ] <!-- workspace:id=work:84bbfddd-dd93-5f89-9c16-444881d34e11 --> SQL choice: 30 to 50 questions, shell sqlite against the GatesAI typed
      query control on the same models; keep the winner, record the numbers.
- [ ] <!-- workspace:id=work:7a6885e7-578f-5634-b406-293f893e850d --> Day-one defaults (model, window, profile) chosen from benchmark
      results, never from download size.
- [ ] <!-- workspace:id=work:e4178083-647c-5e0b-a70c-b85b309cc47a --> Gated memory (D4): "remember" saves a note with its source quote;
      `note` proposals wait for approval.
      *Accept:* `pnpm verify:memory`: a rejected proposal leaves notes
      unchanged; an accepted one keeps the prior version.
- [ ] <!-- workspace:id=work:e32473bb-b357-5dec-a1ca-03723b962e62 --> Dream pass on an idle app queue: note corrections as a proposed diff,
      never a live edit.
- [ ] <!-- workspace:id=work:07422dc2-24b2-5ad2-b2f1-398afb664287 --> Installed handoff: Linux AppImage against real Ollama and ComfyUI,
      selected models ready, whisper unchanged through success and failure.
      *Accept:* `pnpm release:smoke` on this machine plus a try-it packet for
      Ethan. Packaging does not authorize a release or publication.
      *Status 2026-11-09:* a Linux AppImage reaches first run against an
      isolated stopped-runtime setup. Real Ollama/ComfyUI handoff remains open.
      Build-to-build replacement preserves the measured settings, thread,
      completed-message fixture, profile marker and model-file fixture in
      per-user XDG storage. Ordinary execution in the test environment fails
      before Electron because `libfuse.so.2` is missing; tested workaround
      still needs extraction mode and `--no-sandbox`.
- [ ] <!-- workspace:id=work:958fd54b-6524-5aa6-a943-fcffaf4153bb --> Release gate: after a step exits normally, stop its owned process group
      and keep the scratch directory if shutdown stays unconfirmed.
      *Accept:* a step that leaves a same-group process behind gets it stopped.
- [ ] <!-- workspace:id=work:83589d17-fd67-55b2-b660-ed14c924768c --> Packaged releases (AppImage, Windows installer, auto-update) once
      all platform update paths are complete. `pnpm run app-update` covers
      git clones; Windows installed copies still update manually.
      *Delivered 2026-11-12:* 0.2.1 is public with native Windows/Linux
      downloads and signed update metadata. The fresh public-clone check,
      Linux packaged checks and Windows 0.2.0 to 0.2.1 upgrade passed.
      Linux AppImage self-update is included; Windows self-installing
      updates and the real-runtime/interactive launch checks remain open.
      See the current release and its measured limits in `docs/releasing.md`.
      *Startup diagnostics 2026-11-09:* failed launches now keep the child exit,
      stderr and a token-redacted report after quit. The smoke retains those
      details on failure. Offline candidates were recorded before the one
      authorized native diagnostic run; its result is recorded below.
      *Status 2026-11-09:* `pnpm package:linux` builds an unsigned AppImage
      with the server and Node runtime included. Packaged first run and
      update refusal observed. Linux two-build persistence is measured with
      Gates data overrides unset. `pnpm package:win` builds an unsigned NSIS
      installer natively on Windows; cross-building failed in portable Wine
      (`ntdll.dll`, `c0000135`). Native installed first run, Origin admission
      and two-build persistence passed in the corrected-wait round below.
      SmartScreen and double-click observations
      require separate interactive authorization. Packaged auto-update is separate follow-up work;
      no release, upload or tag authorized. See `docs/releasing.md`.
      *PK-01 completed 2026-11-09:* packaged profile and data defaults are
      separate from the unchanged clone defaults. The diagnostic check
      failed first, then passed twice. A real developer instance stayed
      open during the packaged `0.0.3-test` to `0.0.4-test` upgrade; both
      packaged launches used their own defaults without Gates path
      overrides, retained their data and left developer data/profile
      unchanged. No clone-to-installed migration is performed.
      *Limited native round 2026-11-09:* approved PowerShell SSH was used
      without an exclusive slot. The first build step stopped on a harness
      Node-expression quoting error before dependency installation or
      packaging. No native installer, install, smoke or upgrade result is
      claimed. The isolated PowerShell environment excluded development
      tools, but native known-folder APIs still returned real user paths.
      The new lane directory was removed; SmartScreen, double-click launch
      and uninstaller/HKCU behavior remain unobserved.
      *Native retry 2026-11-09:* native dependency install and NSIS build
      passed; unsigned `0.0.6-native` silently installed at its default
      per-user path with no development tools on PATH. All package targets
      were absent beforehand. Main/profile/data paths matched the packaged
      defaults and SQLite was created, but the smoke did not observe ready.
      The later diagnostic found its wait returned prematurely.
      First-run/Origin checks and upgrade remain open; no app
      retry was made. Own uninstall removed app files, Start Menu shortcut
      and NSIS HKCU keys, retaining data/profile as configured. Only the
      recorded-new leftovers and lane cache were then removed. SmartScreen
      and real double-click launch remain unobserved.
      *Diagnostic native round 2026-11-09:* unsigned `0.0.7-native` built and
      silently installed at its default per-user location after all targets
      were recorded absent. The retained bridge state was `starting`; the
      child printed ready/listening while the driver closed. The async
      Playwright wait returned prematurely on a Promise. `expect.poll` fixes
      that local reproduction, but the corrected Windows smoke was not rerun.
      End-to-end readiness, first run, Origin and upgrade remain unproven.
      Own uninstall and recorded-new cleanup completed after waiting for the
      exclusive run; all package objects and the lane cache were confirmed absent.
      *Corrected-wait Windows round completed 2026-11-09:* one persistent
      systemd user unit built and tested `0.0.8-native` then `0.0.9-native`
      from committed source, with no data/profile overrides and no development
      tools on PATH. All package targets were absent before install. Both
      bridges reached ready; first run and Origin admission passed. Installing
      the second build over the first preserved settings, the thread,
      completed-message fixture, profile marker and file fixture; the newer
      renderer displayed the message. Own uninstall removed app files and
      NSIS HKCU keys, retaining data/profile as configured. Only recorded-new
      leftovers and the lane cache were then removed. GPU-process warnings
      were retained; interactive desktop, SmartScreen and real model/runtime
      operation remain unproven. See `docs/releasing.md` for the exact limits.
      *IN-01/IN-02 fixed 2026-11-09:* an observed exit is now retained across
      quit without classifying intentional termination as a crash. Managed
      reports are bounded to five files of at most 64 KiB, keeping stderr's end
      and redacting before truncation. Only recognized generated report files
      are rotated. Failing-first Node probes cover the race, size/retention,
      Unicode/token cuts and unrelated-file preservation. No new Windows or
      packaged run was used. Still open from that review: output from the
      server with no line ending is buffered without a limit until a newline
      arrives, and a server that fails during an intentional shutdown leaves
      no report.
- [ ] <!-- workspace:id=work:6dcaca3e-31c9-50f9-aef3-2ad7dd7e9af0 --> Prove that nvidia-smi resolves from the packaged app's PATH on an NVIDIA machine (`fit/gpu.ts`, desktop server environment).
      *Accept:* a packaged launch reads the installed GPU rather than silently treating a missing executable as a system-memory plan.
- [ ] <!-- workspace:id=work:a34578dc-e5a4-5922-a8d4-32be83dfaef3 --> Carry the git-clone update handoff deadline into the packaged-update design; the current five-second disconnected-client reservation belongs to the clone updater.
      *Accept:* abandoned approval releases admission and an accepted packaged update is acknowledged only after server readiness, including rollback.
- [ ] <!-- workspace:id=work:77bf507b-bee7-57b1-92d2-577b59852e18 --> Release commands: refuse a version number part too large to compare exactly. `update/semver.ts` reads each part with `Number`, so two different parts above 2^53 compare as equal.
      *Accept:* a version with such a part is refused by `release:assemble`, `release:verify` and the installed check, with a test for each.
- [ ] <!-- workspace:id=work:c925b608-1a16-5594-9873-8e9726494f29 --> Release commands: `release:sign` and `release:artifact` trust `git status`, which does not report files marked assume-unchanged or skip-worktree.
      *Accept:* a checkout with a changed file hidden that way is refused, shown by a test that hides one.
- [ ] <!-- workspace:id=work:d995693f-189f-5982-a1a8-2315101621da --> Release commands: `release:assemble` moves the finished folder into place with one rename, which replaces an empty folder that appeared at the output path after the first check.
      *Accept:* the move fails when anything exists at the output path, shown by a test that creates the folder between the check and the move.
- [ ] <!-- workspace:id=work:058f843a-281d-5cc7-b097-8d17a4196332 --> Packaging: a release build may download its build tools (the installer and AppImage tooling) when the cache is empty, so the same commit can be built from different tool files.
      *Accept:* `release:artifact` fails with a plain message when a build tool is not already in the cache, or checks each one against a recorded hash.
- [ ] <!-- workspace:id=work:dbb82391-06ba-5282-b260-850193507e58 --> Settings saved by an older version drop the keys a newer version wrote, because the file is decoded to the fields that version knows and written back.
      Going back one version and forward again loses those settings.
      *Accept:* a settings file with a key this version does not know keeps that key after a save.
- [ ] <!-- workspace:id=work:c18a378b-448f-53ec-8cd5-d551385374c8 --> Chat store copies are never removed. Each upgrade of the chat store leaves one full copy in `store-copies`, and failed attempts can leave `.copy-*` files there.
      *Accept:* a stated rule (which copies stay, and for how long) with a test, and no copy removed while an update is unfinished or a failed go-back has not been dismissed.
- [x] <!-- workspace:id=work:03cdfc1a-4cb7-5f66-aeb3-e6f8174a1506 --> Chat store copy on Windows: another program holding the new copy open makes the final rename fail and the start is refused. The rename is now tried again for up to two seconds. Measured on native Windows 11: 3 failures in 28 runs before, 0 in 60 after, with 8 refusals that each worked on the first retry.
- [ ] <!-- workspace:id=work:b8a2e9c7-ef2e-5878-9551-1e6ba27e248f --> Chat store copy on Windows: a rename still refused after the two-second retry says permission was denied, or that the copy could not be put in its final place. It does not say another program is holding the file, and that give-up path has only run in a unit test with the wait mocked.
      *Accept:* a sentence of its own for a file held by another program, and a native Windows run with a second handle held on the copy for longer than two seconds that shows it.
- [ ] <!-- workspace:id=work:9e063480-b2a4-5802-908a-992232d2d55f --> Chat store copy on Windows: the copy's final name is not forced to disk before the first upgrade step, because Windows cannot flush a folder. A power cut in the seconds after could leave an upgraded store whose saved copy still has its temporary `.copy-*` name. Not measured.
      *Accept:* either a flush of the renamed file is shown to make the name durable on NTFS, or the limit is stated in the update design with how to find the file.
- [ ] <!-- workspace:id=work:49fe0c50-fe54-5ca2-8c0d-1c9b1dd452e7 --> Chat store copy, known limit: the copy is taken before the upgrade starts, so chats written by an older copy of the program that is still running at that moment, after the copy, are in the upgraded store but not in the saved copy. An installed update stops the old program before the new one starts, so this needs two programs sharing one data folder.
      *Accept:* the upgrade refuses, or copies again, when another program has the store open.
- [ ] <!-- workspace:id=work:287352dd-93c3-573a-bf76-98e9c9a37d2b --> A person who installs an older version by hand over a newer one is refused at startup because the chat database is at a newer version (`StoreVersionTooNewError`), with no next step, although the older store is saved in `store-copies`. On Windows the first release has no automatic go-back, so this is the only way back there.
      *Accept:* that page names the saved copy and the steps to put it back, or offers to do it.
- [ ] <!-- workspace:id=work:23b671db-1e12-583c-8d8b-876067b494db --> The git-clone updater cannot go back across a chat store upgrade: it restores the program files, and the older program then refuses the upgraded store. In the code before installed updates.
      *Accept:* a clone update whose new version upgraded the store and then failed goes back with the saved copy restored, shown by a test.
- [ ] <!-- workspace:id=work:13e31a99-8209-562e-9930-81caea21467c --> Installed download: a local write error, or a release file the release page does not have, says "Could not download version <new>. Check your connection." Neither is a connection problem.
      *Accept:* each has a sentence of its own that names what failed, with a test.
- [ ] <!-- workspace:id=work:eb6d69b4-2f3e-5a71-9cc4-ff8597b3077d --> Installed download on Windows: the packaged test build has not been driven through the download states there. The folder's unit tests and the final rename were measured on native Windows 11; the packaged script ran on Linux only.
      *Accept:* `packaged-installed-download.ts` passes against an installed Windows test build.
- [ ] <!-- workspace:id=work:e9a95a12-2be9-5da1-9625-988aadeb2f12 --> The git-clone updater's tests fail on native Windows: `apps/server/src/update/update.test.ts` fails removing its test repositories (EPERM), with 5-second timeouts and one wrong count. Measured 2026-11-10 on Windows 11 with Node 24. In the code before installed updates.
      *Accept:* the file passes 10 of 10 runs on native Windows, or each test that cannot run there says why and is skipped by name.
- [ ] <!-- workspace:id=work:7f312117-5179-59b6-8fa7-9e57af5a5a21 --> Installed update on Linux is not connected: `apps/desktop/src/installed-update/` replaces the program file in its own tests, and nothing in the app calls it. The app's start has to route each launch with `decideLaunch` before anything opens the chat store, and Update and restart has to call `beginUpdate` and show its refusals.
      *Accept:* an installed Linux test build updates itself to a newer signed build; one whose new version does not start goes back to the old version with its chats; one stopped at each step carries on at the next start.
- [ ] <!-- workspace:id=work:e886e88a-5e60-577a-9089-9855fcb25032 --> Installed update: when the first record of a new update cannot be written and keeps failing (a full disk, a data folder that cannot be changed), every later start meets the same failure. Found in review of the core, 2026-11-10.
      *Accept:* a start that cannot write that record shows a page that names the folder and still lets the person start the app.
- [ ] <!-- workspace:id=work:c81a09fe-d24c-579c-b5ea-a49097f6a80b --> Installed update: a folder at a file name the update owns (`.incoming-<id>`, `.previous-<id>`) still stops the watcher with an error when it tries to delete it, and a named pipe in place of the saved copy of the chats blocks the copy back. Nothing but a person by hand makes either.
      *Accept:* each ends on the paused page that names the path, shown by a test with a time limit.
- [ ] <!-- workspace:id=work:e537e489-cf78-5f7e-9f15-1e8f6db804ca --> Installed update: the program file is checked and then moved by name, so another program of the same user could swap it between the check and the move.
      *Accept:* the move acts on the file that was checked, or the design states the limit.
- [ ] <!-- workspace:id=work:5bd68647-099d-5fd3-8daa-7a2ff0f582aa --> Installed update downloads the whole program file each time (about 90 MB). Downloading only the parts that changed would make updates smaller.
      *Accept:* a measured size for an update between two real versions, and a decision from it.
- [ ] <!-- workspace:id=work:dc5b68a0-32a1-577a-a58a-6dcc57461a2e --> No check runs an older released version's data through the current version. Chat store upgrades are tested from fixtures built by the current code.
      *Accept:* a test opens a store, settings file and profile written by each released version and reads the chats back; it runs before a release is tagged.
- [ ] <!-- workspace:id=work:4bf733c7-09c2-59b9-82e7-2a1d4ab6e964 --> Public repository: needs Ethan's explicit go for the visibility change
      ("public from the start" is the intent, not the go).
      Prepared on lane/readme: README, `docs/setup/linux.md` and the
      `pnpm shots:readme` images; the license is still open.
- [ ] <!-- workspace:id=work:fbd76a2b-2cb1-5aeb-8864-bfc67cb7bf45 --> Finetuning: scoped once benchmarks show a gap a finetune can close.
- [ ] <!-- workspace:id=work:6e7a46b5-a357-572b-b51a-e027f7b01438 --> Settings left for later (Settings council S1), each added only when
      the feature behind it exists:
      - Instructions: one home for what the model is told in every chat.
        2026-11-08: server/schema foundation implemented:
        global prompt, per-model overrides and generation controls, read-only installed
        defaults, context accounting and per-turn snapshots. The owner chose layout A;
        Instructions adds shared/model views and reply controls. Reset all clears
        these fields atomically. Existing Settings and context browser journeys pass;
        a later design iteration is expected.
      - Tools: a switch per tool, past the one switch and the list.
      - MCP servers.
      - Shortcuts: rebinding keys, and a choice of which key sends.
      - Export chats and settings.
      - Start on login, in the desktop app.
      - Image generation: choosing a checkpoint, once the workflow can switch.
      - Notes: comes back with gated memory, which needs its own approval step.
