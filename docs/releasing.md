# Releasing

## Build installable copies

From a clean checkout with Node 24 and pnpm 11 installed, run:

```sh
pnpm install --frozen-lockfile && pnpm package:linux
```

The unsigned Windows x64 NSIS build command passed natively in the limited
Windows SSH check below. The earlier Linux/Wine cross-build failed:

```sh
pnpm install --frozen-lockfile && pnpm package:win
```

The default Windows filename is `dist/installer/Gates-Local-0.0.0-dev-Setup-x64.exe`.
On Linux, the Windows cross-build downloads a pinned portable Wine build
tool to generate NSIS's uninstaller. Wine is not shipped with the app, and
cross-building is not a Windows installation test. Native Windows builds
do not need Wine. A failed NSIS build can leave an intermediate executable
at that filename; never treat its existence as a completed installer.

The unsigned x64 AppImage is written to
`dist/installer/Gates-Local-0.0.0-dev-x86_64.AppImage`.
`GATES_LOCAL_BUILD_VERSION=1.2.3 pnpm package:linux` supplies a build version;
it does not create a tag, release or upload. All packaging runs use
`publish: never`. Built artifacts are ignored by Git.

Packaging uses electron-builder 26.18.0, a desktop-only development
dependency, because it supports AppImage and Windows NSIS installers in
one tool. No installer has been published. Native silent install, packaged
bridge readiness, a missing-runtime first-run screen, Origin admission and
two-build persistence are measured below. SmartScreen and interactive
double-click behavior remain unobserved.

The AppImage contains Electron 45 and its Node runtime, the sandboxed
preload, built web client, bundled local server and source-import worker.
The server runs through the bundled Electron executable in Node mode.
There is no separate Node or pnpm launch step for the installed app.
The packager uses the installed Electron version resolved by the lockfile,
rather than interpreting a dependency range as the runtime version.
Bundled JavaScript dependencies' licenses are included in
`THIRD-PARTY-NOTICES.txt`; Electron's own notices are also retained.
Optional features still require their own tools and runtimes, such as
Ollama, ComfyUI and Git for repository imports.

