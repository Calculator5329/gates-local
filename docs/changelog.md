# Changelog

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
  crash leaves it behind, and it is cleared when its process is gone or
  its heartbeat stopped; a run that lost it stops before its next change.
- A cut-off update is finished by the next one. What is about to happen is
  saved before the checkout moves (`update/transaction.ts`), so "already
  on the newest commit" is not taken as done while that file is there.
  Going by where HEAD is, the next run finishes the install and builds,
  finishes going back, or, if the clone was moved by hand, leaves it.
- A timeout ends the whole process tree: SIGTERM to the process group,
  SIGKILL after 5 s, `taskkill /T /F` on Windows. Going back waits for
  that to be confirmed, and does not start if it cannot be.
- Electron arguments such as `--disable-gpu` reach the relaunch, and a
  background start now comes back with a window.
- Two "Update and restart" calls at once start one updater.
- Windows was checked by reading only: `taskkill` was tested through a
  stand-in that records its arguments, and has not run for real.

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
