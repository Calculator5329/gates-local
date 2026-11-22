# Gpu

Loading against one graphics card: two chats that want different models, one picture, and a switch of
runtime between the Ollama the person runs and the app's own.

## The rules

| Rule | In plain words | The harm when it breaks |
| --- | --- | --- |
| `NeverTwoLoadingAtOnce` | At most one model or picture setup is loading at any moment. | Two loads fight for the card: both crawl, or one runs out of memory. |
| `ARunningReplysModelStaysLoaded` | While a reply runs, its model stays in memory. | A reply is cut off because another job asked its model to leave. |
| `NoStaleRecordAfterASwitch` | Once a switch has settled, the app's record names nothing that is not in the runtime in use. | The app thinks it loaded a model it did not, and asks or refuses on that. |
| `ARefusedSwitchForgetsNothing` | A refused switch leaves the record of what the app loaded as it was. | The app's own model is later treated as another program's and never asked to leave. |
| `NothingPassesAWaitingPicture` | No chat is granted the card past a picture that is waiting for it. | A picture waits for ever while chats keep arriving. |
| `NoTwoWaitOnEachOther` | Nobody holds the card and waits for the load gate while the gate's holder waits for the card. | Both stop for good. |
| no deadlock | Some step is always possible. | Everything stops. |

## Bounds and sizes

Two chats (`c1` wants `m1`, `c2` wants `m2`), one picture, two switches. The card holds 5: the voice
server takes 1, a chat model 2, the picture's models 2. So one chat model and the picture fit together
and two chat models and the picture do not. Printed on every run.

## Tied to the code

`table.ts` drives the real `createGpuLease()` in `apps/server/src/gpu/lease.ts` with two chat claims and
one image claim through every ask, release and abort, and writes every state it reaches (14) and every
step between them (42) as the module `LeaseCode`. The model holds no rule of its own for who gets the
card.

`MODELLED` in `table.ts` lists every job kind. `bench` and `dream` are left out, and the run fails if
one of them becomes a kind that shares the card.

## Written by hand

Everything but the lease. Listed in `model/models.ts` with the functions each stands for; hashes in
`covered.json`. All under `apps/server/src/`:

- `gpu/gate.ts`, `gpu/memory.ts`
- `runtime/load.ts`, `runtime/switch.ts`, `runtime/services.ts`
- `image/module.ts`, `image/client.ts`
- `app/admit.ts`, `app/run-turn.ts`

For these the model only detects that a file changed. A break in one of them is not seen by the model
until someone reads the change against `Gpu.tla`. The tests in `apps/server/src/gpu/rules.test.ts` run
these files for real, each rule with its guard off.

## Replays

| Replay | Rule it must break | Past bug | Guard switched off |
| --- | --- | --- | --- |
| `stuck-picture` | `NeverTwoLoadingAtOnce` | A picture's Stop timed out, the card was given back, and a chat model loaded beside the picture still loading. Fixed in 7cac7552. | `heldWhileStuck()` in `image/module.ts` |
| `refused-switch` | `ARefusedSwitchForgetsNothing` | A refused switch forgot which models the app had loaded. Fixed in 7cac7552. | `runtimeKept()` in `runtime/load.ts` |

The guards are switches inside the model (`StuckPictureKeepsLease`, `RefusedSwitchKeepsRecord`), because
both files are written by hand here.

## Open findings: two rules that rest on something outside the app

`NeverTwoLoadingAtOnce` holds in the passing run only under two assumptions. Each has its own run with
the assumption off, and that run must still fail. If one stops failing, the app keeps the rule by itself
and the entry comes out of `model/models.ts`.

1. `abandoned-load`: a reply is stopped while its model loads. `runtime/load.ts` `end()` gives back the
   gate and the lease at once. If Ollama goes on loading a model whose request was dropped, the next
   chat waits for it to leave, the wait ends, and its own model loads beside it. The rule holds only
   with an Ollama that gives up a dropped load. `rules.test.ts` writes the same assumption down ("today's
   assumption, written down").
2. `foreign-engine`: a picture is stopped and ComfyUI does not let go. The lease is kept for
   `STUCK_HOLD_MS`, then given back. A ComfyUI the app started is stopped at that point. One the app did
   not start is never stopped, so it may still be at the picture when the next load begins. That was
   decided in 7cac7552.

## Coarser than the code

- Asking for the lease and reserving the load are one step. The handoff (everything else asked to leave)
  is one step.
- Time is steps. A wait with a limit is two actions: the thing happens, or the limit passes.
- Sizes are the small whole numbers above, not megabytes.

## Not covered

- The voice server (it is a fixed 1 that nothing touches), and the person's own Ollama being stopped.
- Measurements and what a refusal says.
- Preloads, `stopIdle`, keep-alive, `holdsOne`, `freeOthers`, a second card.
- `bench` and `dream` jobs.
- That a waiting picture gets its turn in the end. The model checks only that nothing is granted past it.
- The record `end()` writes late.

## Confirm again after a change to a hand-modelled file

Read the change against `Gpu.tla`, change the model if it no longer describes the code, then:

```
node scripts/model-check.ts --confirm gpu
```
