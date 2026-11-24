# What would stop the mistakes that still get through

From the reading of 2026-11-24 (`reading.json`, head 124447f5): 8 of 49 judged
mistakes get through typecheck, lint, the models and the whole unit suite. The
first reading, at f26ab416, had 19 of 47. The 8 are the same as on 2026-11-22;
the two rows added since (f01, f02) are both stopped. Each line names the cheapest change
that would stop it, looking first for an architecture change, then a type, then
a lint rule, then a test.

## Words chosen inline in a component (6)

m15 and m48 were caught because their words live in a pure function with a table
test (`window-words.test.ts`, `download-rows.test.ts`). These six pick words or
icons inline, where no unit test looks. A words function per place would stop
them; whether that is worth the code is an open product call, since a glance at
the screen catches each one.

- m32, t42: the Copy Ollama name button's label (`Models.tsx`). One `copyLabel(state)`
  shared by both copy buttons.
- t39: the mic button's words while transcribing (`Voice.tsx`).
- t47: the slow mark in a measure row (`ModelMeasure.tsx`).
- n32: `update.log`'s result line is a template in `handoff.ts`. A
  `resultLine(result)` taking the result object, with a table test.
- n07: the malformed-line error in `stream.ts` cuts the line itself.

## Possibly not mistakes (2)

- n23: the one line in `arrive()` that ends the pending mark for Settings or
  Pictures. Read twice, no visible effect of dropping it was found below a
  browser. A browser journey (open Settings, then a thread, land on the thread)
  would say whether it is a mistake or a line that can go.
- t40: each measure handler checks `stop.signal.aborted` itself. Only Start
  begins work and it already refuses while the app closes, so the planted line
  changes nothing a person sees today. One admission for Measure would matter if
  Measure should also pause while an update installs, which is undecided.

## What stopped the others

| row | stopped by |
|---|---|
| n41, B095, m49 | typecheck: a union, a table keyed by the defaults, a branded path |
| B071 | lint: `parent-pid-is-passed` (the flaky test no longer carries it) |
| B041, m02, m38, n38, t13, t03, n27 | one behaviour test each, watched failing with the row's patch |
| n01 | nothing to stop: the guard it removed was dead and is gone (`no-place-left.tsv`) |
| f01 | a test that forces the order with real tar (a good archive failing to unpack, found 2026-11-24) |
| f02 | lint: `turn-end-not-polled` (a one-second poll of the running-turn count in a test) |

For m02, n23, m38, n38, t13 and t03 the state got one owner first. That cut the
places to one each and did not stop the mistake: a dropped line is a right-typed
wrong answer, and only a test of what a person sees refuses it.
