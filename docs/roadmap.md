# Roadmap

Transplanted from the incubator seed roadmap on 2026-11-07. Items run in
order; `AGENTS.md` names the owns paths. Every "whisper unchanged" check
compares its PID and VRAM before and after, and the fake runtime's call log
never shows a whisper stop, start or restart.

## Now: slice 1, desktop chat and models

- [x] Scaffold the pnpm workspace (`apps/desktop`, `apps/server`, `apps/web`,
      `packages/contracts`, `packages/harness`) with `CLAUDE.md`, roadmap,
      changelog and `pnpm verify` (typecheck, lint, unit tests).
      *Accept:* `pnpm verify` exits 0 on a fresh clone and non-zero on a
      planted type error.
- [ ] Contracts: one WebSocket, typed RPC and push channels, Effect Schema
      decode at both ends.
      *Accept:* a malformed message is refused at the boundary with a named
      error; round-trip tests cover every channel.
- [ ] Thread store: SQLite WAL, completed messages persisted, token deltas in
      memory only.
      *Accept:* kill the server mid-stream; after restart the thread has every
      completed message and no partial one.
- [ ] Runtime discovery: reuse a healthy Ollama; start an app-owned one when
      none answers; never adopt or stop a service the app did not start.
      *Accept:* `pnpm verify:chat` covers existing, stopped, missing and
      wrong-service-on-port with fakes; one real run finds this machine's
      Ollama.
- [ ] Own-folder Ollama (D1): get a pinned version into the app folder, check
      its hash, run it without root or a package manager.
      *Accept:* with Ollama off PATH, first launch installs and runs it; a bad
      hash refuses with a usable message and leaves nothing half-installed.
- [ ] Model list from the runtime, refreshed on focus; no settings step
      before the first chat.
      *Accept:* a model pulled in a terminal appears in the picker without a
      restart.
- [ ] Electron main supervises the server; a server crash shows a restart
      control, not a blank window.
      *Accept:* killing the server process shows the error state; restart
      brings the thread back.
- [ ] First turn: streamed reply with explicit per-request `num_ctx` (16k
      floor) and a fit check against measured free VRAM with whisper running.
      *Accept:* a real streamed reply on this machine at 16k, whisper
      unchanged; when no model fits 16k, a refusal names the shortfall.

- [ ] Visual direction: round 1 of twelve GPT-image directions, Ethan's
      picks, round 2 of many screens per kept direction, then tokens in
      `apps/web`.
      *Accept:* Ethan names the direction; a tokens file and the restyled
      shell land, checked against the picked mockups.

## Next: slices 2 to 4

- [ ] GPU lease: one app-owned heavy job at a time; chat, image, bench and
      dream each ask for one.
      *Accept:* `pnpm verify:gpu`: a second job waits; cancel and a crashed
      job both release the lease; whisper absent from the call log.
- [ ] Fit and spill: measure free VRAM, then show RAM spill per model at
      16k, 32k and 64k in the picker.
      *Accept:* the numbers come from a measured load on this machine; an
      oversize job is refused, never attempted.
- [ ] ComfyUI opt-in: discover or start the local install, unload app chat,
      run one image, restore chat.
      *Accept:* `pnpm verify:image` with a fake; one real image on this
      machine with progress, cancel, chat restored and whisper unchanged.
- [ ] Image presets measured in the room left beside whisper; a smaller
      preset or a refusal when the room is short.
- [ ] Turn loop in `packages/harness` (D3): pi's loop shape, a length stop
      fails every pending call, format-error budget, head/tail elision.
      *Accept:* `pnpm verify:tools`: a truncated call never runs; three bad
      calls in a row end the turn with a message; a 50k-character output
      reaches the model as 5k head plus 5k tail.
- [ ] Text-call parser for models without native tools, skipping anything
      inside `<think>`; input repair ("20" to 20, bash to shell).
      *Accept:* recorded transcripts from the qwen and gemma families parse;
      a call inside `<think>` never runs.
- [ ] Four tools (`shell`, `read`, `note`, `image`).
      *Accept:* the measured tool block stays under 1,000 tokens.
- [ ] Sandbox: bwrap with a tmpfs root, read-only `/usr`, `VACUUM INTO`
      snapshots at `/data`, no home, no network.
      *Accept:* `WITH … DELETE`, `PRAGMA user_version=7`, a write under
      `/data`, a read of `$HOME` and a network call all fail; a SELECT
      returns rows.
- [ ] Sources (D2): the docs library plus databases Ethan adds; snapshot
      refresh and freshness on screen.
      *Accept:* a snapshot of a live WAL database under concurrent writes is
      consistent; a fresh install connects nothing personal.
- [ ] Context accounting: fixed prefix, a reserve for the reply and a
      summary, compaction at the selected window.
      *Accept:* a 16k thread that crosses its budget compacts and continues;
      the prefix bytes are identical across turns.

## Later: slices 5 to 7

- [ ] Benchmarks: speed, tools and sql suites through the real turn code,
      recording model digest, runtime version, profile and harness revision.
      *Accept:* `pnpm bench:local --suite speed,tools,sql` writes a result
      file; a rerun on the same digest lands within the stated noise.
- [ ] SQL choice: 30 to 50 questions, shell sqlite against the GatesAI typed
      query control on the same models; keep the winner, record the numbers.
- [ ] Day-one defaults (model, window, profile) chosen from benchmark
      results, never from download size.
- [ ] Gated memory (D4): "remember" saves a note with its source quote;
      `note` proposals wait for approval.
      *Accept:* `pnpm verify:memory`: a rejected proposal leaves notes
      unchanged; an accepted one keeps the prior version.
- [ ] Dream pass on an idle app queue: note corrections as a proposed diff,
      never a live edit.
- [ ] Installed handoff: Linux AppImage against real Ollama and ComfyUI,
      selected models ready, whisper unchanged through success and failure.
      *Accept:* `pnpm release:smoke` on this machine plus a try-it packet for
      Ethan. Packaging does not authorize a release or publication.
- [ ] Public repository: needs Ethan's explicit go for the visibility change
      ("public from the start" is the intent, not the go).
- [ ] Finetuning: scoped once benchmarks show a gap a finetune can close.
