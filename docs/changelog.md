# Changelog

## 2026-11-09: First-run memory advice

- A recommended download that uses system memory says it is slower, in both
  its introduction and tooltip.
- When the selected model cannot run at the chosen context, first run names
  that model and suggests another model or a smaller context. It no longer
  claims that none of the installed models runs or asks for a new download.

## 2026-11-09: Current memory verdicts and trusted folders

- GPU memory spells out Estimated in its sentence, keeping the available
  memory separate from the amount free after loading.
- Memory updates keep historical numbers and open Details visible while
  replacing the current verdict with Rechecking. Failed checks show a failure
  until a retry succeeds. Settings, model lists, the picker and first-run
  recommendations share this freshness state, including downloadable models.
- Opening the owned models folder rechecks that it is a real directory at the
  recorded path. A substituted symbolic link has no folder action.

## 2026-11-09: Model picker keyboard focus

- A phone's model picker keeps keyboard focus inside the sheet when a memory
  check replaces a focused model with a row that cannot be selected.

## 2026-11-08: Settings actions and live memory updates

- Opening the models folder uses the desktop app's verified ownership record,
  never a path supplied by the page. An unknown folder has no folder row or action.
- A context chosen in a chat survives reconnects and stays shared across chats
  until the app is reopened; the saved default still applies on a fresh launch.
- Memory refreshes keep the last fit visible while a new check runs, including
  the status and open Details. Late results from older checks cannot replace a
  newer result, and a failed refresh keeps the last successful report visible.
## 2026-11-09: Keep model picks while memory is rechecked

Picking a model during a memory refresh now waits for the answer instead of
losing the click. Only a fresh check can apply a model or context choice;
catalog estimates and advice kept visible after a load cannot apply it.
A refusal or check error cancels a waiting row, closing cancels it, and a
newer pick replaces it. Keyboard picks follow the same rules.

## 2026-11-09: Picker choices wait for current memory advice

Outdated memory advice now says Checking instead of Fits. Pending rows report
that they are unavailable until their fresh check arrives. A size choice waits
for a fresh answer, and a refusal requires another choice instead of applying
it later without a click. Retry after a check error still keeps the choice.
Idle models loaded by the app refresh quietly when reclaimable GPU room is
unchanged; outside allocations and busy models still withdraw old advice.

## 2026-11-09: Recheck chat memory as soon as reconnect hydration finishes

GPU Memory shows Checking after a connection drops instead of reusing an old
GPU-fit verdict while reconnecting. The open chat gets a fresh memory check
after its settings and models return, including when a slower check from the
connection's first moments is still pending.

## 2026-11-09: Keep the model picker under the pointer while checks finish

The picker reserves its list space before catalog and fit results arrive, so
it no longer jumps across the composer while you hover a model. The tooltip
delay stays in place, and a resting pointer can finish opening its tooltip.

## 2026-11-09: Running replies survive reconnect, memory details follow the chat

A second window and a reconnected window now mark replies already running,
and remove marks for replies that ended while disconnected. GPU Memory describes
the context selected for the chat, labels its actual size, and waits for a fresh
memory check before showing a verdict. Inspecting a chat's memory leaves the
saved default context alone.

## 2026-11-09: Keep fixture creation out of server readiness

Performance comparisons prepare their test data once per build and copy a
pristine database for every block. Creating thousands of durable seed rows no
longer consumes the server's readiness window. The health endpoints and their
30-second limits stay the same, and blocks keep independent data.
The concurrency fixture explicitly permits two replies, and reconnect checks
keep the thread identity across both resumed and interrupted subject versions.

## 2026-11-09: Keep performance comparisons fair in both directions

Performance comparisons now average the middle pair of round differences and
separate within-round jitter from shared drift when every round has enough
samples. Sparse rounds keep the pooled noise estimate. Concurrent-reply startup
timing now waits for visible reply text, including admission work.

## 2026-11-09: Instructions status text meets the phone reading minimum

