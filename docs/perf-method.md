# Measuring performance changes

How to tell whether a change made an action faster or slower, what size of change
one test-machine job can see, and how to keep a history across releases. Timing
is information, never a release gate. An exact counter is the one exception that
can be trusted on its own: any difference in it is a real difference.

## What runs

`node test/perf/next-compare.ts --prepared INPUTS --out RESULTS --only GROUPS --rounds 4 --samples 2`
(`pnpm perf:next` is the same command)
runs the priority journeys (`test/perf/next.spec.ts`) for a base and a candidate
build, alternating which goes first in each round. `--only` defaults to eight
groups: startup, send, threads, parallel, clipboard, voice, queue and reconnect.
The spec also implements `picker`, which runs only when named with `--only`: its
reply and extra sessions would shift every later group in a default run and
spend the job's budget. **First-run is not covered by this path yet.** The spec and
`next-compare.ts` refuse a selection that names it, or desktop-launch, and the
first-run row in the table below comes from older data scored offline. Each run
is:

1. `--samples` timed repetitions, each in a fresh browser context. Every action
   records its wall time plus what it cost the browser's main thread, read from
   the DevTools protocol: `.cpu-task`, `.cpu-script`, `.cpu-layout`, `.cpu-style`,
   `.cpu-thread` in ms, and `.layouts` and `.style-recalcs` as counts. These
   cover a wider window than the wall time; see below.
2. Three counter repetitions, never timed: React commits and rendered components
   (through a stand-in DevTools hook), requests, bytes, WebSocket frames in and
   out with their bytes, and DOM elements at the end of the action. A rendered
   component is a fiber in a committed tree flagged as having done work, so
   renders React threw away before committing, and StrictMode's second call, are
   not in the count. The repetition fails if the hook is missing from the page,
   or if React committed nothing during the first load, so a hook that was never
   installed cannot read as zero work. WebSocket bytes count text frames in
   UTF-8 and binary frames decoded. Job 2 was recorded before that, when they
   counted string code units, so its `.ws-bytes` rows used the old count; no
   number in this document or the history cites them. There are three so that
   a counter that varies between runs can be scored in a 4-round job: one per
   run gives one stratum of 4 against 4, which can never reach 1 in 100. With
   two, the lower quartile ties across so many arrangements that arms which do
   not overlap at all land near p = 0.009 and miss about one time in nine.
   With three they land near 0.002. A count stays exact only when it never
   varied, at any position, in at least two runs of each arm.
3. In round 1 only, one profile repetition, never timed: a sampled CPU profile per
   action in `profiles/<action>.cpuprofile` (open it in the browser DevTools
   Performance panel) and the top self-time functions in `profiles/hot-spots.json`.

`--self` runs the base build in both arms, which shows the noise of the method
itself. `--throttle N` slows the page's CPU N times; no job has measured whether
that helps. The job stops starting rounds when the next would pass
`--budget-seconds` (780 by default), so it ends inside a 15-minute runner limit.

Both arms use the GPU stand-in from the harness checkout, including when a
target is an older release: Linux uses POSIX shell and `awk` to read the fake
model's current JSON state, while other platforms keep the Node reference.
No rendered answers are cached, so direct state-file writes take effect on the
next query. This removes a Node startup from each Linux fit check; the lower
send timings after this harness change are not an app improvement.

`--limit 2c-2g` puts the app server and browser on the first two cores in one
2 GB cgroup with no swap (`test/perf/box.ts` and `limits.ts`; Linux with a user
systemd and Python 3). The Playwright driver, fake model, static file server
and synthetic GPU tool run in a separate owned scope on the remaining cores.
The GPU launcher leaves the app cgroup before starting the shell stand-in. A small keeper
and the box's reporting shell stay inside; their work remains unassigned.
`1c-512m` and the like work the same way, and `2c` pins cores and
only measures memory. `--limit-base` and `--limit-candidate` set one arm, so
`--self --limit-candidate 2c-2g` shows what the limit alone costs one build.
A number after the `c` slows the cores: `1c50-2g` gives the box half of one
core's time, handed out every 5 ms, so everything in it runs at about half
speed. On more than one core that share is of all the cores together: `2c50`
is two cores with one core's worth of time, and one busy thread alone in it
is not slowed.

No new flag is needed in a night script: existing `--limit`, `--limit-base`
and `--limit-candidate` calls use this app-only placement. Add
`--box-everything` to reproduce the old placement, with all test helpers
sharing the app's cores and memory. The processor sampler stays outside in
both modes. `scored.json` records `boxContents` so those modes remain distinct.
Limited-box readings from the performance nights of 2026-11-11 and 2026-11-12
include the synthetic GPU tool's Node-startup cost and are not comparable
with later app-only readings. Whole-machine readings do not change placement.

