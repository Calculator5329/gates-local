# Testing

## Opt-in real-model smoke

On an authorized Linux x64 CPU test runner, run:

```sh
GATES_REAL_SMOKE=1 node test/e2e/real-smoke-run.ts
```

The setup caches the checksum-verified pinned Ollama and `smollm2:135m`
(about 271 MB) in a dedicated user cache, serves it on port 16195, and stops it
at the end. Use the runner's exclusive/network-enabled mode; its cleanup receipt
must show zero remaining owned processes. First setup downloads the runtime and
model once; warmed runs reuse both without a pull.

`pnpm e2e` excludes this spec by default. `GATES_REAL_SMOKE=1` selects only this
journey and starts no fake stack. An absent runtime or model fails loudly.
To watch the missing-model failure, add
`GATES_REAL_SMOKE_MODEL=smollm2:missing-smoke-model` to the setup command.
For an already isolated runtime, set `GATES_REAL_SMOKE_URL` to its loopback URL
and run `GATES_REAL_SMOKE=1 pnpm e2e real-smoke.spec.ts` instead.

The built client and production server exercise real model discovery, unchanged
fit, progressive tokens, Stop, recall of a random name from the earlier message,
and restart persistence. No GPU measurement override or `num_gpu` is supplied;
the existing no-GPU path admits a small model as a system-memory spill. Stopped
partials remain in the current client session only; restart checks the completed
reply. Retain `real-ollama.log` and the browser screenshot, trace and
`evidence.json`. This new diagnostic probe does not establish GPU or Electron
behavior.

## Informational browser performance

`test/perf/` is a separate Playwright project, excluded from `pnpm e2e`.
Timing is informational and never changes the release verdict. On an authorized
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
medians and the sum of both builds' p95 sample deviations from their medians, at least 2 ms or
one count. A paired-round bootstrap supplies a
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
witness, witnesses that delay each event in turn, then fixed-seed priority samples. The seven current product
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

Historical checks can select a cache copy of a real `session.ts` with
`REPLAY_SESSION`. Redirect only that copy's relative imports to the current
support modules; both the session and the speech buttons then use its real
exports and matching store instance. VE-01 was watched on `b7c653a`, VF-01 on
`e39ec41`, and LB-01 on `c8c8e3c`, with the same enumerated scenarios.