- Loading, saving, saved and error messages share the same 14 px status
  text, including the reserved empty status slot.

## 2026-11-09: Checked memory advice stays visible after a pick

- Saving a context preserves checked verdicts when only the default-pick
  advice changes. Loading a model refreshes its memory answers in place;
  a fresh refusal still replaces the previous answer. GPU and model-file
  changes still withdraw stale advice while checking again.
- On narrow phones, Dictate gives room to the model and context control
  so Chat options remains reachable without overlapping controls.

## 2026-11-09: Reopening the size control keeps the pending choice

- Clicking the model and size control again while a fit check is pending
  leaves the chosen size visible until its answer arrives. Escape, Back and
  the close control still let you cancel.
- Model-picker tooltips open inside the active picker, while tooltips behind
  an open popover remain hidden.

## 2026-11-09: Context choices wait for their memory check

- Choosing a size while its first check is pending keeps that choice visible.
  It applies once the check fits; a refusal or failed check stays explained in
  the picker. Choosing another size replaces it, and leaving cancels it.
- The Dictate label is easier to read on phones at the same 14 px minimum as
  other secondary text.

## 2026-11-09: Context selection survives a refresh during the click

- A size control keeps its completed check if memory refreshes between the
  press and click. Successful choices still commit the size and close the
  picker. A newer refusal or failed check blocks the choice.
- Matching-context catalog reports bridge the first check, and completed
  downloads keep their 100% row until the installed list arrives.

## 2026-11-09: Picker choices agree with their memory checks

- A capped model's row and selection use the same effective-context check.
  A row without a completed check cannot bypass a refusal or start a model
  load. A displayed completed fit survives a refresh gap; a newer refusal
  still blocks the choice. Refreshing a context check keeps keyboard focus.
- Download estimates follow the context currently in view. Model-specific
  context caps are stated in each estimate, and recommendations follow its fit.
- Colliding model names show their quantization or tag. The identity suffix
  stays outside the truncated name and is included in the accessible name.
- Phone favorites are visible without hover. Favorites, maker controls,
  Back and Download have 44 px targets inside the same fixed picker frame.
  Focus wrapping skips the inactive maker rail in the context step.

## 2026-11-09: Queued messages explain a stopped first-model download

When a first-model download fails or is cancelled, its queued message now says
"Download stopped. Download a model to send this." The message stays editable
and removable, and another download restores the waiting words. A disconnect
with a retained live download still says it will send when downloading finishes.
This is derived during render; queue state and download reconciliation are unchanged.

Offline failure/cancellation replays and the connected Composer rendering checks
were watched showing the old misleading words before the fix.

## 2026-11-09: Reconnect reconciles downloads that ended while offline

A download that finished, failed or was cancelled during a disconnect no longer
stays Downloading after reconnect. A typed first-model message resumes when the
completed model appears. Live queued, downloading and verifying jobs keep their
rows, progress and Cancel controls; disconnect alone never clears them.

The typed `models.pulls` read snapshots server jobs in hydration's first batch.
Buffered progress applies afterward, completed rows still bridge installation,
and an unavailable read preserves cached rows. Seven replay cases cover missed
terminal events, first-model sends, quiet live jobs and newer progress. The stale
rows and stale progress were watched failing before the fix. RS-02 is unchanged.

## 2026-11-09: Keep newer image, update and download state across late replies

An older image-status probe no longer replaces a newer busy push, either from
Check or after saving image settings. Reconnect hydration keeps a newer update
check and does not restore a dismissed result. A pull acknowledgement timing out
after initial server progress no longer removes that progress from view.

Eight guard-specific ordering cases now cover fit/preflight freshness, model
choice, installed-model refresh, off-screen running marks, image probes, updates
and pull timeouts. Each has an explicit witness and a watched failing guard
removal. Small graphs run exhaustively; larger graphs use deterministic samples.
The runtime-retry hypothesis was checked against its serialized producer and
left unchanged. See `docs/testing.md` for scope and coverage counts.

## 2026-11-09: Make real-model smoke failures harder to miss