The per-role processor accounting and the server stage timestamps run only in
limited arms. Measured once on the whole machine, same build, four rounds of
two samples with them off and on: send to first words 348.68 against
381.17 ms (within noise), two replies at once 641.27 against 657.93 ms
(slower by 16.65 ms, just over a 16.48 ms noise limit). So a limited arm's
wall time carries a few tens of milliseconds of measuring; compare limited
readings only with limited readings taken the same way.

Each run prints its peak memory, how many processes were killed for memory,
the processor time everything in the box used and how long a speed limit
held the box back; `scored.json` keeps them under `boxes`. A kill for memory
ends that run at once and fails the job, since what survives the kill is no
longer a measurement. A slowed run that was never held back fails too: a
scheduler loaded through sched_ext may not enforce the limit, and such a run
must not be recorded as slowed. Setup (install, build, fixtures) stays
outside the limit. Fewer or slower cores are still this machine's cores, so
the numbers compare with other limited runs here, not with a real two-core
laptop. Give a limited job a larger `--budget-seconds` and runner timeout; it
stops early otherwise.

### Processor work inside the page's marks

Limited arms also write `cpu.jsonl`, `roles.jsonl`, `windows.jsonl` and
`server-stages.jsonl` per round. Only limited arms enable this instrumentation;
unlimited arms keep their existing measurement path. `scored.json` retains
each marked window under `accounting.base` or `accounting.candidate`, beside
the existing wall-time verdicts. The extra table in `scored.md` contains only
limited arms and averages timed windows with the same action name. Counter
and profile windows remain separate in JSON and never enter those means.

The processor columns are milliseconds of work, shown as **inside / outside**:

| Column | What it measures |
| --- | --- |
| Wall | The page's event-to-paint window, or its explicit observation interval |
| Server | The app server and its Node threads |
| Page | The renderer's main thread, read through Linux schedstat |
| Browser rest | Browser main process, renderer workers, GPU, network and other Chromium threads |
| Fake | The synthetic model service and its threads |
| Driver | Playwright, its worker and the test stack controller |
| GPU stand-in | The synthetic nvidia-smi executable and its Node threads |
| Unassigned inside | Cgroup CPU minus the six named in-box roles, including short-lived helpers and sampling discrepancy |
| Cgroup CPU | Independent cpu.stat usage within the same page marks |
| Cgroup minus sampled | Cgroup CPU minus all sampled in-box threads, including threads without a named role |
| Coverage % | Fraction of the marked interval covered by cgroup samples |
| Max gap / scan | Largest sample interval / scan duration touching the window, in ms |

The sampler reads this comparison's descendants roughly every 10 ms on helper
cores. Cumulative thread and cgroup counters are interpolated at the page's
epoch marks. PID, process birth and thread ID keep recycled processes apart;
new, exited or migrating threads without two readings cannot be attributed.
Their cost remains in the signed cgroup difference. Neither residual is
clamped to zero: a negative number exposes sampling overcount. Missing cgroup
data prints `n/a`, and partial coverage is not a complete-window reading.
Intervals and scan durations limit precision. CPU outside the box can overlap
the app and use several cores, so these columns do not partition wall time.
Even in a one-core box, unassigned work must not be relabelled as waiting.
The existing DevTools `.cpu-*` rows retain their wider before/after windows.

Server transport instrumentation records request/thread IDs and epoch times
only: receive of `chat.send`, admission through the fit checks to the streaming
model fetch, first nonempty model-stream bytes, and first socket delta just
before WebSocket.send. It appends the record at that first delta, so teardown
cannot discard an exit-only buffer. These are elapsed stages, including waits,
and cannot be added as CPU slices. First bytes need not contain visible words;
the socket mark is not a kernel transmission acknowledgement. A send that
never reaches a delta produces no stage record. No message content, endpoint
or credential is saved.

It writes `scored.json` and `scored.md`. `node test/perf/replay-next.ts RESULTS`
rescores recorded results without a browser and, for a same-build job, prints
what change each row can see.

The older path (`pnpm perf:compare`, with `compare.ts` and `stats.ts`) still
measures first-run. It goes away once the climbs have used this one for a
release.

### What window each row covers

The broad `perf:compare` rows `open-thread-200` and `open-thread-2000`
changed meaning after v0.1.0: they now close at the last turn's text in view,
matching `perf:next`'s cold-click first-screen window. Previously they waited
for every turn in the DOM, including the idle background fill introduced in
07b935a. Their new `-mounted` twins retain that whole-fill window from the
same click. Focused `perf:compare` thread rows also produce `-mounted` twins.
Both arms of a new comparison use the new windows, even against v0.1.0;
do not compare its plain-row timings directly with an older release report.
The `perf:compare` output (`comparison.md` and `comparison.json`) repeats this
change of meaning; `perf:next`, which has no `open-thread-*` rows, does not.
No thresholds changed.

