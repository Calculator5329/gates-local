# Roadmap

Transplanted from the incubator seed roadmap on 2026-11-07. Items run in
order; `AGENTS.md` names the owns paths. Every "whisper unchanged" check
compares its PID and VRAM before and after, and the fake runtime's call log
never shows a whisper stop, start or restart.

## Now: slice 1, desktop chat and models

Known limit: reloading in the seconds while a send is being accepted can lose
that message. Keep the message recoverable across that reload in a future pass.

Follow-up: Ignore pasted images that finish loading after the draft is replaced.
Follow-up: Remove a confirmed retry from background replies so it no longer looks active.

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
- [x] <!-- workspace:id=work:92903769-ac74-5c41-8bf8-51fcebae0efb --> Thread store: SQLite WAL, completed messages persisted, token deltas in
      memory only.
      *Accept:* kill the server mid-stream; after restart the thread has every
      completed message and no partial one.
      *Done 2026-11-07:* 5b475b9; the SIGKILL accept test is in the store suite.
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

- [ ] Packaged renderer Origin: measure what Origin the `file://` renderer's
      WebSocket upgrade carries in a real packaged Electron run and allow it
      in `apps/server/src/main.ts`.
      *Accept:* the packaged app connects; a page from any other origin
      still gets 403.
      *Status 2026-11-07:* measured `Origin: file://` (403) in a real
      unpackaged dist run, so the client moved to its own scheme,
      `gates-local://app` (`apps/desktop/src/client-protocol.ts`). In that run
      the app's upgrade got 101 and `file://`, `null`, `http://evil.example`
      and `gates-local://other` got 403. The packaged half waits on packaging.
- [ ] First-run model pick on real models: `chooseModel()` takes the smallest
      installed model, so on this machine the first run recommends
      `nomic-embed-text` (an embedding model, `/api/show` capabilities
      `["embedding"]`) as "the best model for your GPU", and `verdictOf`
      labels its 2048-token context refusal "Not enough memory at 16k".
      *Accept:* an embedding-only model is never picked or offered for chat;
      the pick is the best installed chat model that fits; a context-limit
      refusal names the limit; an E2E with an embedding model installed.
- [ ] App-owned models store: `/var/lib/ollama` is read-only to this user,
      so an app-owned Ollama cannot see or pull into the system models.
      Pick `OLLAMA_MODELS` for the owned server and show it in settings.
      *Accept:* with the system Ollama stopped, the owned server pulls a
      model into the app folder and the picker lists it.
- [ ] `AppErrorCode` (turn-active, runtime-not-ready, wont-fit, cancelled,
      shutting-down) moves from `apps/server/src/app.ts` into
      `packages/contracts` so the client switches on a typed code.
- [ ] Fit with two loaded models: `/api/ps` reported 5.92 GB where the
      runner held 6926 MiB (e54cafc). Measure the two-model case before the
      fit check trusts `/api/ps` for more than one runner.
- [ ] Fit gate when the GPU is unreadable: today a `gpu-unreadable` report
      blocks the send. Decide block or warn from a measured failure mode,
      and put the reason in the refusal text.
- [ ] Owned Ollama port: 11435 is fixed; take it from an environment knob
      when 11435 is busy with another service.
- [ ] Stopped replies (turns/queue lane, from the runtime-fix04 review,
      R3-02 and R4-06): a reply cut by a runtime switch or a preemption is
      saved with its text and thinking, but nothing stored marks it stopped
      (the stopped code is only on the chat event), and its tool steps are
      not saved. `endHalted` in `apps/server/src/app.ts`.
      *Accept:* a reloaded thread shows the cut reply as stopped, with the
      tool steps it had sent.
- [ ] Shutdown order (turns/queue lane, runtime-fix04 review R2-03):
      `apps/server/src/main.ts` exits by force after 2.5 s, but
      `image.close()` can wait up to 15 s for a ComfyUI stop already under
      way, and the app-owned Ollama is stopped only after it, so a slow
      ComfyUI stop skips the Ollama cleanup. Run that cleanup first or
      alongside, behind a shutdown sequence a test can drive.
      *Accept:* with a ComfyUI stop held, the owned Ollama is still
      stopped before the forced exit.
- [ ] Cancel a turn that waits for the GPU: a turn queued behind an image
      job holds no claim yet, and Stop only aborts once the claim lands.
      *Accept:* a test queues a turn behind a held image claim, presses
      Stop, and the turn ends cancelled with the image job untouched.
- [ ] Windows process trees: `child.kill()` leaves Ollama's runner
      children alive on Windows. Kill the tree (`taskkill /T`) through the
      runtime's spawn seam. *Accept:* on the Windows test machine, stopping the app-owned
      Ollama leaves no `ollama*.exe` process.
