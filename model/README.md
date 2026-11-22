# Models

Three small TLA+ models of the places where the order of steps has caused real bugs. A test checks the
orders someone wrote down. A model checks every order of its steps, inside the bounds it prints.

| Model | What it is about | Read from the code on every run | Written by hand |
| --- | --- | --- | --- |
| [reply](reply/README.md) | the messages of one chat: send, stop, hold, edit, remove, restart | every answer of `move()`, `stillStarting()` and the saved row of each record | 5 files |
| [gpu](gpu/README.md) | two chats and a picture loading on one card, and a switch of runtime | every state of `createGpuLease()` | 9 files |
| [update](update/README.md) | an update from the approval to a copy that is whole again | every answer of `decideCheckoutStart()`, every state of `createUpdateAdmission()`, the two deadlines | 8 files |

## Run it

```
node scripts/model-check.ts            # all three, about 6 s
node scripts/model-check.ts gpu        # one
```

It needs Java 11 or newer and the TLA+ tools jar, version 1.7.4. When either is missing the command
fails and says what to install and where to put it. It never skips.

A run is green only when all of this holds:

- each model passes every rule;
- each replay fails. A replay is the model with one guard switched off, the guard that fixed a past bug;
- each open finding still fails. An open finding is a rule that holds only while something outside the
  app behaves (the gpu model has two);
- no file a model was written from by hand has changed since the model was last read against it.

## How a model stays true to the code

Two ways, and each model's README says which files get which.

**Read from the code.** `model/<name>/table.ts` calls the real function with every input and writes the
answers as a TLA+ module the model extends. Nobody copies a transition by hand, so the model cannot
drift from that function. A change that breaks a rule fails the run with the steps that break it.

**Written by hand.** The rest of each `.tla` file follows the code each action names in the comment
above it. `model/<name>/covered.json` holds a hash of every such file. When one changes, the run fails
and names the file. That is drift detection only: the model cannot see what the change did. Someone
reads the change against the model, fixes the model if it no longer describes the code, and records
the new reading:

```
node scripts/model-check.ts --confirm gpu
```

`model/models.ts` lists every model's bounds, rules, replays, findings and hand-modelled files with the
functions each one stands for.

## What a counterexample looks like

Each failing run is written to `model/.out/<name>/<run>.trace.txt` as numbered steps. A step is the
action, the code it stands for, and what it changed.

`.claude/skills/verify-models/SKILL.md` says how to tell a real bug from a modelling error and how to
change a model when the code change is meant.