The smoke now refuses every endpoint except its setup's dedicated port before
making a request. Stop cannot pass by waiting for the reply to finish, and
earlier-message recall must contain a made-up word built from random syllables.
The public testing instructions describe only the setup a reader can run.

## 2026-11-09: Keep recovered sends safe through navigation

Opening Settings or visiting another thread no longer changes a recovered
message's send identity. Returning to its original thread retries that message;
sending it in another thread or editing its words creates a new identity.

## 2026-11-09: Keep uncertain sends safe to retry

- Retrying an unconfirmed send returns its saved message instead of sending
  it twice. A stalled request returns the words and attachments for retry.
- Editing a recovered message keeps the new words when the original send
  later succeeds. Pressing Enter twice while a new chat is created sends once.
- Copied paths go only to the composer and draft where the paste began.
- Updates reopen earlier chat-image databases without losing their messages.

## 2026-11-09: Check a real model through chat

An opt-in smoke now starts an isolated, cached small Ollama model and exercises
discovery, real streaming, Stop, earlier-message recall and completed-reply
persistence after server restart. Missing runtimes and models fail loudly.
Normal browser tests still use their offline stack. Product behavior and GPU
measurement stay unchanged; stopped partials remain client-session text.

## 2026-11-09: Measure repeated actions before tuning responsiveness

A separate browser performance harness now measures everyday chat actions and
large-thread, large-reply, concurrent-stream and reconnect cases. It alternates
two production builds in one job, keeps raw samples and reports each action's
noise floor. Results are informational and do not change the release verdict.

## 2026-11-09: Resume a reply after a brief connection loss

- A reply still running on the server resumes in the same page when the
  connection returns. Its words, Stop button and running mark return without
  doubling the text already received. Replies stopped here stay stopped.

## 2026-11-09: Keep replies single across overlapping sends and reconnects

- Starting a second chat while the first send is still being accepted keeps
  one reply in each chat. Queued messages continue after those replies finish,
  including when a reply finishes before its send is acknowledged.
- A joining client receives the current reply's words once. A reply that
  finishes while that client connects comes from the saved conversation.

## 2026-11-09: Measure open GPU Details through a refresh

GPU refresh checks now target the visible verdict, open Details, and measure
both the panel and Details while old content keeps their space. Retained
content is inert as well as visually hidden and excluded from accessibility,
so it cannot be focused or selected next to Checking. The desktop and phone
journeys check the accessibility tree and actual text selection during refresh.

## 2026-11-09: Keep active custom downloads and refreshing GPU details usable

An untagged custom download stays visible and cancellable when its `:latest`
model is already installed. Exact-name rows still share the installed row,
and completed downloads still settle against their installed tag. Expanded
GPU Details stays open and keeps its space while refreshing, showing Checking
in place of the previous memory report.

## 2026-11-09: Timing records no longer decide releases

- Only unit verification, the build and functional browser checks decide
  the test verdict. Timing runs separately with a fixed limit and records
  its exit and report path as information; no timing outcome is classified.
- Phone starters hold a recoverable exclusive lease through cleanup and
  listening, and re-probe a stale socket immediately before removal.
  Equal timestamps and reused inode numbers cannot remove a live listener.

## 2026-11-09: Incomplete timing runs cannot authorize a release

- Completed timing assertion failures stay advisory. Crashes, timeouts and
  missing or incomplete browser reports fail the release check. Setup,
  runtime and teardown errors cannot become advisory timing failures.
- The final remote refresh happens before tag creation, so its refusal
  leaves no local tag that would block the next attempt.
- Canceling settles after owned-group shutdown is confirmed, even when
  another session keeps an inherited output pipe open. The report discloses
  that possible survivor and retains temporary data.
- Failed publication removes only the unchanged local tag it created;
  unrelated tags and concurrent replacements are preserved.

## 2026-11-08: Concurrent phone starts preserve a live socket

