# Changelog

## 2026-11-09: Preserve speech connection choices while reconnecting

An older Disconnect push buffered during reconnect no longer cancels a newer
Connect after its save response arrives. Pushes carry their ownership through
hydration, regardless of push/response order. Foreign saves still cancel pending
connection checks.

## 2026-11-09: Keep an unconfirmed Windows clone contained

- Cancel and Timeout check the Windows tree-kill result and worker exit
  before cleaning staging or releasing capacity. A failed or timed-out stop
  keeps its files and slot until the worker closes or the app restarts.
- The import row explains when a clone could not be stopped, while retaining
  its running state so replacement work cannot bypass the two-import limit.

## 2026-11-08: Preserve completed imports across registry replacement

- Completed Library content survives a corrupt registry, saving a new source
  and restarting. Empty registries and older entries without import metadata
  also preserve it. Missing registry membership never authorizes deletion.
- Remove records a durable intent before changing the registry or content.
  Startup finishes interrupted removals, including after ownership metadata
  was already deleted. Unlisted completed copies remain for manual recovery.
- Proven staging imports are cleaned even after a first-import crash with
  no registry file. Ambiguous legacy copies with content remain untouched.
- Cancel and Timeout kill the owned Git process group from the parent and
  bound settlement, so a stopped worker cannot retain an import slot.

## 2026-11-08: Preserve imports when ownership is unknown

- Startup no longer deletes imports when the source registry is missing,
  unreadable or corrupt. The retained recovery registry still points at
  content that exists.
- At most two Library imports run at once. Job history is bounded at 20,
  with failed attempts protected for five minutes so Retry remains useful.
- Ordinary browser tests always use offline import transports. A missing
  fixture stops test setup before any server starts.

## 2026-11-08: Try Library with a sample database or public repository

- Library can download pinned, checksum-checked Chinook and Northwind samples
  on a click, then use its existing read-only database snapshots.
- Public GitHub URLs can become app-owned Library folders. Clones isolate git
  configuration, disable hooks, symlinks, submodules and LFS smudge, bound time
  and size, and remove git metadata before Library can read the folder.
- Progress, cancel and retry use controls of fixed dimensions. Failed and
  interrupted imports leave no registered source; startup removes partial
  app-owned imports. Removing a manual folder still only disconnects it.
## 2026-11-09: Let the newest speech connection choice win

Connect, Disconnect, then Connect again now preserves the last choice even
when the earlier Disconnect finishes saving later. Transient save provenance
distinguishes older local completions from new actions; a Disconnect in another
window still cancels a pending Connect, including when speech is already off.

## 2026-11-08: Load voice capture when the microphone is first used

Settings and voice configuration stay outside the initial app bundle. The
microphone control loads separately, and capture code loads on the first press
while microphone permission is requested. Cancelling or leaving the draft
still releases a late microphone stream.

## 2026-11-08: Keep each dictation with its original draft and connection choice

Send, Queue, queued edits, clears and navigation now replace the draft's
identity; a pending dictation cannot land in whatever the person types next.
Ordinary typing stays in the same draft. A blocked composer cannot send a
document editing command into another focused field, and its transcript is
kept as a selectable plain line. Pending connection checks also observe saved
speech settings changes from other windows, so Disconnect stays disconnected.
The five browser journeys passed with fake audio and speech, including a
native undo/redo check that was first seen failing with the old insertion.
Real microphone capture and recognition remain an owner check.

## 2026-11-08: Keep late speech and connection results with their original action

Starting or switching a queued-message edit now cancels dictation, so a late
transcript cannot enter the wrong draft. Disconnect invalidates pending
Connect checks. Speech insertion now uses a small shared native textarea
editing helper instead of rewriting the controlled value, preserving the
browser's undo history. Non-browser race probes were seen failing before
the fixes; native undo/redo was subsequently verified with fake audio.

## 2026-11-08: Dictate into a draft with a local speech server

The composer can now record a short passage and insert its transcript at
the cursor without replacing existing words or sending the message.
Connect a running whisper.cpp server in Settings › General first. Audio is
memory-only; clips are bounded to 60 seconds and requests to 20 seconds.
Esc, navigation and disconnection release the mic and cancel late results.
Desktop permissions admit only the app's own microphone audio. Setup is in
`docs/setup/voice.md`; future sentence-streamed voice conversation is designed
in `docs/design/voice.md` and remains unbuilt. Real recognition quality
remains an owner check.

