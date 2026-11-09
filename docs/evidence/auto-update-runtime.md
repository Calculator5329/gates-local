# Automatic update runtime acceptance

## Observed result, 2026-11-09 UTC

The approved virtual-screen runner passed all three focused browser tests
(exit 0). The real source-update harness then passed all eight checks
(exit 0), with no owned processes remaining in the cleanup receipt.
Product corrections are in `5999aff`; the harness is
`test/runtime/auto-update.mjs`. The final timed run is identified as
`update-transaction-timed-20261109T033048.143434Z` in the private receipt.

| Real check | Result |
| --- | --- |
| No sidebar button before the automatic check | Passed |
| Local newer commit found automatically; five surrounding boxes unchanged | Passed |
| Server reservation refuses replies, images and downloads from another client; cancellation reopens admission | Passed |
| Actual install, both builds, reopen on the full approved commit B | Passed |
| Stop a streaming reply through normal app shutdown | Passed |
| Reopen stored partial text with its interrupted marker and visible unfinished label | Passed |
| Commit C fails the web build; restore/build/reopen B with failure note and log | Passed |
| Manual pull/install/start reaches D and retains the interrupted thread | Passed |

| Journey | Click to ready | Window close to ready |
| --- | ---: | ---: |
| Successful update | 4,753 ms | 4,293 ms |
| Failed build and rollback | 6,188 ms | 5,782 ms |

Ready means the reopened composer is available, observed over CDP after the
new desktop PID is recorded. These are single observations on a virtual
screen with cached offline dependencies and fake services, not predictions
for an uncached owner install. During the gap there is no app window or
progress display. The full-display recording's 18-second frame was inspected
and shows only the empty virtual desktop during the successful-update gap.

The harness creates fresh seed/working clones and a bare local remote, with
file-only git transport, independent copied dependencies and isolated app
data/profile paths. It verifies the pre-provisioned Electron archive against
the package checksum. A fixture-only entry loads the production main and
sets a separate local debugging port per launch; it does not replace the
updater, bridge, server, builds or UI. No public remote or owner checkout is
used.

Inspected final screenshots: `updated.png`, `interrupted-reopened.png`,
`rolled-back.png` and `manual-start.png`; the prior complete run's
`update-available.png` was also inspected. The final recording is
`update-journey.mp4` (49.4 seconds). The rollback banner retains a verbose
raw build-error tail that can overflow horizontally; this is not a claim
of polished failure presentation. Console errors were not counted by this
harness.

Windows remains unproven. Automatic
off, overlapping checks, remote-advance races, and download resume are not
additional runtime claims here; the focused unit tests cover the first
three and the download flow remains unchanged.

## Original acceptance plan

The following was written before runner access. Its additional scenarios
are a plan, not a claim that every one was exercised.

## UI probe

Filter `test/e2e/updates.spec.ts` through the runner. It checks absence then
appearance, exact bounding boxes for five surrounding elements, cancellation
and acceptance while a reply streams, and a 390 px phone without an install
button. This probe substitutes update status and the bridge only; it does
not prove the transaction or reopening.

## Real source-update journey

Use a fresh cache directory, a local bare repository, a seed clone and a
working clone. Seed from this lane's committed head. Every test git remote
must be the local bare repository before launching the app. Do not use a
host checkout or its data directory as an update target. Set
`GATES_LOCAL_UPDATE_TEST_ROOT` to the scratch root. Set all data, userData,
XDG and Electron profile locations under that root. Keep the artifacts.

Use the existing fake Ollama and fake GPU files, pin the fake URL, set
`GATES_LOCAL_RUNTIME=discover-only` and `GATES_LOCAL_OLLAMA_BINARY=none`.
Disable phone listeners and ComfyUI. Dependencies and Electron must already
be cached; install offline and refuse a missing cache rather than reaching
GitHub. Use a fresh Electron profile and a runner-owned display, never an
existing window. Do not share node_modules with a host checkout.

1. Install/build the working clone at commit A. Start its real Electron app
   on the virtual screen with its own data folder and profile. Record the
   full commit, process identity and screenshot.
2. Make commit B in the seed, changing visible release text or a harmless
   source constant. Update only the local bare remote. Wait for the real
   15-second check. The sidebar button must name B and its subject without
   a manual check. Confirm all remotes still point inside the scratch root.
3. Record the click timestamp and window-close event. Click the actual
   sidebar control. Observe the window close, the real pnpm install and
   both builds in the update log, then the real app reopening. Assert HEAD
   is B and the next-start note names B. Record close-to-reopened-ready ms,
   and click-to-reopened-ready ms separately. Attach the video and log.
   During the gap there is no app window or progress display: the updater
   runs detached and logs to the app data folder. No predownload exists.
4. Close only this test app. Make C in the seed with a deterministic web
   compile error. Update only the local bare remote. Restart B, wait for
   the automatic button and click. Assert the failed build restores B,
   installs/builds B, reopens B, and shows the stopped result with its full
   log. Retain the failing log and rollback record. Measure this gap too.
5. Close the test app. Advance the remote from C with a new commit D fixing
   the compile error. In the working clone run `git pull`, `pnpm install`
   (offline cache), `pnpm start`. Assert D starts and retains the existing
   thread database. This proves the documented manual path independently.
6. Repeat a check with automatic checking off. Observe no git child or
   remote request from this path for the startup interval. Click the manual
   check and verify it still finds a newer commit. Re-enable only in the
   test profile. Repeat with two clients and count exactly one fetch.
7. Start a slow fake reply, a fake model download and a queued fake image
   job. The warning must name all three, including a reply in another
   client. Cancel and assert they continue. Accept on another run; verify
   partial reply text persists and downloaded model parts can resume.

Capture commands, environment variable names (no tokens), exits, tested
head, exact bundle bytes, screenshots, timing events and logs in the runner
receipt. Do not publish a duration until it is actually measured there.
Windows behavior cannot be proven under Linux or WSL and remains unverified.