The `picker` group measures a first picker opening after a completed reply,
without visiting the picker or settings first. Every row ends two frames after
`#picker.open` appears. Its fit values come from the fit table the server
pushed before the opening, so no opening asks for a fit; intent (pointer
entering the model button, keyboard focus, pointer-down) loads only the
picker's code, so how the opening arrives decides how much of that load is hidden.
Keyboard focus means focus with a focus ring: `picker-open-keyboard` focuses
the button by script straight after typing in the composer, which Chromium
treats as keyboard focus. The row asserts the focus ring; without it the row
would measure a cold open.

`picker-open` is a scripted click with no hover before it: the pointer moves
onto the button and presses in the same instant. Its `session-fit-checks`
counter includes every fit request (`fit.*`) sent since navigation, including
setup and the completed reply. The client asks for the fit table once at
hydration and the server pushes every later one, so the expected count is 1.

Three more after-reply rows each use a fresh client session with one completed
reply. `picker-open-hand` moves the pointer onto the button and clicks 150 ms
later, the way a hand does. `picker-open-keyboard` focuses the button and
presses Enter 150 ms later; its window starts at the keydown. Both record wall
time and exact session fit request counts. `picker-open-hover-away` hovers for
350 ms, leaves and never opens; it records only the session's fit request
count, which must not grow on hover.

Two rows each use a fresh client session with no reply or earlier picker
visit, and leave the app's own idle work alone. `picker-open-hover` hovers the
model button for 350 ms before clicking. `picker-open-cold-ready` clicks as
soon as automation observes the enabled composer. These rows record wall time
and exact session fit request counts, including repeated hover/focus and a
second opening; repeated intent must not add requests. (Earlier lane jobs also
had `picker-open-idle` and held idle callbacks to separate an idle warm-up
that no longer exists; both are gone.)

Every dwell is setup, excluded from elapsed time, and applies equally to both
arms. The fresh-session rows add no DevTools CPU or React count windows; limited
arms still account for processor work between their page marks. None runs in
the profile repetition.

- **Wall time** starts at the input that triggers the action, using the event's
  own timestamp (click, keydown, paste). Three rows start differently.
  cold-composer starts at navigation. reconnect-during-stream starts when the
  probe is armed, just before the socket is dropped. queue-finish-to-next-token
  starts when the previous reply shows its done marker. Every row ends two
  frames after the end state is in the DOM.
- **CPU and count rows** read the browser's counters once before the probe is
  armed and once after the wall clock has stopped and its result has reached
  the test. Their window therefore always holds the wall window, plus arming,
  dispatching the trigger and two protocol round trips. The page has been quiet
  before each action, so on most rows that adds little work.
- **queue-finish-to-next-token is the row where the two windows hold different
  work.** Its trigger releases the previous reply. The CPU and count window
  opens before that, while the wall clock waits for the done marker. Its
  `.cpu-task` and all its count rows therefore also include the previous reply
  streaming its last tokens and finishing. Its wall row does not.
- cold-composer's CPU counters restart with the new document, so its CPU rows
  cover the new page from its start, the same span as its wall time.
- **`thread-<n>-<warmth>-<path>` closes at the first screen; its
  `-mounted` twin closes at the whole thread.** The plain row ends when the
  last turn's text is on screen. A timeline that mounts the newest turns
  first and fills in the rest later reaches that point with most of the
  thread still to mount, so the plain row times and counts the first screen
  only. `thread-<n>-<warmth>-<path>-mounted` comes from the same click and
  the same opening reading, and closes two frames after all `<n>` turns are
  in the DOM: its wall time, CPU and count rows (rendered components,
  commits, layouts, DOM elements at the end) cover the whole mount. Where
  everything mounts at once the two rows end in the same frame. The probe
  checks the turn count each frame from a live collection by class name,
  which is cheap on a long thread. Those per-frame checks continue after the
  plain row's end, so the plain row's CPU window, which runs on through its
  protocol reads, can hold a few of them; its wall window and end state are
  unchanged.
- **`type-in-thread-2000`** types one character into the focused composer
  while the last 2000-turn visit is open and every turn is mounted. It runs
  from the keydown to two frames after the character is in the box, with the
  box enabled and focused, and has the same CPU and count rows as the others.
  A render counter cannot see everything a keystroke costs. It counts
  components React rendered and committed. A store selector that runs on
  every change, finds its value unchanged and so renders nothing is invisible
  to it: two thousand saved replies can each run their selectors on every
  keystroke and add nothing to `react-renders`. The cheapest honest reading
  of that work the page already offers is
  `type-in-thread-2000.cpu-script`, the main thread's scripting time over the
  keystroke's window.