## 2026-11-08: Reverted controls no longer overwrite newer settings

- Returning a reply control to its original value removes it from the draft.
  Saving a different control then preserves a newer value saved elsewhere.
- Legacy out-of-range numbers are preserved while loading only. A later settings
  save, even a theme-only save, replaces them with their effective normalized values.

## 2026-11-08: Settings saves preserve other clients' changes

- Saving one reply control now sends only edited fields, so it cannot clear
  another client's seed or other untouched values. Incoming changes update
  untouched controls while preserving edits already in progress.
- Shared numeric limits reject impractical or overflowing new values. Existing
  files still load, with effective values clamped before use; prompts stay intact
  and the original file is not rewritten just by opening it. Any later settings
  save writes normalized values, including for untouched legacy controls.

## 2026-11-08: Instructions in Settings

- Shared instructions and per-model overrides now have their own Instructions
  section. Layout A separates All chats from Per model and keeps the existing
  Settings rows. Model selection reads installed models without loading one.
- Each model has reply controls with a default state and reset, and a read-only
  view of its installed prompt and parameters. Tooltips explain the controls and
  when saved changes apply. Save and error states reserve their space.
- Reset all clears shared instructions and every model override in one update,
  leaving the runtime choice, chats, Library and downloads alone.

## 2026-11-08: Model instructions and reply controls, server foundation

- Chats can use shared instructions or a model-specific override, while preserving
  Gates Local's built-in tool instructions. System prompts count against context;
  one that cannot fit gets a plain error before any chat request.
- Settings save per-model temperature, top p, top k, repeat penalty, seed, reply
  length and keep-loaded seconds. Unset controls inherit the model or Ollama default;
  resetting a field or model preserves other settings. Old settings files still load.
- A reply snapshots settings when its message is accepted. Editing settings affects
  later messages, including in existing threads, and never alters an ongoing tool loop.
- New additive RPCs expose per-model edits and the installed model's read-only system
  prompt and parameters. Context sizing and GPU placement stay on the existing path.
- The Settings UI is not built yet; it waits for the owner's layout choice.

## 2026-11-08: Cancel pending Settings navigation

- Escape now cancels Settings or Models before its chunk finishes loading.
  Returning to the current thread, choosing another thread or section,
  starting a new thread, opening Search, the thread drawer or GPU memory
  supersedes the old request. A late import cannot bring it back.
- Checks cover both Settings targets, competing requests settling out of
  order, and opening Settings again after a cancellation. Browser journeys
  also exercise Escape and the visible thread, Search and new-thread exits.

## 2026-11-08: Deferred screens preserve the displayed conversation

- Opening Settings or Models while its chunk loads keeps navigation on the
  displayed conversation. Both Enter and Send use that conversation until
  the requested screen is ready. A newer navigation cancels the old request.
- First run has a small eager frame from the first render; the app beneath
  it stays inert. No Server is eager too and is detected before render.
  A failed GPU import keeps a close button and a touch scrim back to chat.
- Grouping the initial graph and deferred UI separately recovers 4.21 KiB
  of the original split's 7.29 KiB overhead in a controlled build comparison.
  Separate gzip dictionaries and chunk import/export boundaries caused that
  overhead. With the correctness fixes, entry JS is 131.02 KiB and total JS
  147.10 KiB gzip. The entry limit is 133.03 KiB, the measured size plus 2 KiB
  rounded up; total stays at 170 KiB and CSS stays at 13 KiB.

## 2026-11-08: Startup JS measured separately from deferred screens

- Chat and its composer stay in the entry. Settings, including Models and
  Download, first run, and the GPU panel load on demand and warm at idle
  after first paint. A cold click keeps the chat layout until its screen is
  ready. Failed screen imports offer a plain explanation and Reload.
- The JS budget now counts the entry and every HTML script preload against
  134.43 KiB gzip, with a separate 170 KiB total ceiling. CSS stays at 13 KiB.
  Entry fell from 143.84 to 132.43 KiB; total rose to 151.13 KiB from the
  separate chunks. These are build sizes, not startup timing measurements.