- A socket inode number reused after stale-file cleanup no longer makes a
  live listener look like the old dead socket. Both the stale-file and
  after-bind checks compare nanosecond change and birth timestamps too.
- Real-socket race probes force inode reuse without changing the existing
  event ordering or widening timeouts.

## 2026-11-08: Release checks keep their blocking guarantees

- Canceling a timing check now fails the release, and cancellation waits
  for its command's descendants to stop before removing temporary data.
- Tagging checks the report's origin and refreshes main and release tags
  immediately before pushing. Focused browser tests are refused.
- Large-thread rendering, cold-load readiness and typing correctness stay
  in the blocking suite; their unchanged timing budgets run separately.

## 2026-11-08: Exited processes no longer block updates

- An exited process awaiting reaping no longer counts as running work.
  Update waits, locks and process-group cleanup distinguish zombies from
  live processes, including a group whose leader has already exited.
- A zombie main thread with a live worker still counts as running work.
- Unreadable or changing process-group membership still blocks an update.
  Parent-death checks verify the server's own stdin-EOF exit marker;
  planted live servers and group members prove actual survivors still fail.

## 2026-11-08: Releases prove a fresh clone

- A release check now installs and verifies an exact public commit in a
  clean clone, then runs the functional browser suite and size budgets.
  Its JSON report and retained failure artifacts explain where it stopped.
- Wall-clock browser checks run separately with unchanged thresholds;
  their measurements remain visible as advisory release evidence.
- Release tagging defaults to a dry run and requires a current passing
  report for `origin/main`, a matching main checkout, and a new increasing
  version. Explicit `--push` creates and pushes only that annotated tag.

## 2026-11-08: Calmer tooltips, thread actions on the row, every running reply marked

Hover tooltips wait a moment before appearing. Thread actions moved to a stable
button on each sidebar row, and the duplicate header menu is gone. GPU memory
lives in Settings. The sidebar marks every thread with a reply running, including
ones you are not looking at, and token updates no longer move row titles or
buttons. Context choices start at 8k with a 16k default.

## 2026-11-08: Keep newer settings when an older save is acknowledged

Rapid settings changes no longer let an older full-settings response undo a
newer push, including a theme change or per-model settings save. A response still
applies when no push has arrived since the request. The replay harness separates
broadcast emission from the server's later response continuation, covering two
batched broadcasts before either acknowledgement with an explicit witness.
The old code was watched publishing dark mode and setting `data-theme` to dark
after the newer light-mode push; both shared and model-save regressions now pass.

## 2026-11-08: Replay pushes before replies while hydration is held

The ordering harness now follows server broadcast-before-return guarantees for
Connect, Disconnect, foreign settings and chat admission. Each window receives
independently, with per-socket FIFO and no artificial wait for hydration release.
Start broadcasts keep their admission-time recipients across socket drops.
Larger graphs use explicit bounded deterministic sampling rather than claiming
exhaustive coverage. A planted lost Connect push passed the old schedules and
failed the widened schedules. Production behavior is unchanged.

## 2026-11-09: Reserve the server port when it starts

The desktop app now lets its server reserve a free port as it binds. Another
local program taking a briefly released port can no longer interrupt startup.

## 2026-11-09: Finish custom downloads and refresh GPU context advice

Custom downloads entered without a tag now finish when their installed
`:latest` model arrives, without leaving duplicate pending rows. GPU memory
in Settings rechecks context sizes when memory changes and shows Checking
in the previous verdict's space until the new answer arrives. Dictation no
longer triggers an old Stop press after a missed Space release, and copy
feedback follows the latest click when clipboard writes overlap. Copy
failure checks now inspect the control that was clicked.

## 2026-11-09: Replay client actions across reconnect and delayed delivery

Ordering probes now enumerate causal interleavings against two real client
sessions and one in-memory server. Speech choices, message visibility across
reconnect and Stop's reply identity are checked after each event. Failures print
a complete replay order; fake time controls reconnect without real waits.
Enumeration on older commits rediscovered three speech ordering bugs without
being told their order. See `docs/testing.md`.