## How a change is scored

`test/perf/score-next.ts` replaces the noise floor for these runs.

- A **counter** that reads the same at each repetition in every run of both arms
  is exact. Any difference is reported, with no allowance. It takes at least two
  runs per arm: one run agrees with itself whatever the counter does, so a
  one-round job scores every counter as sampled.
- Every other row is **sampled**. Repetitions are compared like for like: the
  first repetition of each run only with first repetitions, because the first
  browser of a run is slower. Repeated instances of an action inside one
  repetition (the four thread switches) count as one value.
- The statistic is the difference between the arms' **lower quartiles**. Delays
  in this app only add time (a garbage collection, a missed frame), so the fast
  end of the spread holds still while the slow end wanders.
- A shuffle test deals the values between the arms 4,000 times within each
  repetition position and asks how often a gap this large appears by chance. A
  change is reported when that is under 1 in 100 and the change is at least the
  smallest worth naming: 1 % and 1 ms for wall time, 1 % and 0.05 ms for CPU time.
- Each row ends in one of four signals. **slower** and **faster** are measured
  changes. **within noise** means the row was tested and no change was seen at
  its limit. **not scored** means the row could not be tested at all: its
  shuffles have too few distinct arrangements to reach 1 in 100, whatever the
  values. Four strata of one run against one give 2⁴ = 16 arrangements, so
  fewer than 8 repetitions per arm usually land here. Its p and limit print as
  n/a, and `scored.md` ends with a line counting the rows not scored.
- The **noise limit** column is the gap that 99 shuffles in 100 stay under. A
  row "within noise" with a limit of 30 % was not seen; it was not shown to be
  unchanged.
- The limit is the size a difference had to exceed among the shuffled
  arrangements of this job's own values, not a reading of the machine's noise.
  The shuffle deals both arms' values together, so when the real change is
  large the shuffled gaps are large too, and so is the limit. In the
  long-threads comparison, thread-2000-cold-click moved from 553 ms to 96 ms
  and printed a limit of 317 ms: that is the change showing up in the
  shuffle, not 317 ms of noise.

## What one job can see

Same-build job `perf-next-job2-20261109T213733Z`: both arms commit `fb1684e`,
measured with this tooling as first written, groups startup, threads, clipboard (no paste), voice,
send, parallel, queue and reconnect, 4 rounds of 2 timed repetitions, 655 s.

- **Current floor**: the present scorer's noise floor on this job, as a percent
  of the median.
- **Detectable**: the smallest slowdown the new scorer reports at least 9 times
  in 10. It is found by dealing this job's 8 repetitions per position into two
  arms of 4 without replacement, adding the shift, and scoring, 200 times per
  size. A wall-time row that ends at a paint gains the shift in whole 16.7 ms
  frames, as a real delay would. Each simulated score uses 400 shuffles, not
  the 4,000 a real verdict uses, so this is a cheaper procedure than the
  scoring, not the same one (see the note below the table).
- **False signals**: the rate at which the same simulation, with no shift,
  reported a change; then the verdict the job itself gave.