- Unit probes caught eager Settings imports, omitted preload accounting,
  disabled total limits, and broken import caching, error handling and idle
  scheduling. Delayed-import and reload browser specs are written; browser
  behavior and before/after startup timings have not been run yet.

## 2026-11-08: One desktop titlebar

- The desktop window uses the app's top row for its native window controls,
  removing the extra system titlebar and duplicate brand. The taskbar title
  includes the current thread.
- Native controls follow the app's Light, Dark and System theme choices.
  The header reserves the controls' space and keeps its buttons clickable;
  browser and phone layouts keep their existing header.
- Startup and error pages keep a draggable header. Narrow desktop Settings
  keeps its Back control, drawer close stays clear of native controls, and
  switching threads in fullscreen updates the taskbar title too.
## 2026-11-08: Preserve older saved links and keep tool provenance in its turn

- Saved image replies without URL-provenance metadata retain their previous
  rendering. New successful tool steps record that metadata even when their
  output contains no URLs, so new image turns still enforce the rule.
- A tool result can approve a link only in its own reply. A later successful
  lookup cannot make an earlier fabricated download link clickable again.
- The accepted streaming window remains: an invented link can be clickable
  until the image tool queues, then becomes inert. Ordinary streaming replies
  keep their link behavior. "Your image is ready" prose can still appear beside
  the true image-status card.

## 2026-11-08: Invented image-download links stay plain text

- A mixed image/tool reply keeps its report answer and its independent image
  status card. Links in that reply are clickable only when the person or
  successful tool output supplied the complete URL in the thread. The rule
  applies while streaming, after saving, and after reloading. Ordinary replies
  keep their existing link behavior; model-written images remain labels.
- Tool-output URL provenance persists with each tool step. Model arguments
  and earlier model prose cannot approve a URL. Claims such as "Your image
  is ready" remain untouched and can still appear beside the true job card.

## 2026-11-08: One retry per image attempt, with complete mixed-tool answers

- Clicking Try again twice, or retrying from another client, now returns the
  same accepted job. The server creates its card and links it to the failed
  attempt in one transaction. The original button follows that job through
  its outcome. A failed retry can be retried from its own card.
- Only image-only tool batches end the reply. Mixed batches return to the
  model so report totals and other tool results reach the answer. The image
  result explicitly says it is queued and not made yet; the card remains
  authoritative and Markdown images remain labels without remote fetches.
- Verification: nine review probes were seen failing before the fixes;
  typecheck, lint and 1,314 unit tests pass, with one skipped. The remote
  browser retry test failed with its button fix removed, then all four
  image-request journeys passed with the fix restored. Inspected the waiting,
  making and failure captures and retry trace frames; backends were fakes.

## 2026-11-08: An image request stays visible until it finishes

- Queued images used to disappear unless they succeeded, and the model could
  follow the tool with a made-up image link. A saved chat card now shows
  waiting, making, the image, or one actionable failure sentence. Failed and
  cancelled jobs offer Try again; unfinished jobs become failures after a
  restart. The card reserves the output's space.
- The tool batch finishes after an image call, including its other tools,
  without another model request. A queue failure gets a deterministic reason.
  Model-written Markdown images render their labels without fetching or
  linking their addresses. App-saved images still use the local file route.
- Server failure logs contain the job id and error kind, without the prompt.
  The queue has a separate 30-minute timeout; the 10-minute render budget
  still starts when the GPU lease is granted.
- Verification uses fake Ollama and ComfyUI only. The real failing job's
  cause cannot be recovered from the old implementation's missing records.
  Using the bundle test's gzip method, production JS is 144.30 KiB against
  144 and CSS is 12.76 KiB against 13. The budgets remain unchanged; the JS
  excess must be resolved before landing. Browser verification on the
  designated external runner is pending.

## 2026-11-08: Settings, rebuilt page by page

- A plain nav: General, Models, Library, Tools, Image generation, Runtime,
  Advanced, Shortcuts. Memory is gone; it held nothing that worked.
- New: Tools, with a switch that really stops the model using them, and a
  row for each tool the app has. Shortcuts, listing only keys that work.
  Text size for messages and the message box. Reset settings, and on the
  desktop the data folder.
- Advanced has one Default context control. Each size says in its tooltip
  how it fits, and the GB numbers sit under Details.
