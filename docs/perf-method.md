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

`--limit 2c-2g` runs each arm's journeys in a smaller machine: the browser, the
server, the fake model service and the test driver are pinned to the first two
cores and share 2 GB with no swap (`test/perf/limits.ts`; Linux with a user
systemd). `1c-512m` and the like work the same way, and `2c` pins cores and
only measures memory. `--limit-base` and `--limit-candidate` set one arm, so
`--self --limit-candidate 2c-2g` shows what the limit alone costs one build.
A number after the `c` slows the cores: `1c50-2g` gives the box half of one
core's time, handed out every 5 ms, so everything in it runs at about half
speed. On more than one core that share is of all the cores together: `2c50`
is two cores with one core's worth of time, and one busy thread alone in it
is not slowed.

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
`#picker.open` appears, with the complete-view barrier intact. The picker warms
its fit reports only on intent (pointer entering the model button, keyboard
focus, pointer-down), never at idle and never while a reply runs or a model
loads, so how the opening arrives decides how much of the wait is hidden.
Keyboard focus means focus with a focus ring: `picker-open-keyboard` focuses
the button by script straight after typing in the composer, which Chromium
treats as keyboard focus. The row asserts the focus ring; without it the row
would measure a cold open.

`picker-open` is a scripted click with no hover before it: the pointer moves
onto the button and presses in the same instant, so the warm-up starts with the
click. Its `session-fit-checks` counter includes every `fit.check` sent since
navigation, including setup and the completed reply.

Three more after-reply rows each use a fresh client session with one completed
reply. `picker-open-hand` moves the pointer onto the button and clicks 150 ms
later, the way a hand does. `picker-open-keyboard` focuses the button and
presses Enter 150 ms later; its window starts at the keydown. Both record wall
time and exact session `fit.check` counts. `picker-open-hover-away` hovers for
350 ms, leaves and never opens; it records only the session's `fit.check`
count, the one warm-up whose checks no opening uses.

Two rows each use a fresh client session with no reply or earlier picker
visit, and leave the app's own idle work alone. `picker-open-hover` hovers the
model button for 350 ms before clicking. `picker-open-cold-ready` clicks as
soon as automation observes the enabled composer. These rows record wall time
and exact session `fit.check` counts, including repeated hover/focus and a
second opening; repeated intent must not add requests. (Earlier lane jobs also
had `picker-open-idle` and held idle callbacks to separate an idle warm-up
that no longer exists; both are gone.)

Every dwell is setup, excluded from elapsed time, and applies equally to both
arms. None of the fresh-session rows adds CPU or React count windows, and none
runs in the profile repetition.

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
