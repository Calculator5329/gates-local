# Testing

## Fast default browser run

`pnpm e2e` builds the client and runs the complete one-worker `e2e` project.
Explicit selections such as `pnpm e2e first-run.spec.ts` retain the ordinary
Playwright command and admission checks. The release check uses the same
complete project. A two-worker experiment did not qualify for adoption;
acceptance requires two passing runs with isolated backends, and unchanged
quick selection, evidence retention and admission behavior.

The sample database and Git repository are prepared once per backend, while
application data, import failures and retries still start fresh for every
journey. Performance and native clipboard tests remain serial.

Set `GL_FLICKER_MEASURE=1` to include the six broad flicker recordings and
two state-swap surveys. Their probe-liveness checks are diagnostic; ordinary
journeys retain Library mutation, refresh/error/cancel geometry, restored
focus and queued-editor geometry. All dedicated zero-Checking-frame,
zero-layout-shift, tooltip-overlap and native-control hit-target checks stay.
Set `GL_E2E_RECORD=1` for passing-run video and full chunk traces. Failure
traces and explicit screenshots remain available by default.

Journey durations above five seconds warn. Above ten seconds, add a
`budget` annotation explaining the necessary work. Missing explanations
also warn; they never fail the run. The full default command warns above
six minutes including build and teardown. Logs separate backend reset,
page load, ready and teardown steps; the remainder includes actions,
framework and browser setup. Explicit diagnostic recordings are excluded
from journey warnings.

## Test trim coverage ledger

- Spellcheck remains in the complete window-security options assertion.
  Package resolution is exercised by substantive imports and typechecking.
  The obsolete dock-selector ban and standalone host-home existence check
  were retired; actual sandbox home-read refusal remains.
- Contract negative type examples remain compile-only. Runtime unknown
  methods, bad channels, malformed parameters and garbage are still checked
  by the codec boundary tests. The unused fit-label alternatives were already
  removed before this trim; current fit wording is retained.
- Clipboard exact user/reply/code text, sentinel replacement and feedback
  share one journey per restricted API mode. Native clipboard permission,
  backward selection and failure behavior retain their own browser checks.
- First-model recommendation shares download/cancel/resume/send setup.
  Small-model chat, real loaded context, unsupported sizes, Settings wording,
  saved defaults and oversized-message refusal share a journey. A held
  terminal frame preserves the Settings-open completion race.
- Phone modal focus/inert/Tab/Escape checks share setup with close and swipe
  checks. Code overflow/copy targets, table columns and link wrapping share
  one journey per width. The decorative spacing and trash-symbol assertions
  were retired. Actual switch hit targets and the readable-text sweep stay.
- Tooltip rest delay, pass-through suppression, immediate handoff, keyboard
  focus, click dismissal and popover suppression share two journeys. Their
  real absence observation windows remain. Theme persistence and Library
  cancelled/failed retry branches share setup without dropping assertions.
- The dedicated voice Disconnect/Connect race and Stop acknowledgement race
  leave the browser. Their cases remain in session/voice tests and ordering
  replay. Normal microphone, track-release, cursor and Undo/Redo journeys stay.
  The React-children identity browser check is redundant with retained
  Markdown unit coverage; real DOM continuity/disclosure journeys stay.
- Speech timeout recovery receives the backend's error at the RPC boundary;
  the real deadline is still checked in the voice module tests. Export
  timeout uses the browser clock and releases the late response before
  checking for an unwanted download. Load/GPU/frame and request-settlement
  conditions replace setup sleeps. Pacing still requires over fifty real
  intermediate rendering frames with no raw Markdown.

Three new diagnostic boundary probes exercise main's registered privileged
IPC handlers, the 8 MiB runtime HTTP ceiling and the speech response ceiling.
Both accepted and rejected inputs are checked, including connection close
and speech-slot reuse. Each failed with its guard deliberately disabled
and passed after restoration: unconditional IPC authorization, and an
infinite limit for each response. These probes supplement existing gate
evidence; they are not independent reviews of the boundaries.

