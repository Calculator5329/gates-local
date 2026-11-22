# What would stop the mistakes that got through

From the reading of 2026-11-22 (`reading.json`, head f26ab416): 19 of 47 judged
mistakes got through typecheck, lint and the whole unit suite, and one (B071)
was caught only some of the time. Each line names the cheapest change that would
stop it, looking first for an architecture change, then a type, then a lint rule,
then a test. A change that would stop several is listed once with all of them.

## Architecture: one owner for a state that is cleared by hand today

Each of these keeps a flag, timer or message beside the real state and clears it
by hand on some paths. The planted mistake drops one clear. Holding the state in
one value that every path replaces makes the dropped clear impossible to write.

- m02: Updates keeps the last click's error next to the check. One
  `click: { kind, phase: "asking" | "failed", message }` value, which starting a
  click replaces, leaves no old error to forget.
- n23: `pendingSettings` is a module variable cleared inside `show()`. Comparing
  the navigation id it already has (`nav !== navGen`) is enough to say "pending";
  without the variable there is nothing to clear.
- m38: the supervisor clears `readyTimer` by hand on three exit paths. One
  `settle(launch, outcome)` that every exit calls, and that owns the timer, stops
  a path from leaving it running.
- t40: each measure handler checks `stop.signal.aborted` itself. Admission in
  one place, as chat sends have in `admit.ts`, means a new handler cannot skip it.
- t13: Stop beating an attach or image error is decided by a `stopFirst` wrapper
  around each save. Deciding a turn's end in one resolver that knows Stop came
  first keeps the order rule in one line instead of at every await.
- n38: after the updater starts, `main.ts` quits the app with its own
  `setTimeout`. The handoff that starts the updater should end the app itself, so
  no caller can start the updater and stay open.
- t03: `clone.ts` has its own output cap. One bounded-output collector for every
  child process the server spawns puts the cap where a new spawn gets it free.

## Type: make the wrong value unrepresentable

- n41: a source's `detail` travels with any state, so `{ state: "ready", detail:
  "The last refresh did not finish…" }` type-checks. With `detail` only on the
  `error` variant of a union, the planted line fails typecheck.
- B041: "running" is worked out in a filter on `t.end`. One exported
  `running(turn)` with an exhaustive `switch` on `end.kind` (ending in a
  `satisfies never`) makes every new end kind a type error until someone decides
  whether it is running. B010, the same store's earlier mistake, was caught by a
  test; this one was not.
- m49: `linux-install.ts` checks `path.isAbsolute` itself. A branded
  `AbsolutePath`, made only where the environment is read, would make the check
  impossible to drop: the function could not be called with a plain string.

## Lint: ban the call that is always wrong here

- B071 (caught only some of the time): the query child reading `process.ppid`
  after start is the whole mistake. A lint rule refusing `process.ppid` in
  `packages/harness/src` stops it every time. The test that targets it in
  `tools.test.ts` was red in one run and green in another with the mistake in.

## Words: move the choice of words out of JSX into a words function

m15 and m48 were caught because their words live in a pure function with a table
test (`window-words.test.ts`, `download-rows.test.ts`). These seven pick words
or icons inline in a component, where no unit test looks:

- m32, t42: the Copy Ollama name button's label (`Models.tsx`). One `copyLabel(state)`
  shared by both copy buttons.
- t39: the mic button's words while transcribing (`Voice.tsx`).
- t47: the slow mark in a measure row (`ModelMeasure.tsx`).
- B095: the Reset confirm lists settings by hand. Built from the same defaults
  table Reset uses, a removed setting leaves the list on its own (architecture, not
  only words).
- n32: `update.log`'s result line is a template in `handoff.ts`. A
  `resultLine(result)` taking the result object, with a table test.
- n07: the malformed-line error in `stream.ts` cuts the line itself. A words
  function with a table test.

## Test: what is left

- n27: `linux-lock.ts` holds 2,318 lines of pinned hashes by hand. A check that
  every `--hash=sha256:` is 64 hex characters stops this planted typo; only
  regenerating the file from its lock source and comparing would stop a wrong
  hash that is still well formed.
- n01: the drop overlay's leave path runs for drags that carry no files
  (`file-drop.tsx`). A test that drags text out of the window, in a DOM test or
  the browser suite.
