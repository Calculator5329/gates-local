# Releasing

## Published 0.2.1, 2026-11-12

[Release 0.2.1](https://github.com/Calculator5329/gates-local/releases/tag/v0.2.1)
contains the Windows x64 installer, Linux x64 AppImage, `release.json` and
its Ed25519 signature, all from `655e45eb5573296fbcb6aedb33ef4c5183281566`.
Both native builds and packaged checks passed, including the Windows
0.2.0 to 0.2.1 upgrade with saved-data checks. The fresh public-clone check
passed 3,865 unit and 550 browser tests, with 30 and 8 skips respectively.
Signature verification, both installer hashes, and GitHub's uploaded asset
sizes and hashes were checked before publication. The public latest-release
feed matches the signed manifest. Windows automatic installation remains
unfinished; use the downloaded installer to update. These packaged checks
did not run real models, observe SmartScreen/double-click, or establish a
normal Linux FUSE launch; the release notes retain those limits.

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
one tool. Installers are published beginning with 0.2.1. Native silent install, packaged
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

Packaged copies show **Installed copy** and their version in Updates. The
desktop app passes the version to the server, which then checks the
release page instead of a git remote and never starts git. A check reads
`<release page>/latest/download/release.json` and its `.sig` over https,
verifies the signature against the keys built into the copy, and compares
versions. The reads follow at most 5 redirects, take at most a 64 KiB list
and a 1 KiB signature, wait 30 seconds for an answer and 60 seconds for
the list and signature together. The copy adds no query string and sends
no cookies; a redirect's own query, as GitHub's signed asset links carry,
is followed as given.

A newer version with a file for this copy is downloaded into
`<data dir>/updates/<version>/`. The signed list and its signature are
written first, byte for byte. The artifact then comes from
`<release page>/download/v<version>/<file>` into a `.part` file that is
counted and hashed as it arrives. The read stops the moment it passes the
listed size, and the file is renamed only after its size and SHA-512 match
the list. The read keeps the check's rules (https, at most 5 redirects, no
cookies, 30 seconds of silence at most) and also gives up on a server that
sends less than 256 KiB in each successive five-minute window. Free space
is checked before the request. A folder holding a `.part` or missing its
list is deleted, never resumed. A complete folder counts as ready only
after it checks out again and holds the same signed list the check has just
verified; a version folder or a file that is a link is never trusted. On
Windows the final rename is retried for up to 2 seconds while another
program holds the file. With **Check for updates automatically** on, the
download starts by itself. One that could not finish is tried again at the
next hourly check. One that did not match the signed list is not fetched
again by itself: it is tried again when the signed list changes, when the
person uses Check for updates, or on Download. With the switch off,
Settings offers a Download button. Turning the switch off stops a download
and deletes downloaded versions, and a newer signed list deletes the folders
of older versions. Nothing installs yet: Settings says the version is
downloaded and checked and links the release page, and Update and restart
answers that this installed copy cannot update itself yet.

A copy whose version is not a
plain release (`0.0.0-dev`) is a development build and does not check; a
build with no trusted release key makes no request and says so.
`GATES_LOCAL_UPDATE_FEED` points the check at another https release page.
The clone path remains: close Gates Local, `git pull`, `pnpm install`,
`pnpm start`. Its existing in-app updater is unchanged.

Test builds: `GATES_LOCAL_TEST_BUILD=1 pnpm package:linux` adds
`resources/test-build.json`. Only a copy holding that file reads extra
public keys from `GATES_LOCAL_UPDATE_TEST_KEYS` (comma-separated base64
SPKI) and accepts a loopback `http` feed, so a packaged run can serve its
own signed lists. `pnpm release:artifact` refuses to run while
`GATES_LOCAL_TEST_BUILD` is set, so a test build never becomes a release
artifact. `apps/desktop/scripts/packaged-installed-check.ts` drives a test
build and a plain build through every Updates state.
`apps/desktop/scripts/packaged-installed-download.ts` drives a test build
through each download state and counts the requests its feed answers.

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