The historical supervisor-parent-EOF, phone simultaneous-start and updater
timeout-cleanup failures did not reproduce in the full remote unit run at
the starting revision. No product change was needed for those failures.


## Opt-in real-model smoke

On an authorized Linux x64 CPU test runner, run:

```sh
GATES_REAL_SMOKE=1 node test/e2e/real-smoke-run.ts
```

The setup caches the checksum-verified pinned Ollama and `smollm2:135m`
(about 271 MB) in a dedicated user cache, serves it on port 16195, and stops it
at the end. First setup downloads the runtime and model once; warmed runs reuse
both without a pull.

`pnpm e2e` excludes this spec by default. `GATES_REAL_SMOKE=1` selects only this
journey and starts no fake stack. An absent runtime or model fails loudly.
To watch the missing-model failure, add
`GATES_REAL_SMOKE_MODEL=smollm2:missing-smoke-model` to the setup command.

The built client and production server exercise real model discovery, unchanged
fit, progressive tokens, Stop, recall of a random made-up word from the earlier message,
and restart persistence. No GPU measurement override or `num_gpu` is supplied;
the existing no-GPU path admits a small model as a system-memory spill. Stopped
partials remain in the current client session only; restart checks the completed
reply. Retain `real-ollama.log` and the browser screenshot, trace and
`evidence.json`. This new diagnostic probe does not establish GPU or Electron
behavior.

Only the setup's fixed endpoint is accepted, before any request. Stop must produce
a cancellation before natural reply completion. Context checks accept a reply
that contains the six-syllable word, including an echo of the earlier prompt.

## Informational browser performance

`pnpm build` and the blocking performance spec share the hard gzip
limits in `test/bundle-size.ts`: entry JS below 133.03 KiB (including HTML
preloads), all emitted JS below 170 KiB, startup CSS below 13 KiB, and total
CSS below 15 KiB. Startup CSS comes from stylesheet and style-preload links
in the built HTML, with each request URL counted once, not from a filename
pattern. Different query strings count separately; fragments do not.
Total CSS sums every emitted stylesheet, including deferred screens. The build
prints each reading and fails with the overage. No timing measurement enters
this gate. The package-level web build still emits an over-budget bundle for
measurement; the root build, blocking browser spec and comparison refuse it.

Picker-only styles load with its dynamic import. Settings and first run still
warm after first paint; the picker warms only on pointer/focus intent or open,
so idle warming does not fetch its stylesheet. Vite waits for that stylesheet
before resolving the picker module. A failed CSS or JS asset reaches the same
reload screen, whose frame remains in startup CSS. Deferred selectors are
picker-scoped; their phone overrides follow their base rules, and loading the
sheet does not restyle chat or Settings after the picker closes.

`test/perf/` is a separate Playwright project, excluded from `pnpm e2e`.
Timing is informational and never changes the release verdict. Candidate size
overages fail the comparison after its measurements are saved. On an authorized
browser machine, one command builds two commits and alternates them in one job:

```sh
pnpm perf:compare BASE_COMMIT CANDIDATE_COMMIT --rounds 5 --samples 3 --out perf-results
```

For a runner without Git history, prepare inputs locally without a browser:

```sh
pnpm perf:compare --prepare BASE_COMMIT CANDIDATE_COMMIT --out perf-inputs
```

Submit this tree, including `perf-inputs`, with **exclusive** access and a
900-second timeout. The command inside the browser job is:

```sh
pnpm perf:compare --prepared perf-inputs --rounds 5 --samples 3 --out perf-results
```

Fetch `perf-results`. Freeze the tree until the runner captures it, then archive
`perf-inputs`; never commit them. Always use a fresh output directory: run records
are never replaced. `--self` compares the prepared base with itself. A shorter
diagnostic uses `--rounds 4 --samples 2`; its eight-sample p95 is usually the
maximum, not a precise tail estimate. Keep each job under 15 minutes.