- Image generation shows only its switch until it is on, then the address,
  a Test button and what ComfyUI is doing.
- Library splits files and folders from SQLite databases, says which are
  read live and which from a copy, and moves Refresh and Remove into a ⋯ menu.
- Runtime says who started Ollama and what quitting does, with one button
  to change it and a confirm that states the consequence.
- Calmer look: 6 px groups, 4 px controls, green only on small marks.
  A control that cannot work is left out instead of saying so.

## 2026-11-08: Messages that wait

- A message you typed is never lost and never sent after you removed it. A
  send the server refuses goes back to its place in its own chat's queue,
  on hold, or to an empty message box, and leaves other words in the box
  alone. Removing a queued message cancels its warning, finishing an edit
  lets the queue move, and a stopped reply's words stay when another chat
  takes over. A reply in the way that the first check missed now brings up
  the same warning (`chat.send` `askFirst`, error code `would-stop` with
  `blocking`).
- Stop means stop, and a chat stops only with your yes. Stopping a message
  that hasn't started keeps whatever was queued behind it on hold, even if
  another chat takes over before the server answers. Saying yes to the
  warning stops only the replies it named; if a different one is in the way
  by then, you are asked again (`chat.send` `stopTurns`, `BlockingTurn`
  `turnId`). "Don't show this again" still covers every chat. A message
  that waited for setup and then couldn't send now reads On hold, with
  Send now on its row.

## 2026-11-08: A Models page that is only models

- Settings › Models holds what is installed, the default for new chats, and
  a Download tab for new models. Each model's actions, Remove among them,
  sit in the row's ⋯ menu at every width. The default context size moved
  to Settings › Advanced. Character and system prompt settings left this
  page.
- When the saved default is gone, the page names the model new chats really
  start on, and "Use as default" can save it. A removal that worked stays
  finished when the next default cannot be saved; the page says so instead
  of offering a retry that cannot work. A filter that still holds text
  stays on screen after the list gets short.
- The Remove dialog stays until its removal has finished. A note about a
  default that could not be saved ends for good once a default is saved,
  and a removal no longer moves a chat that was opened or changed while it
  ran.

## 2026-11-08: Dark by default

- A new install starts dark, as the design always said (`docs/design/shell.md`),
  whatever the OS uses. Settings › General still offers Light and System. A
  theme already saved stays as it is.

## 2026-11-08: Set up with Claude Code

- `docs/setup/with-claude-code.md` is a runbook an agent can follow to set
  the app up on a new machine. `pnpm machine-check` reads the machine and
  says which model and image setup fit it, and changes nothing.

## 2026-11-08: No switch to a copy that cannot exist

- Where the app has no build of Ollama to install (Windows ARM today), the
  runtime status says so (`noAppCopy`). Settings › Runtime says it is not
  available instead of offering "Install and switch", and still offers the
  way back to the system Ollama. A copy already on the computer counts as
  the app's own, so the flag is only set when there is neither, and the
  recovery text stops offering a copy that is not there.

## 2026-11-08: Switch runtimes while Ollama is down

- Settings › Runtime offers the switch whenever Ollama is not usable, not
  only when it runs. The direction comes from the runtime chosen, so a
  system Ollama that is missing, stopped or has its port taken can be left
  for the app's own copy.
- Thinking's no-GPU start reads the GPU after held pushes replay, so a newer
  GPU answer decides it (R-02).
- Windows: `killNow` reaches a copy of Ollama that is still starting (R-04).

## 2026-11-08: The updater holds up when things go wrong

- It no longer overwrites a file of yours. The merge runs with
  `--no-overwrite-ignore`, so an ignored file the new version starts
  tracking stops the update with a sentence naming it, and nothing moves.
- One update per clone at a time, from the first look to the last rollback
  step. The lock is a file in the clone's git folder (`update/lock.ts`). A
  crash leaves it behind. Only an owner that has ended can be replaced: its
  process is gone, or that number now belongs to a process with a different
  start time. A live owner is never taken over, however quiet it has been,
  and the refusal names the process and what to do. Replacing a dead owner's
  lock takes a claim named after that exact lock, so a third run cannot
  walk in, and a claim whose holder died does not block the next run.