### Restart to update on Windows: IU-W rounds

An install made by the Windows installer offers **Restart to update** once the
new version's installer is downloaded and checked
(`docs/design/installed-updates.md`, section 3, W-A). The click checks the
file again, writes `updates/windows-pending.json`, starts
`<installer> /S --updated --force-run` and quits. The installer's running-app
check (`apps/desktop/build/installer.nsh`) waits for this install's processes
to end and never kills. The next launch turns the note into "Updated to
version N." or "The update to version N did not finish…".

Each round needs two installers built natively from the branch, as in the
rounds above (`pnpm release:artifact`, or `GATES_LOCAL_BUILD_VERSION=<v>
pnpm package:win`), and a signed list for the newer one that the older one
trusts. A test build's list on a local release page does that without the
real key. Record every location absent first, and clean them afterwards.

| Round | Steps | Passes when |
| --- | --- | --- |
| IU-W1 | Install N with `/S --no-desktop-shortcut`. Launch it, check, download N+1, click Restart to update. Time from the click to the app's exit, from the exit to the installer's end, and to N+1's server `ready`. | `windows-pending.json` is written before the installer starts and gone after N+1 starts; Settings says "Updated to version N+1." once; `updates/` keeps N+1's folder and the next update names it to go back with; no process was killed (installer log has no `Stop-Process` or `taskkill`). The measured app exit sets the check's wait bound (`GATES_LOCAL_WAIT_SECONDS`, 60 s until measured). |
| IU-W2 | As IU-W1, with N+1 a build whose server exits at start. | Nothing goes back by itself. The status page names the kept installer of N: "To go back, run <path>." Running it puts N back over N+1 with the data kept. |
| IU-W3 | Copy the installed folder to `%LOCALAPPDATA%\Programs\gates-local-old\` and start that copy. Update the real install as in IU-W1. | The copy is still running after the update: the check matches `<install folder>\` with its separator and waits only for the real install. |

A refused installer (Smart App Control, Defender, a policy) must leave the
running app as it was. Settings shows "Gates Local could not start the
installer, so nothing changed; to update, run <path>." and no pending note
stays. Smart App Control blocks every fresh unsigned installer, so on a
machine with it on, IU-W1 stops at the click with that sentence, which is a
pass for the refusal path and leaves IU-W1 itself unobserved. Do not change
the machine's security settings to get past it.

## Prepare a signed release directory

Signing happens on the Linux machine only. The private key never goes to the
Windows build machine. Both machines need Node 24 and pnpm 11.

### Once: create and back up the signing key

On Linux, create a key outside every git checkout:

```sh
pnpm release:keygen --out "$HOME/.local/share/gates-release-signing/release.pem"
```

The command prints only the public key, as a base64 Ed25519 SPKI string.
Add that string to `TRUSTED_RELEASE_KEYS` in
`apps/server/src/update/release-manifest.ts`, then land that commit before
building any release that uses this key. The source list has held one key
since 2026-11-11. A build from before that commit has no release key and
cannot check updates.

The private key is a PKCS8 PEM file with owner-only permissions. Keep it out
of repositories, logs, installers and cloud-synced folders. Keep a second
copy on storage that is not this machine. **If the only key is lost,
installed copies that trust only that key can never take another update.**
Key generation refuses to overwrite a file. Signing refuses a key inside a
checkout, a symlink or a file accessible to its group or others.

To rotate the key, first ship an app containing both public keys, signed by
the old key. Only then sign later releases with the new key. Copies must get
that bridging release before they can trust the replacement key.

### Each release: build the same checked commit on both systems

First complete [the clone release checks and tag procedure](#clone-release-checks-and-tags).
Continue only after `release:check` passes and the release tag exists on the
commit being built. From the clean Linux checkout at that commit:

```sh
git rev-parse HEAD
git rev-parse 'v1.2.3^{commit}'
pnpm install --frozen-lockfile
pnpm release:artifact --version 1.2.3
```

The two Git commands must print the same full commit. Export that commit
with `git archive`, and transfer the archive to the Windows build machine.
Extract it into a fresh directory. That copy has no `.git` and needs no Git
on `PATH`. On native Windows x64, replace `FULL_COMMIT_FROM_LINUX` below
with the full commit printed above:

```powershell
pnpm install --frozen-lockfile
pnpm release:artifact --version 1.2.3 --commit FULL_COMMIT_FROM_LINUX
```

The command chooses the native packaging script, supplies
`GATES_LOCAL_BUILD_VERSION`, and records an installer only after packaging
exits zero and the expected new file exists. A stale installer or record
blocks the build; archive both before retrying. A failed NSIS build can leave
an intermediate executable, but gets no record.

Each machine produces its own installer and adjacent record:

```text
dist/installer/Gates-Local-1.2.3-x86_64.AppImage
dist/installer/Gates-Local-1.2.3-x86_64.AppImage.record.json
dist/installer/Gates-Local-1.2.3-Setup-x64.exe
dist/installer/Gates-Local-1.2.3-Setup-x64.exe.record.json
```

Records hold platform, architecture, kind, filename, byte size, SHA-512,
version, commit and `commitFrom`: `git` for a checkout, `given` for an export.
In a checkout, an optional `--commit` must match `HEAD`. Exported builds
require it, make no Git calls and say the commit was given rather than read.
The packaging tools may download build dependencies if their caches need them.

### Back on Linux: assemble, sign and verify

Copy the Windows installer and record back to a folder outside the checkout
on Linux, here `$HOME/.cache/gates-release/incoming/`, using a transfer you
trust. Signing refuses a checkout with any untracked or changed file, so a
folder inside it would block the last step. **Records are not
authenticated.** Assembly checks
what arrived against those records, so it cannot detect someone replacing
both a record and its installer during an untrusted transfer.

From the Linux checkout still at the release commit:

```sh
pnpm release:assemble --out "$HOME/.cache/gates-release/1.2.3" dist/installer/Gates-Local-1.2.3-x86_64.AppImage.record.json "$HOME/.cache/gates-release/incoming/Gates-Local-1.2.3-Setup-x64.exe.record.json"
pnpm release:sign --key "$HOME/.local/share/gates-release-signing/release.pem" "$HOME/.cache/gates-release/1.2.3"
pnpm release:verify "$HOME/.cache/gates-release/1.2.3"
```

Assembly prints each record's commit source, requires matching versions and
commits, and re-hashes every installer before and after copying it. It builds
in a sibling temporary directory, renaming that directory to the final path
only after success. On failure it retains the partial directory and prints
its location. It refuses an existing output directory.

Signing rechecks all files and requires a clean checkout at the list's commit
whose trusted list contains the key's public half. Verification uses that
checkout's built-in keys, without a `--public-key` override. It checks the
signature before parsing, then every file's size and SHA-512, prints the
platforms and one plain line per check, and exits zero only if all checks pass.

For a local proof, `assemble` and `sign` both require
`--allow-single-platform` for one platform. `sign --allow-untrusted-key`
skips checkout and key trust checks and warns that installed copies will not
accept the signature unless they already trust that key. `verify --public-key`
can check that proof key. These flags are for proofs, not the release workflow.

`release.json` has one canonical UTF-8 JSON spelling, with no byte order mark,
LF line endings, two-space indentation, fixed key order and one trailing LF.
Artifacts have only the two exact names shown above, using the list's own
version. `release.json.sig` is one base64 Ed25519 signature line plus LF.

A verified list says the holder of a trusted key published that version with
those files. It does not prove the version is newer, that the app works or
that an installer has an operating-system signing certificate. A reader must
accept only versions greater than its own. No artifact for its platform means
there is nothing for that copy. A download is used only after its size and
SHA-512 match the verified list, saved under the rebuilt name in a directory
for that version and run by absolute path without a shell. Someone controlling
the download page can keep serving an old, validly signed list, hiding newer
versions. Nothing here uploads; publishing is a separate step the owner decides.

## Clone release checks and tags

A release is an annotated `vX.Y.Z` tag on `main`. There is no hosted CI;
a release machine checks a stranger's fresh public clone before tagging.

Work lands on `dev`; `main` holds released commits only. To cut a release,
check a `dev` commit by its full sha, fast-forward `main` to that commit
and push it, then tag. `dev` keeps moving the whole time. If the check
fails, the fix lands on `dev` and the new commit is checked; `main` has
not moved.

```sh
pnpm release:check --remote <public-url> --commit <full-sha> --report <new-report.json>
pnpm release:tag v1.2.3 --report <new-report.json>
```

With two machines the check can run as two halves at once:
`--part correctness` runs the unit tests and the blocking browser project
and nothing timed, so it can run on a machine that is busy with other
work; `--part timing` runs only the timing project and the speed
comparison, on a machine left alone for it. Tag from the correctness
report. A timing report ran no tests and `release:tag` refuses it.

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

The check starts by naming what the machine itself must have beside git,
pnpm and a browser: on Linux, bubblewrap at `/usr/bin/bwrap` and
`/usr/bin/sqlite3`, the shell tool's prerequisites. If one is missing the
check stops before the clone with a failed `machine` step that names it.
Commands the check starts carry `GATES_LOCAL_REQUIRE_HOST_TOOLS=1`, and with
it the real sandbox tests run instead of skipping for a missing bubblewrap.

Timing is informational. After the blocking steps pass, a separate
`timing` project runs with its own 120-second limit, followed by bounded
process-group shutdown if needed. The release report records whether the
command completed, its exit code or signal, whether it timed out, and the
path to its raw report. Neither release-check nor release-tag parses or
uses the timing report to decide the verdict. A timing crash, missing,
stale or empty report, assertion failure or timeout cannot pass or fail
the release. The timing tests assert no fixed millisecond line: they log
first paint, ready composer, the longest task and the key event's p95, and
the comparison below judges whether the candidate got slower than the last
release on the same machine.

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

### Windows installer and Linux AppImage from one commit, 2026-11-11

Every build below came from committed source `0e3b5c11`, which contains main
at `4d135b23`. The Windows half used the same method as the round above:
`git archive` and `scp` into a new lane-owned cache folder, script files with
real exit codes over non-interactive PowerShell SSH, one persistent systemd
user unit for the whole round, and the real per-user install, profile and
data locations, each recorded absent first. Unlike the earlier rounds, this
round held one exclusive place in the shared test-machine queue for its
duration and released it afterwards; waiting on other runs without a place
had left an earlier attempt behind a full queue for over an hour.

#### Native Windows round

| Installer | Kind | Bytes | Native build | Authenticode |
| --- | --- | ---: | ---: | --- |
| `Gates-Local-0.1.90-Setup-x64.exe` | plain | 128,940,582 | 67.0 s | NotSigned; no signer |
| `Gates-Local-0.1.91-Setup-x64.exe` | plain | 128,940,508 | 55.7 s | NotSigned; no signer |
| `Gates-Local-0.1.91-Setup-x64.exe` | test build | 128,940,651 | 56.2 s | NotSigned; no signer |

SHA-512 of the two plain installers, from Windows:

```text
0.1.90 60fe654ffce90f7666ef5931a82d2755bdc2f5b4b7d488967f5d20c3fb656dd7e476762e2653f187679b02105699993ba44be8d1585caa725571f547793c8f98
0.1.91 dd9c1df993599533c4b9be9a8626e574a36d4cb633a98d848e7e0e727b7e1f61d8f9eb20e7f10efdac3cd6b5ea57e4a11b932fcf1dac49eb4d444cee793dc1a8
```

Node `v24.18.0` and pnpm `11.10.0` passed their transport checks, then
`pnpm install --frozen-lockfile` (12 s) and each `pnpm package:win` exited 0.
The app and its driver ran with `%SystemRoot%\System32;%SystemRoot%` as PATH;
no Node, pnpm or Git resolved on it, and no data or profile override was set.

| Check, in execution order | Observation |
| --- | --- |
| Silent install | `0.1.90` with `/S --no-desktop-shortcut` exited 0 in 21 s, at `%LOCALAPPDATA%\Programs\gates-local`. |
| First launch | The packaged server reached `ready` and SQLite was created. The renderer painted **Ollama isn't answering** with Retry 17.4 s after launch. |
| Origin admission | `gates-local://app` got WebSocket 101; `file://`, `null`, `http://evil.example` and `gates-local://other` each got 403. |
| Closing | Main exited 0, 136 ms after close, with no app or Ollama process left. |
| Upgrade over the top | `0.1.91` installed over `0.1.90` with the same arguments: exit 0 in 25 s, same path, no uninstall between. Settings, an RPC-created thread, a completed-message fixture, profile localStorage and a model-file fixture all survived. Closing took 90 ms, with nothing left running. |
| Plain update check | The installed plain `0.1.91` trusts the shipped release key and, against the real release page, said "No release list was found on the release page." (nothing is published yet). |
| Test-build journeys | With the `0.1.91` test build installed: the installed-check journey passed in 43 s and the installed-download journey in 26 s. |
| Uninstall | The installed uninstaller exited 0 and removed the app folder, Start Menu shortcut and both HKCU keys. Data and profile stayed, as `deleteAppDataOnUninstall: false` says. |