Journeys cover ordinary chat, picker and Settings actions, 200/2,000-message
threads, a 4,000-line code block and 300-row table, a 400-thread sidebar,
concurrent streams and reconnect. Image paste is unsupported at this version.
No production hook is used. Reconnect measures a usable composer after a drop;
the visible stream is interrupted while the server may finish saving its reply.

Each arm also measures first-run readiness in fresh contexts with HTTP cache
disabled, using the same browser probe and paired-round noise calculation.
These samples live separately in each round's `first-run.json`; analysis adds
them without rewriting the original journey record. A first-run screenshot is
retained for the candidate's first round.

Cold means a fresh context with HTTP cache disabled and a warm fixture server.
Input timestamps through the target DOM state and two animation frames bracket
a paint opportunity, not physical display latency. Setup and assertion polling
are excluded. Typing also records dispatch delay. Stream metrics record each
window's frame-gap p95/maximum and count/total time of tasks over 50 ms. Mixed
stream completion starts after first visible text; concurrent frames cover the
confirmed overlap until either running marker clears.

The existing fake waits 40 ms before tokens, then 8 ms per eight-token burst,
with Thinking off and zero model-load delay. Longer Markdown for typing,
concurrent streams and reconnect uses 12 ms per four-token burst. Tokens are
whitespace pieces. Model inference and GPU speed are outside this baseline.

Each `round-N-ARM/run.json` contains commit, action, unit, samples, median, p95,
browser version, CPU count, memory and load before/after, without names,
addresses or paths. `comparison.json` and `comparison.md` show AB/BA paired-round
changes. Noise is the larger of p95 changes between adjacent same-build round
medians and the sum of both builds' p95 sample deviations. Deviations use each
round's median only when every round has at least three samples; otherwise they
use each build's pooled median. The minimum is 2 ms or one count. A paired-round bootstrap supplies a
descriptive 95% interval. A signal must exceed that floor and have its interval
on one side of zero. Noise over 20% of baseline and 10 ms/one count is marked
too noisy for small changes. This is screening, not a significance test.

To improve a number, keep fixtures and fake speed fixed, commit the change,
compare it with its parent in one exclusive job, and inspect samples, load,
noise and other actions for tradeoffs. Repeat noisy findings with more rounds.
Unit tests are diagnostic probes; also check a real self-comparison and an
unlanded commit with a real delay before trusting a change in the tool.
After an analysis correction, `--analyze SAVED_COMPARISON --out FRESH_DIRECTORY`
recomputes from the original round files without rerunning browsers or
overwriting either the raw measurements or the earlier analysis.

Later release wiring: after existing correctness checks, prepare the previous
released commit and candidate, run this comparison as an exclusive browser job,
and attach its artifacts and exit code to the release report. A slower signal
is informational; a tool failure means measurements unavailable. Neither changes
the release verdict. No release script is changed here.

## Client ordering replays

`pnpm test` includes in-memory ordering replays for speech connection choices,
messages crossing a reconnect, and Stop pressed around a send acknowledgement.
They run two real client sessions against one scripted server, without a browser,
real socket, microphone or wall-clock waits. The production session and store
need no test seam. React supplies only non-rendering hooks for the speech buttons.

To add a scenario, describe what the person does, what the server can deliver,
and what must stay true. Add named events in
`apps/web/test/ordering-replay.test.ts`, with `after` constraints only where the
code requires an order, with a short source comment for every edge. Keep the
chosen button sequence separate from transport guarantees: it defines the input
story, not a rule about delivery. The scripted server
captures settings at the write and snapshots at the read, not at delivery.
Check the visible message, connection choice or intended reply after each event.

Settings broadcasts happen in `settings/handlers.ts` before the handler returns;
`ws/server.ts` awaits that return before sending the response. Schedule each
window's push independently. The sender's push precedes its response on its own
socket, while the other window may receive before or after either. Connect,
Disconnect and foreign theme saves all follow this rule. Both Connect deliveries
can happen while hydration is held. There is no dependency on hydration release.