| Row | Median ms | Current floor % | Detectable %, wall | Detectable %, CPU task | False signals: simulated, this job | Source |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| cold-composer | 316 | 43 | 40 | 40 | 0.0 %, none | job 2 |
| thread-200-cold-click | 111 | 47 | 30 | 30 | 1.0 %, none | job 2 |
| thread-200-warm-click | 77 | 38 | 25 | 30 | 0.5 %, none | job 2 |
| thread-200-cold-hover | 81 | 54 | 50 | 50 | 0.5 %, none | job 2 |
| thread-200-warm-hover | 68 | 27 | 25 | 20 | 1.0 %, none | job 2 |
| thread-2000-cold-click | 602 | 28 | 30 | 30 | 1.0 %, none | job 2 |
| thread-2000-warm-click | 487 | 39 | 25 | 25 | 1.5 %, none | job 2 |
| thread-2000-cold-hover | 528 | 37 | 30 | 30 | 0.5 %, none | job 2 |
| thread-2000-warm-hover | 447 | 42 | 30 | 25 | 1.0 %, none | job 2 |
| open-huge-reply | 92 | 36 | 30 | 20 | 1.0 %, none | job 2 |
| copy-message | 59 | 5 | 25 | 25 | 1.5 %, none | job 2 |
| copy-code-4000 | 59 | 4 | 25 | 12 | 0.0 %, none | job 2 |
| voice-start-recording | 92 | 78 | 60 | 25 | 0.0 %, none | job 2 |
| voice-stop-to-transcript | 59 | 49 | 30 | 30 | 0.5 %, none | job 2 |
| send-first-visible-token | 328 | 16 | 15 | 25 | 0.5 %, none | job 2 |
| two-streams-start | 633 | 8 | **5** | 15 | 0.5 %, none | job 2 |
| parallel-switch | 442 | 45 | **4** | **10** | 0.5 %, **slower +1.3 %** | job 2 |
| queue-send-1 | 39 | 19 | 40 | 40 | 0.0 %, none | job 2 |
| queue-send-2 | 42 | 19 | 40 | 100 | 0.5 %, none | job 2 |
| queue-send-3 | 44 | 6 | 40 | **7** | 0.5 %, none | job 2 |
| queue-send-4 | 43 | 8 | 40 | 20 | 0.5 %, none | job 2 |
| queue-send-5 | 44 | 5 | 40 | **7** | 0.0 %, none | job 2 |
| queue-finish-to-next-token | 220 | 19 | 15 | **10** | 1.5 %, none | job 2 |
| reconnect-during-stream | 333 | 16 | 12 | 30 | 0.0 %, none | job 2 |
| paste-text-50000 | 18471 | 8 | **6** | not recorded | 0.5 %, none | replay of older data |
| type-after-paste | 36 | 92 | 80 | not recorded | 0.0 %, none | replay of older data |
| first-run-ready | 365 | 26 | 25 | not recorded | 0.0 %, none | replay of older data |
| Exact counters (166 rows) | | none | 1 count | | 0, none | job 2 |

Rows added since job 2, with no same-build job behind them yet, so their
detectable sizes are unknown: the eight `thread-<n>-<warmth>-<path>-mounted`
rows and `type-in-thread-2000`, each with its CPU and count rows.

**Why 400 shuffles.** At 4,000 shuffles in the simulation, one full replay of
job 2 took 2,504 s on a desktop, too slow to rerun after each scorer change.
That pass was run once to check the table. It moved 9 of the 48 job-2
detectable cells by one step:

- 7 went down. Among them, two-streams-start's CPU task went from 15 % to
  10 %, which would add it to the 10 % list below.
- 2 went up: open-huge-reply wall time went from 30 % to 40 %, and
  send-first-visible-token's CPU task from 25 % to 30 %.

Simulated false-signal rates moved by up to 1.5 points, in both directions.
200 trials cannot resolve a 1 % rate more finely than that.

The two CPU rows whose false-signal rates sat at or above 1 in 200 kept their
detectable sizes: queue-send-3 at 7 % and queue-finish-to-next-token at 10 %.
Their rates went from 0.5 % and 1.0 % to 0 and 0. The verdicts on the recorded
job use 4,000 shuffles in both passes and did not change.

"Replay of older data" is the same-build recording `climb-budget-20261109T191209204Z`
(4 rounds of 2) rescored offline. On the rows both measured, the two same-build
recordings agree to within a factor of two, in both directions: cold-composer
20 % there against 40 % here, thread-2000-warm-click 50 % against 25 %. Read the
detectable column as a size class, not a precise figure.

On false signals: job 2 reported one change among 384 rows. parallel-switch was
1.3 % slower with p = 0.0095, on identical builds. At 1 in 100 over 144 sampled
time rows, about 1.4 false signals per job are expected, so a lone small signal
near p = 0.01 is weak evidence. The older same-build recordings (152 rows
together) gave none. No exact counter disagreed.

## The plain answer

**One job under 15 minutes cannot see a 10 % change on most priority actions.**
The whole priority set fits 4 rounds of 2 repetitions in 655 s. At that size:

- Wall time sees 10 % or less on 3 of 27 rows: two-streams-start (5 %),
  parallel-switch (4 %) and paste-text-50000 (6 %, replay).
- CPU task time adds 3 more rows: queue-send-3 (7 %), queue-send-5 (7 %) and
  queue-finish-to-next-token (10 %). That makes 6 of 27. Caveat: the
  queue-finish-to-next-token CPU row also holds the previous reply finishing
  (see "What window each row covers"). Its 10 % is of that wider work, not of
  the hand-off its wall row times.
- Every other row sees 12 % to 80 %.
- Exact counters see a change of one, on every action where they are exact.

Why the rest cannot:

- **Short actions that end at a paint** (copy, queue sends, voice, thread-200
  rows, type-after-paste) move in whole 16.7 ms frames. A 10 % change to a
  40–70 ms action is 4–7 ms, which shows up as an extra frame only some of the
  time. CPU time has no frame grid and helps some of them (copy-code-4000 12 %,
  two queue sends 7 %). It does not help where the CPU work itself varies, as
  on the thread-200 rows (20–50 %).