The Linux AppImage needs a FUSE 2 compatibility package on most distributions.
On Ubuntu 24.04 and newer, the one-line fix is `sudo apt install libfuse2t64`;
older Ubuntu/Debian systems use `libfuse2`, and Arch uses `fuse2`.
Mark the AppImage executable in its file properties, then open it.
Normal execution failed in the test Linux environment before Electron
started because `libfuse.so.2` was absent. See the
[AppImage FUSE instructions](https://docs.appimage.org/user-guide/troubleshooting/fuse.html).
No system libraries or kernel settings were changed during the check.

If FUSE cannot be installed, AppImage documents this fallback:

```sh
./Gates-Local-0.0.0-dev-x86_64.AppImage --appimage-extract-and-run
```

The fallback requests FUSE-free extraction without requesting that
Chromium's sandbox be disabled. Do not add
`--no-sandbox` to user launch instructions. The earlier test-only captures
used that flag, so they do not establish a sandboxed desktop launch.
The builder's launcher can itself add `--no-sandbox` when user
namespaces are unavailable, and its generated desktop entry defaults to
that flag. BrowserWindow's sandbox setting alone does not prove Chromium
sandboxing is active. No application-menu integration is installed by this build.

Packaged app data stays outside the image at
`$XDG_DATA_HOME/gates-local-installed` (default
`~/.local/share/gates-local-installed`) on Linux, and
`%LOCALAPPDATA%\GatesLocalInstalled` on Windows. Its Electron profile uses
`$XDG_CONFIG_HOME/gates-local-installed` (default
`~/.config/gates-local-installed`) or `%APPDATA%\gates-local-installed`.
Those separate profiles also keep the single-instance locks apart.

Developer launches retain their original data defaults:
`$XDG_DATA_HOME/gates-local` and `%LOCALAPPDATA%\GatesLocal`, with the
`gates-local` Electron profile. No chats or other data are copied from the
clone into the installed app. Earlier development AppImages that shared
the clone's paths are not migrated automatically either.

`GATES_LOCAL_DATA_DIR` still wins for server data. An explicit
`GATES_LOCAL_USER_DATA` still chooses the profile and, without a data-dir
override, keeps server data in its `server-data` subdirectory. These
overrides intentionally allow the caller to choose a shared path.

Packaged copies show **Standalone copy** in Updates and say they cannot
check for updates or update themselves. Install a replacement build
manually when one is available. Packaged updating needs a distribution
and update-metadata path, an updater integration with the supervised
server's shutdown, and replacement/rollback tests. It is not implemented.
The clone path remains: close Gates Local, `git pull`, `pnpm install`,
`pnpm start`. Its existing in-app updater is unchanged.

### Linux checkpoint, 2026-11-09

Run label: `installer-linux-first-run`. A source snapshot, excluding local
build outputs and dependencies, installed from the frozen lockfile and
built the AppImage in the test machine's Linux environment. The runner
reuses a dependency cache, so this was not a fresh public clone or an
empty-cache installation.

The diagnostic probe can be repeated there after building:

```sh
node apps/desktop/scripts/packaged-smoke.ts dist/installer/Gates-Local-0.0.0-dev-x86_64.AppImage
```

It opens the actual AppImage using `APPIMAGE_EXTRACT_AND_RUN=1`,
`--no-sandbox` and `--disable-gpu`, with a fresh isolated profile,
discover-only runtime and an unused Ollama port. It measured:

- `app.isPackaged === true`; the real bundled server starts and creates SQLite.
- The first-run screen says **Ollama is stopped** and shows Retry.
- The renderer's measured `Origin: gates-local://app` gets WebSocket 101.
- With the valid launch token, `file://`, `null`, `http://evil.example`
  and `gates-local://other` each get 403.
- The packaged update action refuses without quitting or invoking the clone updater.
- No observed renderer page errors; no remaining runner-owned processes after shutdown.

The probe writes `dist/packaged-smoke/first-run.png` and `report.json`.
The initial run's report used the hardcoded label "missing Ollama with
Retry"; the screenshot shows the actual stopped-runtime screen. Future
reports read the heading from the page. The original run record is retained.
It is diagnostic evidence, separate from the existing `pnpm verify` gate.
No real model service, model download or GPU generation was exercised.
At this first checkpoint, upgrade persistence, normal launch and Windows
installation were still unverified. Follow-up evidence is recorded below.

### Linux build-to-build persistence, 2026-11-09

The `installer-linux-upgrade-normal` run built versions `0.0.1-test` and
`0.0.2-test` from the same application source. It opened the older image,
saved settings and a thread through the real server, and saved a profile
localStorage marker. After closing it, the probe added a completed-message
fixture through the thread store and a file fixture in the models folder.
It archived the installed image and replaced it at the same path with the
newer image, without uninstalling.

The newer app reported the different build version and read the same
settings, thread, completed message and localStorage marker. The model
file's hash was unchanged. The message appeared in the renderer. Both
`GATES_LOCAL_DATA_DIR` and `GATES_LOCAL_USER_DATA` were unset: the server
resolved `$XDG_DATA_HOME/gates-local`, and the profile used the XDG config
directory. The XDG bases were fresh test directories in the user's cache.

This proves replacement persistence for those records across these two
builds, not compatibility with a future schema migration. The message and
model file were fixtures; no real model was downloaded or loaded. The
successful persistence run used extraction mode and `--no-sandbox`.
These initial runs predate PK-01: the packaged paths still matched the
developer paths. They did not establish developer/installed isolation.

```sh
GATES_LOCAL_BUILD_VERSION=0.0.1-test pnpm package:linux
GATES_LOCAL_BUILD_VERSION=0.0.2-test pnpm package:linux
node apps/desktop/scripts/packaged-upgrade.ts dist/installer/Gates-Local-0.0.1-test-x86_64.AppImage dist/installer/Gates-Local-0.0.2-test-x86_64.AppImage
node apps/desktop/scripts/packaged-normal.ts dist/installer/Gates-Local-0.0.2-test-x86_64.AppImage
```

The first run's persistence report and screenshot were written before
Playwright itself crashed during the subsequent normal-launch attempt.
That overall run exited 1. The normal-launch probe now uses a direct
process launch to retain errors before Electron starts, rather than
depending on Playwright's Electron launcher for that measurement.

The follow-up run `installer-upgrade-normal-nsis` repeated the upgrade
successfully with the final packaging configuration. Its direct normal
launch supplied neither extraction mode nor `--no-sandbox`; it exited 1
with `dlopen(): error loading libfuse.so.2` and `AppImages require FUSE to
run.` This establishes that ordinary execution does not reach the app in
that Linux/WSL environment. It does not measure other Linux distributions
or a file manager click on a different desktop.

The same run then attempted `pnpm package:win`. Windows application
packing and resource editing completed, but NSIS failed while running its
uninstaller-generation executable under portable Wine 11. The error was
`failed to load .../ntdll.dll error c0000135`; `wineboot` could not start.
The overall run exited 1, and the runner reported no remaining owned
processes. The retained `.exe` is an intermediate, not an installable
artifact. No alternative Windows access route was attempted.

### PK-01: separate packaged defaults, 2026-11-09

The initial AppImages shared the clone's default server directory and
Electron profile. This let a packaged launch focus an open developer app
through the same single-instance lock, and let sequential launches modify
the same threads, settings and owned-runtime state.

Main now chooses the packaged profile before taking the lock and passes
the packaged mode into server-directory selection. The clone's paths and
both explicit Gates path overrides retain their prior behavior. No clone
data is migrated.

The diagnostic check in `apps/desktop/test/packaged-paths.test.ts` was
observed failing first: identical profiles and identical Linux/Windows
data paths produced three failures, while override precedence passed.
After the fix the focused check passed twice; the existing developer-path
tests passed unchanged. This lane wrote the new probe, so it is not an
independent review or a new run-path gate.

Run `installer-pk01-default-paths` built `0.0.3-test` and `0.0.4-test`,
kept a real unpackaged Electron developer instance open, and launched both
AppImages in sequence. Neither `GATES_LOCAL_DATA_DIR` nor
`GATES_LOCAL_USER_DATA` was set. The XDG data and config bases were fresh
test directories. The packaged apps used `gates-local-installed`; the
developer app used `gates-local` for both data and profile.

Both packaged launches held their own instance lock. The packaged upgrade
preserved the settings, thread, completed-message fixture, profile marker
and model-file fixture. The developer app retained only its own thread,
settings and profile marker; neither profile saw the other's marker.
The run exited 0 with no remaining owned processes, and wrote
`dist/pk01-upgrade/upgrade.json` and `upgraded.png`.

```sh
GATES_LOCAL_BUILD_VERSION=0.0.3-test pnpm package:linux
GATES_LOCAL_BUILD_VERSION=0.0.4-test pnpm package:linux
node apps/desktop/scripts/packaged-upgrade.ts dist/installer/Gates-Local-0.0.3-test-x86_64.AppImage dist/installer/Gates-Local-0.0.4-test-x86_64.AppImage dist/pk01-upgrade
```

This still uses extraction mode and `--no-sandbox` in the Linux test
environment. Real model use, Windows simultaneous launches and native
Windows installation remain unverified. Windows path selection is covered
by the logic checks; it has not been measured in a Windows desktop run.

### Windows installation evidence still required

NSIS is configured for a per-user one-click install, without elevation,
with app data retained on uninstall and the app launched after installation.
Signing is disabled explicitly; executable icon and version resources are
still applied. These are build settings, not observed installation screens.

Native PowerShell SSH was subsequently approved for one limited build and
non-interactive installation round. The logged-in desktop, interactive
scheduled tasks, psexec and RDP were outside that approval. This round did
not observe SmartScreen or a Windows double-click launch.

### Limited native Windows round, 2026-11-09

Source commit: `f1e47c03ee221a4e49cf6313ef7e602c3d5b14b3`, which includes
the PK-01 fix. `git archive` produced the source archive, and `scp` moved
it to one new lane-owned directory under the Windows user's `.cache`.
No existing checkout or WSL directory was used. Build caches, source,
temporary files and proposed install/profile directories were all assigned
under that lane directory; process environment changes were not persistent.

Before the attempted dependency/build step and before cleanup, the
controller checked the shared run records for unfinished perf/exclusive
runs. One stale exclusive record lacked its result file, and the owner
explicitly confirmed it had finished. Its original records were retained.
The lane did not take an exclusive slot.

1. **Native build stopped before dependency installation.** The harness
   successfully extracted the committed source. Its Node home-directory
   preflight invoked `node -p 'require("node:os").homedir()'` through
   PowerShell. Native argument handling removed the inner quotes, so Node
   received `require(node:os).homedir()` and raised a syntax error. Node
   reported `v24.18.0`. The missing result then failed the harness's path
   check. Neither `pnpm install --frozen-lockfile` nor `pnpm package:win`
   was reached. This was a harness error; Windows packaging was not tested.
   There is no installer filename, size, hash or signature result for this round.
2. **Silent installation was not attempted**, following the first-failure
   stop rule. A separate read-only PowerShell preflight had reported fresh
   lane paths in USERPROFILE, APPDATA, LOCALAPPDATA and TEMP, with PATH
   containing only Windows system directories. `Get-Command` found no
   Node, pnpm or Git on that PATH. These are observations of the preflight
   process, not an installer or app process.
   The native known-folder APIs nevertheless returned the real user's
   roaming, local and profile directories. Changing those environment
   variables alone did not establish native shell/profile containment;
   no installer or Electron app was launched to investigate further.
3. **Packaged smoke was not run.** Packaged server startup, actual installed
   data/profile destinations and renderer-Origin admission remain unproven
   on native Windows. No server-only substitute was counted as an app pass.
4. **Upgrade was skipped** because the first step failed.
5. **No uninstaller was run** because nothing was installed. Installer file
   removal, retained app data and HKCU cleanup behavior remain untested.
   After preserving the failure evidence, the controller deleted only the
   newly created lane directory and confirmed it was absent.

The first harness was not retried within that round. The owner then
approved the second round below, using script-file checks and real packaged
per-user locations only after confirming that each target was absent.
Observing SmartScreen or a real double-click launch requires separate
interactive authorization. Download-zone provenance must also be recorded:
a copied file without Mark of the Web does not establish what an Internet
download shows.

### Native Windows retry: install passes, readiness check fails

Source commit: `b145c26c11f2869ac4aae60bac3c47c8358b7214`. Source was sent
with `git archive` and `scp` into a new lane-owned cache directory. Every
native check ran from a script file there; no inline Node expression was
passed through PowerShell. The initial transport check reported Node
`v24.18.0` and pnpm `11.10.0`, both with exit 0. Dependency installation
and native packaging also exited 0. No exclusive slot was held; the shared
perf/exclusive run check was clear before each heavy step.

Build artifact: `Gates-Local-0.0.6-native-Setup-x64.exe`, **121,709,862 bytes**.
Windows Authenticode reported `NotSigned` with no signer certificate.
The SHA256 from Windows matched the downloaded file:

```text
b6106c5f65aa7a9f6fdb19f4e47b9a4301fffcff7fc71be370f85251ea02c610
```

The pre-install script used the path helpers in `data-dir.ts`, the packaging
configuration and electron-builder's actual NSIS UUID derivation to resolve
these defaults. All were recorded absent before installation:

| Object | Resolved location |
| --- | --- |
| Server data | `%LOCALAPPDATA%\GatesLocalInstalled` |
| Electron profile | `%APPDATA%\gates-local-installed` |
| NSIS installation | `%LOCALAPPDATA%\Programs\gates-local` |
| HKCU uninstall key | `Software\Microsoft\Windows\CurrentVersion\Uninstall\ad51258f-e334-5179-a4a4-78de1f1212b5` |
| HKCU install key | `Software\ad51258f-e334-5179-a4a4-78de1f1212b5` |

The Start Menu shortcut, desktop shortcut, app-ID key and corresponding
HKLM install key were absent too; no Gates Local process was already running.
An existing target would have stopped the test without reuse or deletion.

The equivalent native commands were:

```powershell
node --version
pnpm --version
pnpm install --frozen-lockfile
$env:GATES_LOCAL_BUILD_VERSION = '0.0.6-native'
pnpm package:win
& $installer /S --no-desktop-shortcut
& $installedUninstaller /S
```

Silent installation exited 0 at the actual NSIS default path, without a
`/D` override. It created the app, its own uninstaller, Start Menu shortcut
and HKCU install/uninstall keys. The supported `--no-desktop-shortcut` flag
prevented a desktop shortcut. The test did not drive the logged-in desktop.

The install and smoke used the real user profile and app-data roots, a
lane-owned TEMP, and a process PATH of
`%SystemRoot%\System32;%SystemRoot%`. A child check found no Node, pnpm or
Git on that PATH. Neither Gates data/profile override was set. This did
not change PATH or other environment settings persistently.

The smoke launched the actual installed executable and reached its main
process, window and preload bridge. Main reported `app.isPackaged === true`,
version `0.0.6-native`, bundled Node `24.22.2`, the system-only PATH and the
expected real packaged profile. The data-folder IPC returned the expected
real server directory, and a `threads.sqlite` file existed there afterward.
Thus the bundled server executed at least part of initialization.

**The smoke failed its server-readiness assertion.** It attempted to wait until
the supervisor settled, but retained only a readiness boolean. The diagnostic
round below found that its async `waitForFunction` predicate returned early;
this report does not establish a server crash or readiness timeout. The first-run
screen, painted screenshot and renderer/foreign-Origin checks were not
reached. No server-only fallback or alternate executable was counted as a
pass. The app was not retried, and the upgrade was skipped after this failure.
Only lane-owned HTTP 404 endpoints stood in for missing model services;
no actual Ollama or ComfyUI was started, stopped or contacted.

Cleanup used `Uninstall Gates Local.exe /S`. Its exit was 0; the install
directory, app files, Start Menu shortcut and both NSIS HKCU keys were gone.
The new data and profile directories remained, matching
`deleteAppDataOnUninstall: false`. The app-ID/HKLM keys and desktop shortcut
were absent. No app process needed to be forcibly stopped.

After recording those leftovers, cleanup removed only the two data/profile
directories that had been absent before this run. Every recorded package
object was confirmed absent, then the lane cache directory was removed and
confirmed absent. No pre-existing target was reused, moved or deleted.

This proves native build, unsigned artifact identity, silent install,
default path selection, partial server initialization and the measured
uninstaller behavior. It does not prove a working native first-run screen,
ready server, renderer-Origin admission, upgrade persistence, SmartScreen,
or a real double-click launch. No interactive desktop route was used.

Unsigned downloads can receive reputation warnings or be blocked by local
policy; do not promise a particular dialog or a bypass. See Microsoft's
[SmartScreen guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
and [download-zone documentation](https://support.microsoft.com/en-us/windows/security/information-about-the-attachment-manager-in-microsoft-windows).

## Clone release checks and tags

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
`pnpm build`, builds Electron with `pnpm --filter @gates-local/desktop build`
as a blocking `desktop-build` step, then runs Playwright's blocking `e2e` project.
Every functional test blocks. JS and CSS sizes are reported against soft
targets and never block; a size that can't be measured still fails.
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

Run the whole release check as one exclusive browser job. After correctness
and timing, it also compares the newest annotated stable release tag whose
commit is an ancestor of the candidate with that candidate
using `perf:compare --prepare`, then four paired rounds of two samples each.
Preparation and measurement share an 880-second limit. Before any release tag
exists, the report states base `a369f0a3b7280f33802d6f816287546814da99eb`;
`--performance-base <full-sha>` overrides that first-release base. The
`performance` field records the exact commits, base selection, exit code,
signal, timeout and retained artifact paths. Slower results remain informational;
a tool failure or invalid/missing output means measurements unavailable.
Neither changes the verdict or tag eligibility. See [testing](testing.md) for
the sampling and noise model. The enclosing runner reserves exclusive access;
the check does not request a second reservation inside that job. Lightweight
tags and tags outside the candidate's history do not qualify as releases;
when none qualify, the stated fallback base is used.

Comparison commands and first-run servers share owned-process cleanup.
Cancellation stops first-run's detached stack and preview groups even during
startup or measurement, with bounded escalation before the release supervisor
can kill the comparison. Cleanup confirms every owned group member stopped
and unregisters completed groups; later signals never target those old groups.

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
installed unless `--browser-path <executable>` supplies one from a Playwright
`chromium-<revision>` directory. The check derives `PLAYWRIGHT_BROWSERS_PATH`
from that executable and shares the cache with its fresh home. Before verify,
it checks for the headless shell and ffmpeg expected by the clone's installed
Playwright. A missing piece fails with its path and preparation instructions;
supplying a browser never downloads browser software during the check. Prepare
the complete cache beforehand with `pnpm exec playwright install chromium`,
using `PLAYWRIGHT_BROWSERS_PATH` to select that cache if needed.
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

## Windows startup investigation (before the diagnostic run)

The previous installed smoke reached the preload bridge and created the thread
database, but did not retain the full bridge state. These are hypotheses, ranked before
another Windows run:

1. Initialization after opening SQLite throws or exits before the ready line.
   Settings, snapshot folders and WebSocket startup run in that interval. A kept
   stderr log and child exit status should identify the operation.
2. Initialization stalls or the supervisor cannot receive the ready line. A
   `ready-timeout` reason, termination status and stdout log distinguish this
   from an early exit. The supervisor keeps stdin open and reads both output pipes.
3. A packaged resource or bundled dependency fails on Windows. Offline extraction
   of the previous installer found `resources/server/main.mjs`, the worker and
   web assets outside ASAR, with main/preload inside `resources/app.asar`.
   The server bundle uses built-in SQLite; no native `.node` files are shipped.
4. Electron cannot run as Node, or executable spaces break spawning. These are
   less likely: the actual executable's RunAsNode fuse is enabled, the builder
   does not change fuses, and `spawn(execPath, args)` does not use a shell.
   SQLite creation also suggests the child already reached server code.

No cause is established by this list. The diagnostic run must retain the actual
failure before any further Windows attempt is considered.

Failed server launches now keep a `server-failure-<stamp>-<id>.json` file in
the server data folder. It records the reason, actual child exit code/signal,
entry/executable paths and the last 20 stdout/stderr lines. The launch token is
redacted and the environment is excluded. The error screen names the file and
offers to open its folder. Packaged smoke failures retain that state and file
contents in `smoke.json`, alongside Electron stderr. The diagnostic tests were
written in this implementation lane, watched failing, then passed twice; they
are not an independent review.

IN-01: an exit observed before quit now keeps its report even if shutdown
suppresses the delayed crashed-state notification. Shutdown waits for that
stderr snapshot. Intentional termination still writes no failure report.

IN-02: each retained report is capped at **64 KiB of serialized UTF-8 JSON**,
including escaping. Five reports are kept, for at most **320 KiB** of managed
reports. This retains several recent diagnostic tails without accumulating
large child output indefinitely. Stdout has an 8 KiB budget so stderr gets
priority; long path/error metadata fields have 2 KiB budgets. Retained input
lines also have the 64 KiB cap. The full token is redacted before any cut,
including cuts at Unicode or token boundaries; exit code, signal and stderr's
end are retained. Truncated text is marked explicitly.

Rotation removes older generated reports and oversized legacy reports before
writing another. It checks the exact generated filename, a recognized new or
legacy report header and a single-link regular file, rechecking identity before
unlinking. The recheck and the unlink are separate steps, so this guards against
accidents in the app's data folder, not another process racing it. Notes, JSON
without that header, symlinks, hardlinks and directories are left alone. Both
review findings have failing-first real-Node-child probes;
they were written in this lane and are not independent review. No Windows or
packaged run was performed for these file-handling fixes.

### Diagnostic native round: premature smoke assertion identified

Source commit: `8a9f1dc77e95fd3e07d1ad82efa4a3a394d1f442`. The same script-file
transport, native frozen-lockfile build, absence preflight and system-only run
PATH were used. Node/pnpm versions and script parsing passed. Each heavy step
checked the shared perf/exclusive run records; no exclusive slot was held.

Artifact: `Gates-Local-0.0.7-native-Setup-x64.exe`, **121,710,327 bytes**, native
build **61.97 s**, Authenticode `NotSigned`, no signer certificate. Windows and
the downloaded file agreed on SHA256:

```text
dee282cbc11c939d3645c7d8367c248068e1002a572fdfcd63bddaa98cfd57ae
```

All nine tracked objects were absent. Silent install `/S --no-desktop-shortcut`
exited 0 at `%LOCALAPPDATA%\Programs\gates-local`, without a `/D` override.
Main reported packaged mode, bundled Node `24.22.2`, profile
`%APPDATA%\gates-local-installed` and data `%LOCALAPPDATA%\GatesLocalInstalled`.
USERPROFILE, APPDATA and LOCALAPPDATA were the real per-user values; TEMP was
lane-owned. PATH was `%SystemRoot%\System32;%SystemRoot%`; neither driver nor app
used a Gates data/profile override, and the driver could resolve none of Node,
pnpm or Git on PATH.

The smoke again exited 1 at its assertion, but this time retained the actual
bridge state: **`starting`**, not `crashed`. While the smoke closed the app,
Electron stderr captured the child's `{"ready":true,"port":...}` line, its
`listening on 127.0.0.1` message and orderly `shutting down (stdin closed)`.
No crash reason, failed child exit or product failure log was captured for this
observation: the driver quit before the supervisor could settle. A missing
failure screenshot is expected because the bridge never reported a crash.

The cause is in the smoke: Playwright 1.61.1's `waitForFunction` tests the
predicate result for truthiness before awaiting it. An async callback returns a
truthy Promise even when it resolves to false. The wait therefore returned on
the first `starting` read. A local reproduction using that installed Playwright
poller returned false after one read; an assertion requiring readiness failed.
Replacing it with `expect.poll` awaited both reads and reached `ready`, twice.
That local reproduction executed the poller in Node with fake asynchronous
state reads. It did not start Electron, Chromium or any browser. All verification
that opens a window runs on the test machine.

The repo smoke and the prepared native driver then used that form. **The corrected
native driver had not yet been run on Windows at this checkpoint.** No second
app launch was made.

At that checkpoint the child reporting ready was observed; completed supervisor
readiness, an interactive first-run screen, renderer/foreign-Origin checks and Windows
upgrade persistence remained unproven. SmartScreen and double-click launch remained
unobserved because this was a non-interactive SSH session. No real Ollama or
ComfyUI was contacted. Upgrade was skipped at the failed harness assertion.

After waiting for a newly started exclusive run to finish, the app's own
uninstaller exited 0. The app directory, Start Menu shortcut and both NSIS HKCU
keys were removed; the data/profile folders remained as configured. SQLite had
been created at the packaged default data path. No app process needed a forced
stop. Cleanup removed only the recorded-new data/profile folders and confirmed
all nine tracked objects absent. The first lane-cache deletion check rejected
the new folder because it still named the previous round's prefix; no deletion
occurred. One correction restricted the check to this exact lane folder, and
its removal was then confirmed. The executed smoke, report and installer were
preserved locally. No existing checkout, WSL contents or user data was reused.

### Corrected-wait native Windows lifecycle, 2026-11-09

Both builds came from committed source
`7f97c0d5407644816bad309d947504782f548bdb`, transferred with `git archive`
and `scp`. The `GATES_LOCAL_BUILD_VERSION` parameter changed; the application
source was identical. Native checks ran from script files with real exit codes,
through non-interactive PowerShell
SSH. A persistent systemd user unit ran the complete lifecycle. Each heavy step
waited for unfinished perf/exclusive runs and active primary-machine exclusive
leases; this lane held no exclusive slot and changed no other admission record.

| Installer | Bytes | Native build time | Authenticode |
| --- | ---: | ---: | --- |
| `Gates-Local-0.0.8-native-Setup-x64.exe` | 121,710,396 | 85.83 s | NotSigned; no signer |
| `Gates-Local-0.0.9-native-Setup-x64.exe` | 121,710,186 | 74.40 s | NotSigned; no signer |

Windows SHA256 values matched the downloaded files:

```text
0.0.8-native fede05fa142adb80905990ce9a3c77fd5e941f68ade101312ca495fd2de82cfe
0.0.9-native 71c834df769a9ca86084941cf131704e3a5c8eaef18e806201e31d2b89ebd90c
```

Node `v24.18.0` and pnpm `11.10.0` transport checks passed before
`pnpm install --frozen-lockfile`. Both `pnpm package:win` invocations passed,
with the respective build-version environment variable. All nine tracked
package folders, shortcuts and keys were recorded absent before installation.
Silent install used `/S --no-desktop-shortcut` at the default per-user location;
the second installer used those same arguments over the first installation,
with no manual uninstall between them. Both installer exits were 0.

The actual installed app reported packaged mode, bundled Node `24.22.2`,
`%LOCALAPPDATA%\Programs\gates-local\Gates Local.exe`, profile
`%APPDATA%\gates-local-installed` and server data
`%LOCALAPPDATA%\GatesLocalInstalled`. USERPROFILE, APPDATA and LOCALAPPDATA were
the real user values; TEMP was lane-owned. Driver and app saw
`%SystemRoot%\System32;%SystemRoot%` on PATH, with no Node, pnpm or Git resolved.
No Gates data/profile override was set. No existing checkout or WSL contents
were used, and no environment change was persistent.

| Check, in execution order | Observation |
| --- | --- |
| Completed bridge readiness | Both installed versions returned `ready`; SQLite and real server RPCs worked. |
| First-run screen | The actual packaged renderer painted **Ollama isn't answering** with Retry; a screenshot was retained. |
| Origin admission | The renderer sent `gates-local://app` and received WebSocket 101. With the valid token, `file://`, `null`, `http://evil.example` and `gates-local://other` each received 403. |
| Installed upgrade | `0.0.8-native` to `0.0.9-native` preserved settings, an RPC-created thread, a completed-message fixture, profile localStorage and a file fixture in the data directory. The newer renderer displayed the saved message. |
| Uninstall | The installed app's own uninstaller exited 0 and removed the app directory, Start Menu shortcut and both NSIS HKCU keys. |

The runtime probes used ten lane-owned HTTP 404 endpoints, discover-only mode
and disabled binary search. This proves the missing-runtime first-run screen;
actual Ollama installation, model download/use and ComfyUI operation were not
tested. No real Ollama or ComfyUI was contacted, started or stopped. The saved
message and model-file fixture required no inference or downloaded model.
The thread and settings were written through the older app's RPC; after it
closed, the fixture message was appended through the same source's store API.
The newer app read the preserved data through RPC and displayed the message.
This is a replacement-build persistence check, not a schema-migration test.

Both app mains and both smoke drivers exited 0, with no observed renderer
JavaScript errors. Electron stderr recorded GPU-process `exit_code=34` warnings
(one in the initial launch, two after upgrade). DOM checks and actual renderer
PNG captures succeeded despite those warnings. The SSH session did not observe
the logged-in desktop, interactive presentation, a double-click launch or
SmartScreen. No warning dialog or bypass is claimed to have been seen.

Uninstall retained the two data/profile folders, matching
`deleteAppDataOnUninstall: false`; no tracked HKCU keys remained. The suppressed
desktop shortcut and HKLM key stayed absent. No app process needed a forced
stop. After preserving the receipts and images, cleanup removed only the two
recorded-new data/profile folders, confirmed all nine tracked objects absent,
and removed the lane cache. The persistent unit completed with exit 0 without
an interruption or app retry. Packaged self-update still refused with the
expected standalone-copy message.
