---
name: verify-models
description: "Check a change against the formal models of Gates Local: the reply queue (send, stop, hold, edit, remove, restart), GPU loading (the lease, the load gate, a stuck picture, a switch of runtime) and updates (the approval handoff, a start on a copy an update left unfinished). Use before finishing any change to apps/server/src/chat/reply.ts or replies.ts, apps/server/src/gpu, apps/server/src/runtime/load.ts or switch.ts, apps/server/src/image/module.ts, apps/server/src/update, packages/update/src, or the start and update-launch files of apps/desktop, and whenever node scripts/model-check.ts fails."
---

# Verify the models

Three TLA+ models in `model/` check every order of steps in the three places where order has caused
real bugs here. A test checks the orders someone wrote down. `model/README.md` is the overview; each
model's own README has its rules, bounds, assumptions and what it leaves out.

## Does my change touch verified code?

Run the check. It tells you. If you want to know first, these are the files, as confirmed at commit
f26ab416:

| Model | Read from the code on every run | Written by hand (a change fails the run until confirmed) |
| --- | --- | --- |
| reply | `apps/server/src/chat/reply.ts`: `move()`, `stillStarting()`, `toQueued()`, `fromQueued()` | `apps/server/src/chat/replies.ts`, `apps/server/src/app/queue-pump.ts`, `apps/server/src/app/admit.ts`, `apps/server/src/app/drawing.ts`, `apps/server/src/app.ts` |
| gpu | `apps/server/src/gpu/lease.ts`: `createGpuLease()` | under `apps/server/src/`: `gpu/gate.ts`, `gpu/memory.ts`, `runtime/load.ts`, `runtime/switch.ts`, `runtime/services.ts`, `image/module.ts`, `image/client.ts`, `app/admit.ts`, `app/run-turn.ts` |
| update | `packages/update/src/checkout-start.ts`: `decideCheckoutStart()`; `packages/update/src/admission.ts`: `createUpdateAdmission()`; the two deadline constants | `apps/server/src/update/module.ts`, `apps/server/src/update/installed/module.ts`, `apps/desktop/src/update-launch.ts`, `apps/desktop/src/checkout-start.ts`, `packages/update/src/cli.ts`, `packages/update/src/apply.ts`, `packages/update/src/startup.ts`, `packages/update/src/installed/transaction.ts` |

The record the check uses is `model/models.ts` (the files and the functions each stands for) and
`model/<name>/covered.json` (their hashes and the commit they were confirmed at). This table is a copy
for reading; when they disagree, those two are right.

## Run the check

```
node scripts/model-check.ts            # all three, about 6 s
node scripts/model-check.ts reply      # one
```

It needs Java 11 or newer and the TLA+ tools jar 1.7.4. If either is missing, the command says what to
install and where. Do not work around a missing tool: the check never skips, and neither do you.

Green is the last line `model-check: 3 models, 18 runs, all as required`. Anything else is red, and
every problem is listed under the last line.

## Read a red run

To read any result, use the `/statechart` skill: it tells a broken rule as its shortest path in plain
words, and draws how the system moves when the check passes. The check also writes each broken run as
numbered steps to `model/.out/<name>/<run>.trace.txt`. A step is the action, the code it stands for,
and what it changed.

There are four kinds of red.

**1. "X is broken by the code as it is now", with steps.** A rule fails. Go to "Real bug or modelling
error" below.

**2. "the code no longer fits the model's table".** A table file (`model/<name>/table.ts`) could not
turn the real function into a table: two things the model holds as one state now behave differently,
or a new input or job kind has no place. The message names the function and what differs. If your
change did not mean to make them differ, that is your bug. If it did, the model needs the new
distinction: see "When the change is meant".

**3. "<file> changed since the model was read against it".** You edited a file the model has by hand.
The model cannot see what your change did. See "When the change is meant", step 2.

**4. "the replay X PASSED"** or **"the open finding X no longer fails".** A replay is the model with one
guard switched off, and it must fail. If it passes, the model has stopped seeing that bug: your change
to the model removed the path, or made a rule too weak. Undo that. An open finding that stops failing
is good news: the app now keeps the rule by itself. Take its entry out of `model/models.ts` and the
model's README, and say so in your report.

## Real bug or modelling error

Take the numbered steps and walk them in the code, one by one. Each step names a file and a function.

- **Every step can happen in the code, in that order.** It is a real bug. Do not weaken the rule, add
  a guard to the model that the code does not have, or shrink a bound until it passes. Fix the code if
  that is your task. Otherwise report it with the steps, in the code's words, and leave the run red.
- **A step cannot happen in the code.** Find what prevents it in the code: a check, an `await` that is
  not there, a lock. The model is missing that. Add it to the action, with the file and function in the
  comment above it. Then run again and confirm that every replay still fails.
- **The model does one step where the code does two, or two where the code does one.** One action must
  be one step of the code with nothing able to come between. Split or join the action to match.
- **You cannot tell.** Say so, with the steps. Do not guess in either direction.

A model that passes because you made it less strict has told you nothing. The replays are the guard on
that: each must still fail after any change to a model.

## When the change is meant

1. **A function a model reads (`move()`, `createGpuLease()`, `decideCheckoutStart()`,
   `createUpdateAdmission()`).** There is nothing to copy: the next run reads the new behaviour. If a
   rule now fails, your change breaks it. Either the change is wrong, or the rule is being changed on
   purpose. A rule changes only with the owner's word: write the new rule in the `.tla` file and the
   model's README, and name the old one in your report.
2. **A file a model has by hand.** Open `model/<name>/<Spec>.tla` and find the actions whose comments
   name the function you changed. Make each action do what the code does now, in the code's names.
   Run the check. When it is green and you have read every changed function against its action, record
   the reading:

   ```
   node scripts/model-check.ts --confirm gpu
   ```

   That rewrites `model/gpu/covered.json` with the new hashes and the commit. Run it only after the
   reading. It is the one place a person or agent says "I checked", and nothing else checks it.
3. **A new guard for a bug you just fixed in modelled code.** Add a switch for it to the model
   (a `CONSTANT`, `TRUE` in the passing run), make the action without it do what the code did before,
   and add a replay to `model/models.ts` with the fix commit. The run must show it failing.
4. **A new file or function in scope.** Add it to `covered` in `model/models.ts` with what it stands
   for, model it, confirm.

Commit `covered.json` with the code change it confirms.

## What a green run does not tell you

- Only the bounds it prints: two messages and one window, two chats and one picture, two crashes.
- For the hand-written parts, that the model is right about the code. The tests that run those files
  for real do that: `apps/server/src/chat/reply-rules.test.ts`, `apps/server/src/gpu/rules.test.ts`,
  `test/update-handoff-rules.test.ts`, `test/update-crash-matrix.test.ts`.
- Anything in a model's "Not covered" list.
- The gpu model's rule against two loads at once rests on two things outside the app. Both are in
  `model/gpu/README.md` under "Open findings".