- A cut-off update is finished by the next one. What is about to happen is
  saved before the checkout moves (`update/transaction.ts`), so "already
  on the newest commit" is not taken as done while that file is there.
  Going by where HEAD is, the next run finishes the install and builds,
  finishes going back, or, if the clone was moved by hand, leaves it.
- A timeout ends the whole process tree: SIGTERM to the process group,
  SIGKILL after 5 s, `taskkill /T /F` on Windows. Each command that changes
  the checkout is saved with its process while it runs. If it could not be
  confirmed ended, or the updater itself was killed, later runs refuse
  until it has ended, nothing goes back beside it, and the app is not
  reopened while it may still be writing.
- Going back checks first. If the branch, the commit or any tracked or
  staged file changed while the update ran, there is no automatic reset:
  `git reset --keep` can drop a staged version. The refusal gives the steps.
- The old commit no longer counts as an untouched checkout. A merge or
  reset cut off part way (files that differ, git's `index.lock`,
  `MERGE_HEAD`) keeps the saved update and says how to get back, and the
  saved update goes only once git and the files show nothing is left.
- No command runs that a later run could not account for. If the update's
  state cannot be saved (a full disk, say), the next command does not start
  and the refusal names the cause; a command whose process number then
  cannot be saved is ended at once. `--check` names a step that is still
  running before it offers the manual path, and after a change made during
  the update the advice is `pnpm install`, then `pnpm start`: running the
  updater again could say "up to date" without building.
- Every state the updater can leave has a way out in its refusal, and the
  manual path (close the app, `git pull`, `pnpm install`, `pnpm start`)
  was run from each of them in the tests.
- Electron arguments such as `--disable-gpu` reach the relaunch, and a
  background start now comes back with a window.
- Two "Update and restart" calls at once start one updater.
- Known limits:
  - Windows was checked by reading only: `taskkill` and the start-time
    query were tested through stand-ins, and neither has run for real.
    macOS's `ps` query was tested the same way.
  - Windows can only confirm the root process has ended, so a child that
    outlived it does not hold later runs off.
  - Where a start time cannot be read, a live process number counts as
    the owner. If that number has gone to an unrelated program, the refusal
    names the lock file to delete.
  - A change made in the moment between the check and `git reset --keep`
    is not seen. `git reset --keep` also has no way to refuse writing over
    an ignored file, as the merge does.
  - An updater killed in the moment between starting a command and saving
    its process leaves nothing to wait for, so the next run does not know
    about that command.
  - A lock file that cannot be read as an owner counts as ended after 60 s.
  - A command whose process number could not be saved and that also could
    not be confirmed stopped is named in the refusal, but is not on disk for
    a later run to wait for.
  - A merge cut off after writing only brand-new files leaves nothing
    git calls changed. The retry then names those files as in the way, so
    they have to be moved or deleted by hand.

## 2026-11-08: A new default model takes effect while another is loaded

- The app's model pick now counts a model that happens to be loaded as
  room, the way an actual load does. A loaded idle model could keep a
  new default from being picked, and a new chat stayed on the old one.

## 2026-11-08: Thinking off with no GPU, Windows and size fixes

- Thinking starts off on a computer with no supported GPU, where a
  thought took 394 s on the test machine. The composer's button still
  turns it on, and a reconnect keeps that choice.
- Windows: a shutdown that runs out of time kills the app's own Ollama
  through its handle (`killNow`), since nothing could stop it afterward.
- The model catalog no longer stays empty when a newer request for it
  failed, and the next model refresh asks again.
- The first-run tooltip no longer promises a GPU on a computer with none.
- File sizes move up a unit when rounding reaches 1024: "1 MB", not
  "1024 KB".

## 2026-11-08: no context minimum

- The 16k floor is gone. A model runs at the size chosen, or at the most
  it reports when that is less (`effectiveNumCtx`, set once in the fit
  check and carried on `FitReport.numCtx` to chat, preloads and the pick).
  A model that reports no maximum runs at 4k, Ollama's own default.
- 8k joins 16k, 32k and 64k. A large model still defaults to 16k. The
  context control disables sizes a model cannot take and says
  "Runs at 2k, the most this model takes."