## 2026-11-09: Keep unrelated settings changes from cancelling speech connection

Buffered settings pushes compare speech against the latest received address,
so a theme change after Disconnect no longer cancels a newer Connect. A second
speech change still cancels it. Reconnect snapshots reset the received baseline,
and buffered replay restores newer settings without invalidating checks again.

## 2026-11-09: Keep refused stopped sends separate from earlier replies

A send stopped before the server accepts it keeps its own reply row if
admission then fails. Earlier replies keep their identity.

## 2026-11-09: Cancel pending speech connections when a foreign save arrives

A Disconnect received during reconnect now invalidates older Connect checks
immediately, while its settings still wait for hydration. Replaying those
settings does not cancel a Connect started after the foreign save arrived.

## 2026-11-08: Controls keep their space when their state changes

- Library's Add folder, file and database controls become a path editor in
  the same row. Existing sources stay above the editor. Cancel returns to
  the original Add control, and a failed Add keeps the path and replaces
  the helper with its error.
- Model downloads keep a row for progress and completion. The completed
  row stays in its sorted position until the installed list arrives. Its
  progress bar uses the row's existing inset, and an error replaces the
  detail instead of adding a line. The picker and first-model composer also
  keep waiting through completion. Size and download details remain visible.
- Expanded GPU details keep the free-memory legend, including zero free,
  and give the estimate, GPU or system-memory use, and measurement source
  separate lines. The picker uses catalog reports for the matching context
  while fresh reports arrive.
- Image generation explains its effect before and after enabling it. Test
  keeps its label while busy, System's theme description fits on a phone,
  and a send notice uses the existing gap above the footer without moving
  the message box or covering reply actions. Its full text remains available
  on focus or hover.
- Refreshing a database no longer changes the phone path column's width.
  Library links remain available while tools are off. An uncached thread
  explains that its conversation is loading instead of briefly appearing empty.

## 2026-11-08: GPU memory stays visible while it refreshes

- Changing the default context no longer flashes Checking or closes expanded
  GPU memory details. Reopening the model picker after a load also keeps the
  verdicts it already checked.
- Reports stay visible while a new memory reading is checked. Older replies
  cannot overwrite newer readings, and a failed check still shows its error.

## 2026-11-09: Preserve speech connection choices while reconnecting

An older Disconnect push buffered during reconnect no longer cancels a newer
Connect after its save response arrives. Pushes carry their ownership through
hydration, regardless of push/response order. Foreign saves still cancel pending
connection checks.
## 2026-11-09: Retry the displayed repository and retain interrupted workers

- Leaving Library and returning no longer loses the repository behind Retry.
  Failed and cancelled clones retry their own saved URL; entering another URL
  still starts a separate clone.
- An unconfirmed Windows worker keeps its staging and import slot across app
  restarts. Git waits for its identity record to be saved before starting.
  Recovery checks a unique launch token, leaves unknown identities held and
  never kills a recovered process. Restarting Windows ends the old worker;
  restarting the app alone does not free the slot.

## 2026-11-09: Keep an unconfirmed Windows clone contained

- Cancel and Timeout check the Windows tree-kill result and worker exit
  before cleaning staging or releasing capacity. A failed or timed-out stop
  keeps its files and slot until the worker closes or the app restarts.
- The import row explains when a clone could not be stopped, while retaining
  its running state so replacement work cannot bypass the two-import limit.

## 2026-11-08: A model picker with context costs in view

- Choosing a local model now keeps makers, installed models and context
  costs in fixed columns. Search and hover update the contents without
  moving the picker. Favorites persist, model names stay readable, and
  the row metric shows estimated memory needed rather than file size.
- Real maker marks are inline and work offline, with the MIT notice in
  `LICENSES/Lobe-Icons-MIT.txt`. Milo keeps a letter mark because the
  selected set has no mark for it; unknown makers use a question mark.
