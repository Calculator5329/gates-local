# Update

An update, from the person's approval to a copy that is whole again. Two halves: the handoff from the
running app to the updater (a copy run from source and an installed copy), and what is on disk while
the updater changes a copy run from source, with crashes and power cuts at any step.

## The rules

| Rule | In plain words | The harm when it breaks |
| --- | --- | --- |
| `NoNewWorkOnceApproved` | Once an update is approved and goes ahead, no reply, image job, download or import began after the approval. | Work the person just started is cut off when the app closes. |
| `ALateCancelCannotReopenAdmission` | After main has taken the approval over, the window's key opens nothing. | A reloaded page lets work in under an update that is going ahead. |
| `NoAppRunsOnAHalf` | No app runs on a copy that is part way between two versions. | The app runs old code against new files, or the other way round. |
| `NothingUnfinishedMeansWhole` | When nothing is saved as unfinished, the copy is whole. | A broken copy that nothing will ever repair. |

## Bounds

Two approvals, two crashes, three starts by the person. Run twice: `Kind = "checkout"` (a copy run from
source) and `Kind = "installed"`. Printed on every run.

## Tied to the code

`table.ts` reads three things on every run and writes them as the module `UpdateCode`:

- `StartCode`: what `decideCheckoutStart()` in `packages/update/src/checkout-start.ts` answers for every
  saved update (none, forward, launch with a token, launch without, back), with and without a running
  updater, on a first start and on one after a finish attempt, with no token and with the matching one.
  40 answers.
- `AdmStep`: `createUpdateAdmission()` in `packages/update/src/admission.ts`, driven with Node's fake
  timers through reserve, commit (the default wait and the long one), cancel with each key, a lost
  connection, the timer and close. A state is named from the code's own answers: is work let in, who
  can cancel, how long until it opens by itself, how long after the connection is lost. 7 states, 56
  steps.
- `Deadline`: `HANDOFF_GRACE_MS` and `INSTALLED_APPROVAL_MS`, the constants the code uses.

## Written by hand

Listed in `model/models.ts` with the functions each stands for; hashes in `covered.json`.

- `apps/server/src/update/module.ts`, `apps/server/src/update/installed/module.ts`: prepare, commit, cancel
- `apps/desktop/src/update-launch.ts`: `launchApprovedUpdate()`
- `packages/update/src/cli.ts`: the wait for the old app and the deadline read after it
- `packages/update/src/apply.ts`: `transact()`, `recover()`, `installAndBuild()`, `goBack()`
- `packages/update/src/startup.ts`, `packages/update/src/installed/transaction.ts`
- `apps/desktop/src/checkout-start.ts`: `startCheckout()`

For these the model only detects that a file changed. `test/update-crash-matrix.test.ts` and
`test/update-handoff-rules.test.ts` run them for real.

## Replays

| Replay | Rule it must break | Past bug | Guard switched off |
| --- | --- | --- | --- |
| `start-on-a-half` | `NoAppRunsOnAHalf` | A copy run from source was started on a half-installed update. Fixed in 69973b02. | `decideCheckoutStart()`, asked by `startCheckout()` before anything runs |
| `short-grace` | `NoNewWorkOnceApproved` | An installed copy's server let work back in after 5 s while its updater gave the old app 30 s. Fixed in 69973b02. | the installed commit passes `INSTALLED_APPROVAL_MS` as the wait |

## Assumptions

- A wait at least as long as the updater's deadline cannot end before that deadline, because the
  deadline is counted from before the commit and the wait from after it. This is the one place where
  two lengths of time are compared; everything else is order only.
- A crash in the middle of a command leaves what that command had half done. A merge or a reset cut
  off leaves the files part way (`torn`).

## Coarser than the code

- A finish attempt made by a start (`--finish`) is inside the start's one step.
- The updater's commands are begin and end pairs; nothing happens inside one but a crash.

## Not covered

- An installed copy's files: its watcher rows and file moves. The installed run covers the handoff only.
- A second update on top of an unfinished one, and a launch token that does not match.
- A hand repair of a copy left part way. The code refuses to start it and changes nothing; the model
  stops there too.
- Admission's `finishing` mode at a start.
- Windows.

## Confirm again after a change to a hand-modelled file

Read the change against `Update.tla`, change the model if it no longer describes the code, then:

```
node scripts/model-check.ts --confirm update
```
