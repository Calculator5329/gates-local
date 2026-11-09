# Releasing

A release is an annotated `vX.Y.Z` tag on `main`. There is no hosted CI;
a release machine checks a stranger's fresh public clone before tagging.

```sh
pnpm release:check --remote <public-url> --commit <full-sha> --report <new-report.json>
pnpm release:tag v1.2.3 --report <new-report.json>
```

The check defaults to this clone's origin and current origin/main tracking
ref. Refresh that ref first. It clones into a new cache directory with a
fresh home and configuration, checks out the exact commit, installs with
`--frozen-lockfile`, runs `pnpm verify`, builds the web client with
`pnpm build`, then runs Playwright's blocking `e2e` project.
Every functional test and deterministic JS/CSS size budget blocks.
A failed blocking command, missing browser report or zero executed
unit/browser tests fails the release.

Timing is informational. After the blocking steps pass, a separate
`timing` project runs with its own 120-second limit, followed by bounded
process-group shutdown if needed. The release report records whether the
command completed, its exit code or signal, whether it timed out, and the
path to its raw report. Neither release-check nor release-tag parses or
uses the timing report to decide the verdict. A timing crash, missing,
stale or empty report, assertion failure or timeout cannot pass or fail
the release. Timing thresholds are unchanged.

The blocking project retains cold-load readiness/console-error checks,
all 400 rendered messages and complete typed input while idle, streaming
and busy. `pnpm e2e` runs that project; `pnpm e2e:timing` runs the
measurements and returns their own exit status. Screenshots and real
GPU/runtime checks are outside this gate. Existing skips are reported
as skipped, never passed.

Canceling the whole check fails it as interrupted, including during
informational timing. Cancellation settles after bounded shutdown
confirmation instead of waiting indefinitely for inherited output.
If writers remain after the owned group stops, the failed report records
the unconfirmed descendant shutdown, sets `scratchRemoved: false`, and retains
the clone. It does not kill outside the group or claim complete shutdown.

The JSON includes the exact commit, blocking steps and durations, test
totals, failures, versions and timestamps. Logs and browser reports sit in
`<report>.artifacts`; temporary checkout data is otherwise removed on
success and failure. Existing reports are never overwritten. Chromium is
installed unless `--browser-path <executable>` supplies one.
An explicit `--store-dir <path>` selects a seeded pnpm store and records
that limited evidence. The default uses an empty store.

Tagging is a dry run until `--push`. It checks the passing blocking
report, exact origin URL, current origin/main and HEAD, the main branch,
a new increasing version and a report from the last 24 hours. Immediately
before creating the tag and pushing, it fetches again and refuses moved
main or a newer/existing tag. A refusal leaves no local candidate tag.
After a failed push it removes only the unchanged tag created by this
invocation; pre-existing and replaced tags remain untouched.
The report is a record of a run, not proof against tampering.

Users receive releases through Settings › General › Updates or
`pnpm run app-update`. Checks happen on demand. Once a release tag exists,
the updater follows release tags and never goes backwards. Before the
first release, or with `--channel main`, it follows main. Manual
`git pull` remains the main-branch path described in the README.