Broadcast emission and response emission are separate events. Installed
`ws.Receiver` can dispatch two requests from one input buffer before either
`await handler(...)` continuation runs. Thus two writes may broadcast twice,
then emit their two responses. The harness models the server continuation queue
separately from each socket's FIFO; it never queues a response at write time.
The same separation applies to chat admission and its acknowledgement.

Each producing event declares its emitted frames. The scheduler preserves FIFO
per socket, including across successive writes. Server completion and response
delivery are separate events for health checks and the held hydration request.
The speech scenarios start with A reconnected, a settings snapshot already
captured on the server, and hydration still in flight. That is their initial
condition, not exhaustive coverage of actions before that reconnect.

Chat admission stores the user row and broadcasts start before returning
(`app.ts`). Start therefore precedes the response on the sender's socket. Other
recipients are independent. A start is sent only to sockets open at admission;
it is never redirected to a replacement socket. Closed sockets drop their queued
frames. Stop and the following Send do not wait for acknowledgements, and two
chats' admissions may finish in either order.

Graphs with at most 64 legal orders are exhausted. Larger shipping scenarios
run 64 unique deterministic schedules each: required regression witnesses, a DFS
witness, witnesses that delay each event in turn, then fixed-seed priority samples. The original seven product
scenarios all exceed 64 orders, so their 448 executed schedules are **not
exhaustive**. Required witnesses count inside that budget and are checked against
causal constraints and FIFO. A separate RP-01 regression explicitly delivers two
settings pushes before either response; it adds one executed schedule. The
reusable `schedules` utility still defaults to a 256-order
DFS prefix; `explore` selects the sampled policy used by `replay`. Both report
their coverage honestly and stop on the first invariant failure.
Bootstrap, preflight and unrelated sample RPCs settle between named events;
this explores the declared schedule, not every possible JavaScript task.
Reconnect advances a fake clock by 250 ms; request timeouts remain on that clock.
Skipped Connect saves retain no-op delivery slots so regression orders stay
complete; the coverage assertions require a successful save, not those no-ops.

SL-01 coverage assertions require a successful sender push then response before
hydration releases, both early and late delivery to the other window, and delivery
after hydration too. A cache-copy mutation that discarded an own Connect push
received during hydration passed all 72 old orders but failed on the first new
order. The production session was not changed. Separate assertions audit both
admission orders, late acknowledgements and admission before, during and after
the socket drop/reconnect.

RP-01 found a product bug: after Disconnect and a theme change, an older full
settings response changed the published theme and `data-theme` back to dark
after the newer light-theme push. The later response restored light. No extra
settings write was caused by that acknowledgement. The real session now applies
a save response only when no full-settings push has arrived since its request;
newer pushes win, including while hydration buffers them. Responses remain a
fallback when no push arrives. Both shared and per-model saves follow this rule.
The theme/attribute witness and the model-save regression were watched failing
before their fixes and passing twice afterward. These are in-memory observations,
not browser paint measurements.

A failure prints its completed prefix and the full JSON order. Paste its
`REPLAY_ORDER='[...]'` before this command to run just that regression:

```sh
pnpm exec vitest run apps/web/test/ordering-replay.test.ts -t 'speech preserves'
```

Use the matching test name. The pasted order is checked for missing events,
duplicates, broken causal constraints and socket FIFO violations. A new real bug stays as a named
`it.fails` case until its fix lands. Verify its failure is the named invariant;
an unavailable fixture or invalid schedule must not count as rediscovering a bug.
The scheduler also has a planted failing invariant to prove that checks fire and
the failing world is disposed.

`ordering-state.test.ts` adds eight cases across seven guards. They use the same
real sessions and protocol decoder, capturing RPC results when requested and
separating server completion from delivery. Every case has an explicit witness;
small graphs are exhausted and larger graphs retain the 64-schedule cap.