- [ ] Thinking pill follows the model: add `ModelInfo.capabilities` from
      `/api/show` and grey the pill out for a model without "thinking"
      (the server already drops `think` for those, 24877a4).
      *Accept:* picking gemma3 greys the pill; picking qwen3.5 lights it.
- [ ] Tools default reaches the turn (439a230): an E2E that sets Tools off
      in Settings and sees a turn with no tool definitions in the request.
- [x] `think` on a model without thinking: run 2026-11-07 on the real
      runtime, HTTP 400 `"gemma3-abliterated:12b-q4" does not support
      thinking` in 18 ms, nothing loaded (evidence log).
- [ ] A shell over its cap must not look like a low-memory desktop: every
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
- [x] Source updates for a git clone: `pnpm run app-update` (`--check`,
      `--channel main|release`) and Settings › General › Updates (version,
      a check that runs only on a click, "Update and restart" in the
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

- [ ] Tier table (`setup/tiers.json`): the best text and image model per
      hardware tier (NVIDIA by VRAM, no GPU by system memory), dated.
      *Accept:* every entry names its source, download size, memory at 16k
      and license; the research behind it is in `docs/research/`.
- [ ] `pnpm setup:probe`: device facts as JSON (OS, GPU vendor and memory,
      system memory, disk free, CPU, Ollama and ComfyUI found, models
      installed).
      *Accept:* fixtures for NVIDIA 16 GB with whisper, NVIDIA 8 GB, no GPU
      with 16 GB and no GPU with 8 GB; real runs on the maintainer's Linux machine and the Windows test machine.
- [ ] `pnpm setup:plan`: the text model and context, the image model or
      none, the downloads and their sizes, each with a plain reason.
      *Accept:* each fixture gets its tier's picks; a plan never exceeds the
      measured free memory.
- [ ] `pnpm setup:apply --yes`: Ollama, models and (when chosen) ComfyUI
      and image weights through the app's own install paths, resumable,
      with progress; refuses without `--yes`.
      *Accept:* with fakes, every step in order; a killed run resumes.
- [ ] `setup/` folder: `AGENTS.md` (run, show, ask, apply, check, report),
      `CLAUDE.md` pointing to it, `README.md` for the manual path.
      *Accept:* a fresh agent on the Windows test machine told "look at this folder and set me
      up" gets a working app with only the user's yes; transcript in
      `docs/evidence/`.
- [ ] Settings shows the same plan with no agent, and a "Set up with an AI
      assistant" line with the folder path and the sentence to say.
- [ ] Every model name the app offers for download is a real, pullable
      name. The research (`docs/research/setup-tiers-2026-11.md` §1.1)
      found `qwen3.5:14b` does not exist (in `docs/design/shell.html`,
      `packages/contracts/src/testing.ts` and lane/build-runtime's
      `runtime/recommended.ts`), and three of Ethan's models are local
      aliases that fail on any other device.
      *Accept:* the download catalog is read from `setup/tiers.json`; a test
      fails on a catalog name that is not in it; tier entries store the
      pullable name (`hf.co/...:QUANT` or `namespace/name:tag`), never an
      alias.
- [ ] Fit estimator counts implicit sliding-window layers. `/api/show` for
      gpt-oss and Gemma 3 names a window but no pattern, so `fit/estimate.ts`
      counts every layer as full: gpt-oss:20b computes 15.67 GB at 16k
      against 13.0 GB measured at 32K on a T4 (research §0.6), which wrongly
      refuses it on a 16 GB card.
      *Accept:* per-architecture default patterns (gptoss 1:1, gemma3 5:1)
      with fixture tests; one real load of `gemma3-abliterated:12b-q4` at
      16k on this machine within 10% of the estimate.
- [ ] No-GPU plans turn thinking off by default (qwen3.5:2b took 4 min 37 s
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
- [ ] Release gate: after a step exits normally, stop its owned process group
      and keep the scratch directory if shutdown stays unconfirmed.
      *Accept:* a step that leaves a same-group process behind gets it stopped.
- [ ] Packaged releases (AppImage, Windows installer, auto-update) once
      Ethan picks that path. `pnpm run app-update` covers git clones only;
      a packaged copy says it cannot update itself.
- [ ] <!-- workspace:id=work:4bf733c7-09c2-59b9-82e7-2a1d4ab6e964 --> Public repository: needs Ethan's explicit go for the visibility change
      ("public from the start" is the intent, not the go).
      Prepared on lane/readme: README, `docs/setup/linux.md` and the
      `pnpm shots:readme` images; the license is still open.
- [ ] <!-- workspace:id=work:fbd76a2b-2cb1-5aeb-8864-bfc67cb7bf45 --> Finetuning: scoped once benchmarks show a gap a finetune can close.
- [ ] Settings left for later (Settings council S1), each added only when
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