- **Long actions** (thread-2000 rows, cold start) do different amounts of work
  from one repetition to the next on the same build. On thread-2000-cold-click,
  style recalculation took between 141 and 232 ms and script took between 220
  and 310 ms. CPU time does not remove variation in the work itself, so it sees
  no more than wall time there (25–40 %).
- **First repetitions differ by arm.** On cold start the base arm's first
  repetition was slow in 3 of 4 rounds (282–308 ms against about 231 ms) on an
  identical build. The lower quartile ignores this; a mean or a median would not.

Seeing 10 % on those rows needs more repetitions, and that means a narrower
`--only` group. In job 1's profile repetition, the threads group took about 8 s
of a 20 s repetition. A threads-only job should therefore fit about 4 rounds of
8 inside the budget. **No job has measured that size.** The recording holds 8
repetitions per position, so a simulation cannot honestly stretch to 32;
`detectableChange` refuses to. If noise falls with the square root of the
repetitions, as it does for a well-behaved quartile, 4 rounds of 8 would roughly
halve the sizes above: thread-2000 rows near 15 %, cold start near 20 %. That is
an estimate, not a measurement. Frame-held short rows will gain less.

## Rows omitted from the priority journeys

The older `priority.spec.ts` path omits these redundant rows. The scorers read
the recorded metric set, so old recordings remain readable without rewriting
them or changing scoring thresholds:

- `paste-input-delay`: 0.2–0.8 ms across 56 recorded samples, below the older
  scorer's 2 ms floor. The median alone is not enough to drop the other input
  rows: `voice-arrival-input-delay` reached 4.6 ms in round 3's candidate arm
  of `climb-budget-20261109T191209204Z`, so it stays. The broad journeys'
  composer and streaming input delays also stay; their maxima were 7.2 and
  25.2 ms.
- `.frame-p95` on the eight thread visits, paste and voice arrival: identical
  sample for sample to `.frame-max` across the recordings that include them.
  `.frame-max` stays. The priority path keeps `parallel-switch.frame-p95`,
  which differs from its maximum. The broad suite's `two-streams.frame-p95`
  also differs and is unchanged; its separate measurements are not removed
  from `journeys.spec.ts`.
- `open-thread-200` and `open-thread-2000`: the same values as the
  `thread-*-cold-click` rows in all 16 runs that record both names. The cold
  click rows and their functional assertions stay. The broad suite's open
  rows have no cold-click aliases and stay.
- `.long-tasks` and `.long-task-time` on thread-200-cold-click and the paste
  row: zero across 56 samples each. Other thread visits keep their long-task
  rows: even the 200-message warm/hover visits recorded nonzero work.

This removes 17 priority rows. The shared probe still collects input and long
tasks for the remaining consumers, including the broad suite. The newer
`next.spec.ts` path already records elapsed time, CPU cost and counters rather
than these rows; its measurements and scorer are unchanged.

## Picker freshness and throttle review, 2026-11-11

First opening now requires current fit answers, or an explicit error, rather
than merely retained reports. A completed warm followed by `gpu.changed` or
model-load completion could previously open on history while replacements were
pending. The same four in-memory cases failed on main and with the parent
Picker module (`e59179e`) given the same populated cache. The `prepared`
expression was byte-identical in that parent, `d55debf`, and main `11b1a73`.
Warming makes the populated-cache case reachable before the first click; the
parent's barrier did not enforce a different freshness rule. This comparison
uses the parent Picker in the same session fixture, not the whole parent app.

The fix reuses `fitIsCurrent`, permits error answers to settle, and leaves the
already-open picker's history and startup-failure escape intact. Existing
GPU/model-read error and timeout tests still pass. Both extra picker perf
helpers also apply `Emulation.setCPUThrottlingRate` before navigation. Checks
against both real helpers failed at rate 4 before the fix and pass at rates
4 and 1 afterwards, without launching a browser.

The new tests were written in the implementation lane, not independently.
Six diagnostic assertions failed before the fixes; focused runs passed twice.
Final local verify: 224 files, 3,227 passed, 2 skipped. The original whole-picker
`f.checking` assertion was unchanged, and passed at all three delivery delays.

Two detached runner jobs completed with no owned processes left. The first,
`picker-round4-functional-1-20261111T080943.761812Z`, passed 78 existing tests
and skipped 2; its new probe failed because repeated startup reads of one
selected pair were mistaken for a complete warm. The corrected precondition
requires all six distinct first-view pairs and every response before
invalidation. Repeated intent uses the existing in-flight dedupe.