| Scenario | Guard | Orders | Watched result with guard removed |
| --- | --- | ---: | --- |
| Fit and blocker preflight across a GPU reading | `fitEpoch` | 64 sampled | Old refusal replaces the fresh fitting verdict |
| Model choice while preload preflight waits | `preload` current-model check | 7 exhaustive | Superseded model starts loading |
| Refresh crossing another window's removal push | `modelsOrder.current` | 64 sampled | Removed model returns to the installed list |
| Off-screen completion around reconnect hydration | `lostTurn` clears `runningTurns` | 64 sampled | Disconnected stream stays marked running |
| Check and post-save image probes crossing busy | `imageOrder.current` | 13 exhaustive each | Ready replaces a newer busy push |
| Update hydration crossing Check and Dismiss | `updateOrder.current` | 42 exhaustive | Fresh check disappears and dismissed result returns |
| Pull acknowledgement timeout after initial progress | Queued-row identity | 3 exhaustive | Received download progress disappears |

These add 270 schedules, for 719 including the earlier cases and RP-01 witness.
Guard removals use cache copies selected with `REPLAY_SESSION`; production source
is restored for every normal run. All seven removals made their intended tests
fail. No case was kept on the evidence of a passing mutation alone.

The last three rows reproduced real client bugs before their guards were added.
Image push receipt now supersedes pending probes. Update Check and Dismiss
invalidate older hydration publication. A failed pull acknowledgement can remove
only its own optimistic queued row, preserving server progress or a newer attempt.
The pull case advances fake time by 30,001 ms: the initial downloading push
precedes its delayed/lost acknowledgement, as `pull.run` allows. It does not put
a later progress frame ahead of an earlier synchronous server refusal.

The proposed runtime-retry rollback was excluded for the current server:
`RuntimeSwitch` serializes ensure, discover and mode changes, and a probe through
that real wrapper emitted the old retry response before the next mode's push.
Runtime code remains unchanged. This assumption needs revisiting if its producer
ordering changes. These replays cover the declared graphs, not all possible
JavaScript or network schedules, and remain diagnostic probes.

`ordering-downloads.test.ts` adds RS-01 reconnect reconciliation. Missed done,
error and cancelled pushes each run with an installed model and with no chat
model yet. A first-model send queued during the download must resume when the
installed snapshot arrives. These six graphs and the unavailable-read graph
each exhaust 10 legal orders. Queued, downloading and verifying jobs each run
64 deterministic samples, with explicit witnesses for newer progress before
and after hydration releases. Those larger graphs are sampled, not exhaustive.
The 262 additional schedules bring the combined count to 981.

The server's `models.pulls` read returns `PullManager.pending()`. Hydration reads
it in the first batch while all pushes are held, replacing cached active jobs
with server jobs before releasing buffered progress. Terminal rows remain for
the existing installation handoff, and unavailable reads leave cached jobs alone.
The tests check rows throughout the disconnect, not just after reconnect, and
retain done rows until installed while preserving earlier error feedback.
Before the fix, missed terminal events left Downloading rows and server progress
of 55% remained at the client's old 20%. Both failures were observed in the real
session replay. These state checks do not measure browser paints.

First-model messages are queued for all three terminal outcomes. After an offline
failure or cancellation, their entries and text remain, while the real tray's
`queueWords` function explains that another model download is needed. Two further
checks render the real Composer for a connected failure and Cancel, retaining
Edit and Remove, editing status, retry wording and the live-download wording
during a drop. All four terminal wording checks failed with the old copy. These
extend the existing 981 schedules; the two connected checks are single journeys.

Historical checks can select a cache copy of a real `session.ts` with
`REPLAY_SESSION`. Redirect only that copy's relative imports to the current
support modules; both the session and the speech buttons then use its real
exports and matching store instance. VE-01 was watched on `b7c653a`, VF-01 on
`e39ec41`, and LB-01 on `c8c8e3c`, with the same enumerated scenarios.
