# Testing

How to run the tests. What each feature's tests are, and where its code
lives, is in [the feature map](feature-map.md).

## Unit tests and the gate

`pnpm verify` runs typecheck, lint and `pnpm test` (every `*.test.ts`, with
Vitest). `pnpm build` builds the client and prints the bundle sizes. Both
must pass before a change lands. Focused sets:

```sh
pnpm verify:runtime   # settings, fit and runtime on the server
pnpm verify:image     # image generation on the server
pnpm verify:gpu       # GPU lease and readings
pnpm verify:tools     # the agent tools and the harness package
pnpm verify:sources   # Library sources
```

## Browser tests

`pnpm e2e` builds the client and runs the whole `e2e` project with one
worker. Name specs to run fewer: `pnpm e2e first-run.spec.ts`. The release
check runs the whole project.

- `GL_E2E_RECORD=1` keeps video and full traces of passing runs. Failure
  traces and explicit screenshots are kept by default.
- `GL_FLICKER_MEASURE=1` adds the six broad flicker recordings and two
  state-swap surveys in `flicker-swaps.spec.ts`.
- `pnpm e2e:timing` measures wall-clock against fixed budgets.
- `pnpm e2e:shots` and `pnpm shots:readme` take screenshots;
  `shots:readme` rewrites the images in `docs/screenshots`.

A journey over five seconds warns; over ten, add a `budget` annotation that
says what work it needs. Warnings never fail the run.

A browser test waits for what it expects to see, never for a length of time.
When no locator says it, `test/e2e/waits.ts` has three waits: `painted` (the
next frame is drawn), `settled` (fonts in, nothing easing) and `holds` (a
claim checked again and again through a span, such as "no tooltip past its
delay"). Only `holds` waits on the clock; lint `gates/no-wait-for-timeout`
refuses the clock anywhere else, including a hand-written disable.

## Whole on the first frame

`flicker-audit.spec.ts` checks the rule in `docs/design.md`: a surface
shows its full shape on its first frame. It slows every WebSocket answer,
push and code chunk by 600 ms, does one thing, and records every frame until
the page is quiet. `settings-cards-desktop.spec.ts` runs the same watch in
the desktop app (needs `--display`).

The probe is `test/e2e/flicker-probe.ts`. Two marks tell it what is
allowed:

- `data-skel`: a placeholder. Whatever replaces it is not a changed word,
  and anything that appears inside its box is not late. It must sit inside
  an `aria-busy` container and be `aria-hidden`, or the run says "loose
  placeholder".
- `data-wait`: a fixed-size slot for a wait that is long by nature (a fit
  check, a download). Its words may change; its box may not.

A finding names the step, the kind, the element and when, for example
`late .turn Your message arrived 625 ms and 37 frames after the first
frame`. Fix the surface, not the probe; widen the probe only when it
missed something real.

## Real-model smoke

On a Linux x64 test machine:

```sh
GATES_REAL_SMOKE=1 node test/e2e/real-smoke-run.ts
```

The setup caches a checksum-verified Ollama and `smollm2:135m` (about
271 MB), serves them on port 16195 and stops them at the end. `pnpm e2e`
leaves this spec out. To watch the missing-model failure, add
`GATES_REAL_SMOKE_MODEL=smollm2:missing-smoke-model`. Keep `real-ollama.log`,
the screenshot, the trace and `evidence.json` from a run.

## Desktop smoke

```sh
pnpm --filter @gates-local/desktop smoke
GL_DESKTOP_SMOKE_DISPLAY=1 pnpm --filter @gates-local/desktop smoke   # on a virtual X11 display
```

## Performance

`test/perf/` is a separate Playwright project, left out of `pnpm e2e`.
Timing never changes a verdict. [Measuring performance
changes](perf-method.md) explains the newer scorer, what one job can see,
and the climb steps.

Compare two commits on a browser machine, in one exclusive job:

```sh
pnpm perf:compare BASE_COMMIT CANDIDATE_COMMIT --rounds 5 --samples 3 --out perf-results
```

On a runner without Git history, prepare the inputs first, then run the
prepared copy in the job (900-second bound):

```sh
pnpm perf:compare --prepare BASE_COMMIT CANDIDATE_COMMIT --out perf-inputs
pnpm perf:compare --prepared perf-inputs --rounds 5 --samples 3 --out perf-results
```

- Always use a fresh output folder; never commit the inputs.
- `--self` compares the prepared base with itself.
- `--only` takes `priority` or any of
  `startup,send,threads,parallel,clipboard,voice,queue,reconnect,first-run,desktop-launch`.
  Desktop launch runs only when named.
- `--analyze SAVED_COMPARISON --out FRESH_DIRECTORY` re-scores saved rounds
  without a browser.
- `node test/perf/next-compare.ts --prepared INPUTS ...` runs the newer
  scorer with work counters and a CPU profile per action.
- `GL_PERF_PROFILE=1` on a direct journey writes a CPU profile per action.
  Never compare profiled readings.
- `node test/perf/desktop-profile.ts --out FRESH_DIRECTORY` captures a server
  CPU profile after building web and desktop.

`pnpm build`, the perf spec and the comparison share the soft gzip targets in
`test/bundle-size.ts`. Size warns and never blocks; never raise a target to
make a build pass.

### How `perf:compare` scores

`comparison.md` shows AB/BA paired-round changes. Noise is the larger of the
p95 change between same-build rounds and the sum of both builds' p95 sample
deviations, at least 2 ms or one count. A paired bootstrap gives a 95%
interval. A signal must beat the noise and have its interval on one side of
zero. Noise over 20% of the base and over 10 ms or one count is marked too
noisy. This is screening, not a significance test. The release check runs
four rounds of two samples against the newest stable release tag.

## Client ordering replays

`pnpm test` includes in-memory replays of two client sessions against one
scripted server: speech connection choices, messages crossing a reconnect,
Stop around a send acknowledgement, ordered settings and downloads. No
browser, socket or wall clock. The files are
`apps/web/src/thread/ordering-replay.test.ts`,
`apps/web/src/app/ordering-state.test.ts` and
`apps/web/src/composer/ordering-downloads.test.ts`.

To add a scenario, describe what the person does, what the server can
deliver, and what must stay true. Add named events with `after` constraints
only where the code requires an order, each with a short source comment.
Keep the button sequence separate from transport guarantees. Check the
visible message, connection choice or intended reply after each event.
Graphs with at most 64 orders are exhausted; larger ones run 64 fixed
schedules.

A failure prints its completed prefix and the full order. Paste its
`REPLAY_ORDER='[...]'` before the command to run just that order:

```sh
pnpm exec vitest run apps/web/src/thread/ordering-replay.test.ts -t 'speech preserves'
```

A new real bug stays as a named `it.fails` case until its fix lands.

- `REPLAY_ORDERED_SETTINGS=0` runs the settings replays against the older
  guards.
- `REPLAY_SESSION` points the replay at a cache copy of `session.ts`, to
  watch a guard's removal fail. Redirect only that copy's relative imports.
