# Roadmap

Transplanted from the incubator seed roadmap on 2026-11-07. Items run in
order; `AGENTS.md` names the owns paths. Every "whisper unchanged" check
compares its PID and VRAM before and after, and the fake runtime's call log
never shows a whisper stop, start or restart.

## Now: slice 1, desktop chat and models

*2026-11-10, picker warms on intent and thread measurements:* The picker
keeps its complete-first-view barrier and warms its fit cache only on hover,
keyboard focus or pointer-down, never at idle, while a reply runs or while a
model loads. After a reply, focus-then-Enter opens in 40.45 ms instead of
292.73 and a hand click in 120.63 instead of 287.20, both faster over 4 rounds,
with the same fit-check count as before in every measured session. A scripted
click with no hover first still waits about 293.38 ms for its checks; making that
case fast needs a product decision (faster checks, or opening on the previous
reading). A hover that leaves without opening costs one warm (5 checks).
Broad thread-open rows end at the first screen and retain full-fill `-mounted`
twins; old release reports used the full fill for the plain rows and are labeled
accordingly.

- [ ] <!-- workspace:id=work:bd43faf2-3ad7-5ce0-a367-796c4579aea1 --> A click on the model button with no hover first still waits about 293 ms for its fit checks. Each check reads the GPU again on the server.
      *Accept:* the checks for one opening share one GPU reading, or the picker opens on the previous reading and corrects itself without rows swapping, with the scripted-click row measured faster.
- [ ] <!-- workspace:id=work:a685bc32-2449-5e0b-8625-2a38dfb08221 --> The page's record of which models are loading is never reset on reconnect. A "ready" message lost across a reconnect leaves a model shown as loading, and the picker then never warms for the rest of the session (it still opens, as slowly as before). In the code before the picker warm-up.
      *Accept:* a reconnect reads the load states again, shown by a test that drops the ready message.

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

- [ ] <!-- workspace:id=work:ba90d67f-9fcc-5806-b1b8-66998aaf2d92 --> Tooltip layer closes an open tooltip when its target's `data-tip` changes

- [ ] <!-- workspace:id=work:835820d7-09e1-5ef8-ae5d-e027a7d3613e --> Phone drawer: the New thread button's centre sits about 8 px left of the close button above it and about 4 px left of the thread rows' menu buttons. Line the three up.

- [ ] <!-- workspace:id=work:d6f9ccae-85c3-5fbb-8144-9701313e3fcf --> Show each model's measured speed on the installed-model rows in Settings › Models and on the model picker's rows (the data and the small component landed 2026-11-11; nothing renders it yet). The browser spec should then read the number from the row, with a fixture that sets its own token count.
- [ ] <!-- workspace:id=work:b7c16486-811b-5ff4-b102-bbbcae47de41 --> A model's measured speed can stay on a page left open past the 14-day window with no chat in between; it corrects on the next finished reply or reload. Drop it on time without a polling timer (for example when the window is shown again).

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
- [ ] <!-- workspace:id=work:8775fff1-7abd-5633-b650-d73e80993fc9 --> Windows process trees: `child.kill()` leaves Ollama's runner
      children alive on Windows. Kill the tree (`taskkill /T`) through the
      runtime's spawn seam. *Accept:* on the Windows test machine, stopping the app-owned
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
- [ ] <!-- workspace:id=work:6327fe6f-c001-5916-aa4c-7e9fdd2bad6c --> Image fit rereads free VRAM immediately after unload in `image/module.ts`; delayed reclamation can produce a false refusal.
      *Accept:* hold VRAM reclamation after a successful unload and wait within a bounded read loop before refusing.
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
- [ ] <!-- workspace:id=work:3d565764-5f08-5010-9dd5-4ff0df759b71 --> Replace routine five-second journey warnings with the whole-suite budget; `budget-reporter.ts` still prints both after the suite trim.
      *Accept:* one complete-run report identifies budget overruns and expensive setup without per-journey warning noise.

## Later: slices 5 to 7

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
      Ethan picks that path. `pnpm run app-update` covers git clones only;
      a packaged copy says it cannot update itself.
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