The second, `picker-round4-proof-2-20261111T082045.490678Z`, was the single
exclusive job. It repeated the full explicit functional selection (79 passed,
2 skipped), then compared only the picker group. The invalidation journey
held every replacement reply, kept the picker hidden until the last answer,
and asserted six replacements with no additional check on opening. The job
finished in 759.271 seconds; the comparison itself took 450.880 seconds.
There were no overlapping jobs from this lane. No further runner job was used.

Comparison: merged-main BASE `11b1a73`, candidate `088e3f9`, four paired rounds,
two timed repetitions per arm per round and three counter repetitions. Rate 1
was used in both arms; comparing rate 4 would mix the throttle-helper repair
with the product change. The medians below use nearest rank. Limits apply to
the lower-quartile shuffle test, not median differences. Every timing row was
within noise; no threshold, scorer or label changed.

| Action | Base median ms | Candidate median ms | Limit ms |
| --- | ---: | ---: | ---: |
| picker-open | 293.80 | 293.60 | 11.75 |
| picker-open-hover | 36.20 | 42.10 | 8.82 |
| picker-open-cold-ready | 298.30 | 294.60 | 15.50 |
| picker-open-hand | 109.40 | 119.20 | 13.55 |
| picker-open-keyboard | 68.30 | 59.00 | 29.15 |

| Full session | Base fit.check | Candidate fit.check |
| --- | ---: | ---: |
| main after-reply journey | 11 | 11 |
| after-reply hand | 7 | 7 |
| after-reply keyboard focus | 7 | 7 |
| after-reply hover-away | 7 | 7 |
| ready hover | 6 | 6 |
| ready cold click | 6 | 6 |

Each count was identical across all 12 counter repetitions in each arm. A
still-current warm also opens on the first layout pass without another check
in the in-memory test. Hover waits 350 ms after readiness; cold-ready clicks
as soon as automation sees readiness. Hand and keyboard-focus wait 150 ms
between intent and activation after a reply. Those dwells are outside the
timing window. The new invalidation browser case is correctness evidence,
not a separately timed perf row.

The only changed exact action counter was picker-window network bytes:
7,826 to 7,840. Total JS gzip grew 15 bytes (182.093 to 182.107 KiB), entry
JS fell one byte (140.449 to 140.448 KiB), and CSS was unchanged. Existing
soft-target warnings remain. First-run and thread-open latency were not
remeasured in this review; the first-screen/full-mount thread windows remain.

## Final picker shortcut comparison, 2026-11-11

Run `picker-shortcut-final-compare-1-20261111T071412.692386Z` compared merged
main `67a1519` with experiment `1ed119a`. Main already contained button-intent
warming. The experiment additionally started the same checks on Control/Command+M
before mounting the picker. It retained the complete-view barrier and original
whole-picker flicker assertion. One detached exclusive job completed in
772.261 seconds with no owned processes left. Four paired rounds recorded
12 timed and 12 counter repetitions per arm for startup/picker, plus 8 first-run
timing repetitions per arm in the same job. No other job from this lane overlapped.

The medians use the harness's nearest-rank convention. The next scorer's limits
apply to its lower-quartile shuffle test, not to differences between medians.
Every row stayed within noise; first-run's existing too-noisy label remains.

| Action | Base median ms | Experiment median ms | Limit ms |
| --- | ---: | ---: | ---: |
| cold-composer | 269.90 | 278.40 | 17.45 |
| picker-open | 293.50 | 308.80 | 1.10 |
| picker-open-hand | 110.80 | 107.50 | 6.08 |
| picker-open-keyboard | 57.00 | 62.90 | 24.35 |
| picker-open-shortcut | 311.30 | 294.80 | 16.58 |
| picker-open-hover | 36.00 | 38.40 | 8.05 |
| picker-open-cold-ready | 288.10 | 294.30 | 7.58 |
| picker-open-idle | 295.40 | 292.40 | 7.85 |
| first-run-ready | 358.70 | 350.40 | 82.60 |

The shortcut's p = 0.0145 missed the unchanged 0.01 threshold. Hover and idle
each wait 350 ms after readiness; only hover touches the button before the
click. Cold-ready clicks immediately after readiness. Hand and keyboard-focus
rows wait 150 ms between intent and activation after a completed reply. Shortcut
presses Control+M after a reply without prior button intent. Dwells are setup,
outside the timing window. These extra idle/shortcut experiment rows were removed.

| Session | Base fit.check | Experiment fit.check |
| --- | ---: | ---: |
| main after-reply journey | 11 | 11 |
| after-reply hand | 7 | 7 |
| after-reply keyboard focus | 7 | 7 |
| after-reply shortcut | 7 | 7 |
| after-reply hover-away, never opens | 7 | 7 |
| ready hover | 6 | 6 |
| ready cold click | 6 | 6 |
| ready idle click | 6 | 6 |