- Context bars use usable memory as their scale, with a marked limit,
  dashed overflow and a text verdict. All estimates and decisions still
  come from the existing fit check. A loaded model's own allocation is
  included in its display scale, with its measured spill shown separately.
  CPU-only hosts show a figure instead of a GPU gauge and keep refusals explicit.
  The default presentation uses monochrome marks and Fits scale.
- On a phone, choose a model and then a context length. Download models
  opens the existing Download tab. The picker joins the deferred UI
  chunk; the composer retains its existing send and stop behavior.
  The picker warms after first paint and when its trigger receives pointer
  or keyboard focus, sharing the same cached import as the first open.
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

## 2026-11-08: Composer keys recover after a missed release

Releasing Enter in another window could leave the focused composer button
unresponsive to the next Enter or Space press. A fresh key press now works
even after a missed release, while holding Enter still cannot cancel the
reply it just started.

## 2026-11-08: Stop without losing a draft

Typing on a phone or editing a queued message hid Stop. A reserved status row
above the composer now offers compact Stop while the primary button is Queue
or Update, keeping the draft and the controls' positions intact.

A press stays bound to the action and reply it began on. Releasing Stop after
the reply finishes cannot send unfinished text, and holding Enter on Send
cannot cancel the reply it starts. Changing the primary action closes its old
tooltip. Clipboard fallback also focuses its temporary selection before copying
and restores the original draft selection afterward.

## 2026-11-08: One changing Send/Stop button

The composer showed Stop beside a second send button during replies. It now
uses one primary button: Send, Stop, or Update while editing a queued message.
Desktop Enter still queues a draft, and Stop's tooltip explains that shortcut.
Touch Enter stays a newline; typing during a reply offers Queue in the same slot.
The button keeps keyboard focus through state changes and ignores the second
click of Send's double-click when it becomes Stop.

## 2026-11-08: Copy buttons report the actual result

Messages and code could say Copied while leaving the clipboard unchanged.
All three copy controls now share the model-name fallback and show failure
when copying fails. The temporary selection restores focus, draft selection
and selected reply text. Desktop permission handling remains unchanged.

## 2026-11-08: Reply continuity around images and Stop

- Arriving image cards preserve the text reply, expanded thinking and reveal
  progress. Saving the reply keeps the same identity too.
- Stopped replies retain their tool-supplied link permissions after the next
  message is sent. Invented download links stay plain text.
- Prose containing a pipe stays visible. A possible table delimiter waits for
  its complete row; then the visible header becomes a table without a blank
  frame. Ordinary prose keeps appearing without waiting for a line break.

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

## 2026-11-08: Settings, second pass

- Tools rows say whether each tool is ready for the sources it can use, and
  the whole row goes to where that is fixed.
- One status style on Models and Advanced: a small dot and plain text, in
  the same words. "Should run well" until a model has really run at that
  size, then "Runs well".
- Default context is a normal row with one live line for the size chosen.
- Default context says what it does: one size for all your chats.
- Runtime can copy the Ollama address. For Gates Local's own Ollama it can
  copy and open the models folder, using the path the server really gave it.
  Its confirm starts with when the copy runs.
- Updates has one Version row with Check for updates on it, in plain words.
- Models the catalog does not know get a cleaned name above their Ollama id.
- The Default card names the model new chats really start on when yours
  won't run here. Options that would read alike show what differs, and each
  has its full id as a tooltip.
- Image generation teaches setup before the switch is on, and says Not
  connected instead of Not found.
- Instructions' loading and save-status text stays at least 14 px on phones.
## 2026-11-08: Paste privacy and messages kept through interrupted sends

- Main reads copied file paths for a trusted keyboard or native-menu paste
  and pushes them to the focused composer. The renderer cannot request them.
  Paths containing decoded C0 or DEL controls are skipped with a
  plain explanation.
- GIF, JPEG, PNG and WebP containers are checked for complete headers and
  structure, including dimensions and a 40 megapixel decoded canvas/frame
  limit, before storage. Animated PNG frame bounds, sequence and required
  frame data are checked too. Conflicting or duplicate WebP payload chunks
  are refused. This uses no image decoder or added library.