- A window too small for the chat drops the oldest turns; a message too
  long on its own gets a plain sentence and no request; tools that would
  take over half the window mean a plain reply with a note saying why
  (`chat/window.ts`). A small-window model is never a recommendation, so
  it cannot displace one in the download list.

## 2026-11-07: source updates

- `pnpm run app-update` (`scripts/update.ts`, `apps/server/src/update/`):
  checks for git, a clone with an upstream, the app closed (the desktop
  pid file) and no tracked changes, then fetches, picks the target and
  lists up to 20 changes or the release's notes. Local commits refuse. It
  fast-forwards, runs `pnpm install --frozen-lockfile` and builds web and
  desktop; a failed step goes back with `git reset --keep`, installs and
  builds the old commit again and says where it stopped. The result file
  in the data folder is shown once on the next start.
- Channels: the newest `v*` tag by semver once the remote has one, never
  backwards; the upstream branch until then, or always with `--channel
  main` or the new Settings switch "Get every change, not only releases".
- Settings › General › Updates: the version (read from the `.git` folder,
  no git process), "Check for updates" (only on a click), and in the
  desktop app "Update and restart", which starts the updater detached with
  its pid and quits; the updater waits for the pid, updates and opens the
  app the way it was started. New methods `update.status`, `update.check`
  and `update.dismissResult`; phones and browsers get the version and the
  check.
- Safety: every command the updater runs passes a guard that, under a test
  root (`GATES_LOCAL_UPDATE_TEST_ROOT`, and always under vitest), refuses
  any folder outside it. The tests build a bare origin, a seed and a clone
  in a temporary folder with an empty git config; e2e sets the root to its
  run folder.
- Windows was checked by reading only: `pnpm.cmd` runs through the shell,
  the wait uses `process.kill(pid, 0)`, a 2 s pause covers Electron helper
  processes, and the detached updater is a plain `node` process.

## 2026-11-07: slice 1 foundation and design round 2

- Thread store (5b475b9): node:sqlite WAL, migrations through
  `user_version`, a turn buffer that keeps deltas in memory only. A child
  SIGKILLed mid-stream leaves exactly its completed messages on disk.
- Contracts and socket (7fddd5d, 8741597): Effect Schema method and push
  tables typing both ends, decoders with named error codes, a loopback
  socket gated on the per-launch token and an Origin list. A mirror test
  fails when a module's copy of a wire shape drifts from the contracts.
- Ollama runtime (4eb5af2): reuse a healthy Ollama on 11434, otherwise an
  app-owned one on 11435 from a pinned, hash-checked v0.40.15 install;
  only a PID whose start time and command still match is ever stopped.
  Real discovery here: Ollama 0.40.4 external, 14 models.
- Chat and fit (e54cafc): explicit `num_ctx` on every request, 16k floor,
  thinking kept apart, fit verdicts that name their numbers. Real run:
  qwen3.5:9b at 16384 beside whisper, whisper 2202 MiB before and after.
- Desktop (2290627): Electron main supervises the server, token in the
  environment, a crash view with Restart; headless Electron 45 smoke
  passed.
- Server (2ce6d1d): `createApp` wires every protocol method; `main.ts`
  meets the supervisor contract. 196 tests green on a fresh clone.
- Design (a59b654, 229d293): Ethan asked for black and gray with green,
  sleek, simple out of the box; two T3 Code-shaped HTML harnesses carry
  that palette, and a council hill climb (`docs/design/council-rubric.md`)
  scores them against nine professional apps.
- Design council rounds 1 and 2 (b881380, 8f509f3, 3d60c2c, 7a4e750):
  round 1 seated Opus, Sol and Muse plus a jester; B won two seats to one
  and became `docs/design/shell.html` with 26 fixes, a first-run screen and
  a Settings screen. Round 2 (Sol alone) scored it 8 against a best
  reference of 8.5: 0.5 behind, from 1.5 behind on the same seat's scale.
  F02b-F33 are open; runs are logged in `docs/evidence/2026-11.md`.

## 2026-11-07: scaffold

Promoted from the maintainer's private planning folder. pnpm workspace with
`apps/desktop`, `apps/server`, `apps/web`, `packages/contracts` and
`packages/harness`; `pnpm verify` runs tsc, oxlint and vitest, exits 0 clean
and 1 on a planted type error or lint error (both checked).