Every picker count above was identical across all 12 counter repetitions in
each arm. Hover-away includes five checks whose results no opening uses, in
both arms. The only changed exact action counter was picker network bytes,
7,825 to 7,827. Entry JS gzip grew 140.419 to 140.425 KiB and total JS 181.902
to 181.912 KiB; CSS was unchanged. Those changes were reverted.

First-run counters were sampled at the readiness marker, before screenshot and
context close, so they did not establish complete-session counts. The recorded
vectors, in rounds 1 through 4, were base `[1,1] / [2,1] / [2,1] / [1,1]` and
experiment `[2,1] / [1,1] / [1,1] / [2,1]`. Both total ten checks, but paired
sessions differ. Strict per-session parity remains unproven. This experimental
counter was also removed; no measurement or scorer label was changed.

The new shortcut unit test failed on both Control and Meta before the change
and passed twice afterwards. Candidate verification passed 3,210 tests with 2
skipped; the explicitly selected browser run passed 97 tests with 2 skipped,
including the original cold-picker flicker guard at all three delays, picker,
downloads, context, composer and native paste. Revert `f9b7c9a` restores the exact
main product/harness tree; fallback verification passed 3,208 tests, 2 skipped.
There was no further browser or timing job after the revert. First-screen
thread rows and their full-mount twins were retained, not remeasured here.

## How to climb

This section is written to replace "How to climb" in the climb lanes' brief.

1. **Profile first.** Every comparison job writes a CPU profile per action from
   one untimed repetition (`profiles/<action>.cpuprofile`, top functions in
   `profiles/hot-spots.json`). Read where the time goes before changing code.
   Native calls are named. App functions are minified, so match them by file
   and line, or open the profile beside a source-mapped build. Self time in a
   layout read usually names whoever asked for layout first, not what caused
   the layout. On thread-2000-cold-click, job 2's round-1 base profile charges
   119 ms of self time to `getClientRects`. Its only caller is `check`, the
   probe's per-frame visibility read in `test/perf/probe.ts`. That time is the
   layout of the freshly mounted rows, paid at the first read after they mount;
   it is not a stray read in the app.
2. **One change at a time,** in small commits.
3. **Prepare inputs outside the checkout:**
   `pnpm perf:compare --prepare BASE CANDIDATE --out <a directory outside the checkout>`.
   The runner ships only the submitted tree, so submit a staging copy:
   `git archive HEAD` extracted into a fresh directory, with the inputs copied
   into it. Your checkout stays clean and nothing can sweep inputs into a commit.
   BASE is the main commit your branch started from.
4. **One exclusive job, narrow group:**
   `node test/perf/next-compare.ts --prepared perf-inputs --out <fresh> --only <your group> --rounds 4 --samples <as many as fit>`.
   Setup takes about 80 s. A repetition of the whole priority set takes about
   20 s, and each run adds three counter repetitions (plus one profile
   repetition in round 1) and a few seconds of start-up. The job stops before its budget on
   its own.
5. **Read counters first.** A change in an exact counter (renders, commits,
   layouts, requests, bytes, DOM elements) is real at any size. Opening the
   2000-turn thread commits 16,460 rendered components in every run today. A change that
   cuts that number is a measured win, even if the time row says "within noise".
   If the change defers work rather than removing it, the plain thread rows
   will show the cut and the `-mounted` rows will show whether the total
   fell, stayed or grew; report both. On typing, a selector that renders
   nothing does not show in the counters; read `.cpu-script`.
6. **Then read time, with its limit.** A signal means p < 0.01 and at least 1 %.
   "Within noise" means nothing was seen at that job's noise limit, not that
   nothing changed. "Not scored" means the row was not tested: add rounds or
   repetitions before saying anything about it. Expect the sizes in the table
   above. Report the delta and the limit together, and remember a large change
   brings a large limit with it.
7. **A lone signal under 3 % near p = 0.01 is weak.** One appears by chance in
   about every job. Believe it when a counter or the profile agrees, or when it
   repeats in the next round's job.
8. **Keep what wins, revert what doesn't,** and say which in the report.
9. **Don't change the scorer, the thresholds or the labels to make a result
   appear,** and don't change the product to move a number without moving the
   experience.
10. After a release, add a column to the history (below).

## History across releases

`docs/perf-history.md` holds one column per release: wall time and CPU task
time, using the lower quartile, then work counts. A word beside a number means
that release measured differently from what it was compared with, or, for
"(not scored)", that the row had too few repetitions to be tested. A job that
compared a build with itself adds no change words; it keeps "(not scored)".
Add a release with:

`node test/perf/history.ts --label RELEASE --scored RESULTS/scored.json`

The first column is main at `fb1684e`, from job 2.