- Image context accounting uses dimensions, conservative patch geometry and
  reported maximum resize metadata instead of the earlier fixed estimate.
  A 4,096-token floor covers small or fixed-size image encoders. GPU fit,
  memory rules and Ollama GPU placement are unchanged.
- Unconfirmed text and image sends return to the composer or a visible held
  queue without overwriting newer typing. A late confirmation removes that
  copy. Saved messages keep their image files; deleting the last saved
  reference removes the file. Unreferenced uploads get 24 hours before a
  startup sweep. Failed admission collects only files it created.
- If earlier images become unavailable, the model gets a short marker and
  the reply shows a separate plain notice. Saved message text is unchanged.
  The notice also survives a later tool round dropping an image followed by
  a stopped or failed reply, including stopped words kept when switching chats.

## 2026-11-08: Paste into chat (browser acceptance pending)

- The desktop gets T3-style native editing menus, plus Copy Image, Copy
  Link and spelling suggestions where applicable. Copied file-manager
  items insert absolute paths as text without reading those files.
- Pasted images become removable thumbnails and travel through the chat
  request to Ollama. They stay with saved user messages, Retry, editing,
  queues and device-local drafts. Reloaded queues wait on hold.
- T3's image-first precedence applies to mixed text/image clips. File
  paths take priority as the owner's explicit exception. Browser file
  pastes explain when a real path is unavailable.
- Up to eight images, 10 MiB each; larger images are compressed using
  T3's quality ladder, with a 50 MiB source limit. Small images keep their
  original bytes. The authenticated socket cap is 128 MiB to carry eight
  base64 payloads; saved threads contain paths rather than image bytes.
- Earlier user images are resent while their turns remain in the context
  window. Each reserves an estimated 2,048 tokens in plain and tool turns;
  actual token usage remains Ollama's report. Generated assistant images
  are not resent as vision input. Switching to a text-only model omits
  earlier images, and attaching new images requires a vision model.
- Browser and real desktop acceptance is pending on the external runner.
  The JS bundle exceeds its existing budget; the budget is unchanged.

## 2026-11-08: Replies across threads

- Every running reply keeps its sidebar mark when another chat starts replying.
  A chat waiting behind an image says it is waiting for image generation.
- Leaving a running chat, opening a second client or reloading now restores its
  in-flight words, thinking and tool rows. A stopped or failed background reply
  keeps its partial words in the current session; a runtime switch also saves
  tool-only partials. A failed reply in a previously unopened chat keeps its
  question and earlier messages too.
- Send now interrupts its own chat and can send while another chat continues.
  Automatic queued messages still wait until the client's other replies finish.
- Picking a model already answering avoids a redundant preload. A request waiting
  for Ollama says so before thinking starts, and a memory refusal uses red.
  A send that cannot fit refuses before waiting behind another cold load.

## 2026-11-08: Steady reply streaming

- Replies now appear at a steady pace, including when tokens arrive in
  bursts. The pace adapts to delivery speed and targets a 120 ms tail at
  completion. This replaces paragraph-at-a-time reveal;
  there is one behavior and no reveal setting.
- A reply keeps the same component and Markdown blocks when it is saved,
  preserving expanded thinking. Completed blocks skip rendering.
- Image cards remain visible through reply completion. Tool-supplied and
  user-supplied links keep their permissions while text streams and after
  saving; a later tool result updates completed blocks' link permissions too.
- Incomplete emphasis and inline code render without flashing delimiters.
  Ambiguous fence starts and pipe tables wait until they can render safely;
  a table waits for its rows so its visible columns stay still.
  Code blocks do not grow a temporary blank line at their closing
  fence. Writing stays below the text until pacing finishes.

## 2026-11-08: Thinking controls

- The reply's thinking duration and chevron stay visible. The composer
  Thinking pill reveals its label on hover or keyboard focus, after Image
  and Context so they stay in place. Phones keep labelled Chat options.

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
