# What the unit suite is worth, read in November 2026

Question: which unit test files could be retired because nothing depends on them alone?
Answer: on this evidence, none. The reading was stopped on 2026-11-23 before it finished,
and the suite stays as it is. This note is here so the same cut is not tried again without
new evidence.

## How it was read

Each unit test file was paired with the source it tests. Small breaks were planted in that
source (a dropped line, a flipped condition, a wrong constant), one at a time, and the whole
gate was run on each: typecheck, lint, the models, then the unit suite. A plant counts for a
test file when that file went red and nothing else did. Separately, the real past mistakes
in `test/mistakes/` were put back one at a time and the file that stopped each was recorded.

## What it found

| | files | plants |
|---|---|---|
| First pass, fully judged | 192 | 2,461 |
| Second pass (files with no only-it catch in the first) | 31 | 620 |
| Planned, never judged | 33 | 568 |

- 128 plants were stopped by exactly one unit test file and by nothing else in the gate.
- Types stopped 331 plants and lint 54 before any test ran.
- 27 real past mistakes were replayed against the planted files. Eight files alone stop one:
  `times`, `draft-recovery`, `copies`, `load`, `run-signal`, `app-state`, `download-rows`
  and `session-actions`.
- Read as keep: 125 files (26,411 lines). Another 49 files (15,468 lines) guard security or
  legal behaviour and were never candidates.
- Not read: 98 files (21,465 lines).
- Safe to retire: 0. One likely candidate by hand read, `own-copy.test.ts`, whose cases
  `window-words.test.ts` also holds; it was not removed.

## What this does not show

A plant is a small local break. A file that catches no plant alone can still be the only
thing that would catch a larger wrong rewrite, so "zero only-it catches" was a reason to
read a file by hand, never a reason to remove it. Nineteen such files were read by hand and
all nineteen stayed, each for a named behaviour held nowhere else. The 98 unread files are
unknown, not safe.

## What to do with it

Leave the suite. When a unit test is in the way of a change, the question to ask of that
one file is the one this reading asked: put the break back and see what else goes red.