The first-run probe held the app's whole port range with lane-owned HTTP 404
endpoints, so the screen also said that something else holds the port. A
computer with no Ollama and free ports shows a different first-run screen;
that was not observed on Windows. No real Ollama or model was started or
contacted. Electron stderr again recorded one GPU-process `exit_code=34`
warning; rendering and captures worked.

After the reports and images were copied, cleanup removed the two data and
profile folders that had been absent before the round, confirmed all nine
tracked objects absent, and removed the lane cache.

**The runtime's Windows stop is unchanged.** The round on `0e3b5c11` ran with
a runtime change that ended the app's Ollama with `taskkill /T /F`; review
took it out afterwards, so the runtime again ends only the `ollama serve`
process it started. The packaged steps above did not start an Ollama, so
that change played no part in them. On Windows the runners end with serve
because the pinned Ollama build puts each runner in a kill-on-close job
object of its own. That was read in Ollama's source at the pinned tag, not
observed with a real Ollama; observing it is still open. The three
process-tree tests cover the Linux and macOS group stop and are skipped on
Windows.

The runtime test file on native Windows, at the branch head after that change:
12 passed, 4 failed, 3 skipped (the process-tree tests). Three of the failures
expect an `ollama` found on PATH to be used; on Windows the runtime only ever
runs its pinned copy, so they cannot pass there. The fourth, which starts the
app's copy and stops it, passed alone in 8.4 s with a 60 s limit: it is slower
than the 5 s test limit on that machine, not stuck.

#### Linux AppImage probes

Built on the Linux test machine at `0.1.91`: a test build and a plain build,
each 135,889,525 bytes, 33 s and 30 s. The plain AppImage's SHA-512:

```text
9fcb3008e04fbb6033701f8edf37689ca279e828493317b741fde1e64529a0ccb2a5831fe55b22c58c4b62e6decc24f3ae3eedc25adc384deb29aae1c1cb3985
```

| Probe | Result |
| --- | --- |
| `packaged-smoke.ts` | Passed in 5 s: first-run screen, renderer Origin 101, four foreign Origins 403. |
| `packaged-normal.ts` | Exit 0 as a diagnostic: the test machine has no FUSE, so a normal AppImage launch was not observed. |
| `packaged-installed-check.ts` | Passed in 50 s, test-build and plain halves. |
| `packaged-installed-download.ts` | Passed in 29 s. |

#### Not observed

SmartScreen, Defender, a double-click launch, the logged-in Windows desktop, a
real Ollama or model on either system, a first-run screen with free ports on
Windows, a normal (FUSE) AppImage launch, signing and "Restart to update".
