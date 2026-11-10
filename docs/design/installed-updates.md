# Updating an installed copy

A person who installed Gates Local from the AppImage or the Windows installer gets updates without git. The app checks a signed release list and downloads the new version quietly. When the download is ready it says so, and one click closes the app and reopens it on the new version. On Linux, a new version whose server does not become ready within 60 seconds is replaced by the old file again, and the old version is checked the same way. On Windows the first release does not go back by itself. Before the click, the app says where the installer for the current version is, or names its release page. Nothing installs without the click, and the updater copies no user data. The update never touches an Ollama, ComfyUI or whisper process the app did not start.

| Term | Meaning |
|---|---|
| installed copy | an AppImage file, or a Windows install made by `Gates-Local-<v>-Setup-x64.exe` |
| release list | `release.json` + `release.json.sig`, as the release contract defines them |
| program file | the AppImage file the person starts (Linux) |
| watcher | the process that holds the update lock. It is the only thing that moves the program file or data during an update, and the only thing that ends a transaction. |
| transaction | `<data dir>/updates/installed-update.json`. It is the watcher's write-ahead record. |
| identity | the size and SHA-512 of a file |
| result | `update-result.json`, written durably by the watcher and carrying the token of the launch it releases. It is the only thing that lets a token launch open admission. |

Marks: **observed** means seen in a recorded run (docs/releasing.md lines or a named test). **Source** means read in code or in the app-builder-lib 26.18.0 NSIS templates, but not run. **Assumed** means unproven; the test that settles it is named in section 13.

## 1. The path

| # | Step | Code | Reuse, or what is new |
|---|---|---|---|
| 1 | Check: fetch the list, verify it, and compare its version with the running one | `apps/server/src/update/installed/check.ts` (new) | Reuses `automaticChecks` (automatic.ts:9, 15 s then hourly) and the `updateAutomatic` switch (shapes.ts:292). Reuses `compare` (semver.ts). Verification is the contract reader `release-manifest.ts`, which landed on main in 648b098. |
| 2 | Download into the cache and verify (section 6) | `installed/download.ts` (new) | new |
| 3 | Offer: the status carries an approval token pinned to the list digest and the artifact (section 5) | `installed/module.ts` (new), beside `createUpdateModule` | Copies the fingerprint pattern of module.ts:133–136. The clone fingerprint (commit, notes) stays clone-only. |
| 4 | Click, then reserve and commit admission | admission.ts unchanged | `createUpdateAdmission` is reused as is. The 30 s reservation (admission.ts:22) and the 5 s lease after disconnect (admission.ts:3, :57) hold. The target string becomes the pinned artifact identity instead of `targetCommit`. The wire request, the desktop validator, the preload/bridge and `update-install.ts` change with it (section 11). |
| 5 | Handoff: Linux, section 2; Windows, section 3 | `apps/desktop/src/installed-update/` (new) | The detached spawn and quit of desktop main.ts:208–227 |

Clone-only pieces, untouched by this design:

- `apply.ts` and `check.ts`
- `cli.ts`, except that its deadline logic is copied
- `acquireLock` (lock.ts:205–210)
- `transaction.ts`. It locates its file through git's `stateDir`, and `saveTransaction` returns silently without one (transaction.ts:37–55).
- `acknowledgeStartup`. It checks `HEAD`, writes the result and clears the clone transaction itself (startup.ts:51–57).
- the binary lookup in `createRelaunch` (update-relaunch.ts:29–32)

What is adapted:

- `acquireFileLock` (lock.ts:213), at a new path
- the fsync, rename and directory-flush technique of `saveTransaction`, in a new file
- the token-matched ack pattern of `readStartupAck`/`writeAck`, now with fsync, which `writeAck` lacks (startup.ts:35–39)
- the ownership policy of `createRelaunch`'s `stop()` (update-relaunch.ts:40–51)
- `processRecord` and `treeGone` (identity.ts:69, :97)
- `waitForExit` (wait.ts), always followed by `cli.ts`'s second deadline check (cli.ts:308–315)
- `record.ts`, for L3. It needs:
  - an outcome `rolled-back`; today's reader rejects unknown outcomes (record.ts:15, 36, 61), and `UpdateResult` lists the same four (shapes.ts:525)
  - a `token` field
  - fsync of the file and its folder, which `writeRecord` lacks (record.ts:27–33)
  - no `takeRecord` during an update startup: it reads *and removes* the file (record.ts:45–53), and `status()` calls it (module.ts:129), so a phone status call could otherwise consume the result before main reads its token. The token stays off the wire.

Phone approval stays impossible. The enforcement is `phoneMay` in ws/server.ts:238, not the `canControl` flag (module.ts:205), which only affects presentation.

## 2. Linux: replace, accept, go back

**Who may update.** At check time an installed copy decides whether it can update itself:

| Case | Detected by | Behaviour |
|---|---|---|
| Started from an AppImage | `process.env.APPIMAGE` names a regular file ending in `.AppImage` (**assumed**). It is not checked yet: packaged-upgrade.ts:29 filters `APPIMAGE*` out of the child env and :43 adds extraction mode. | can update |
| Extract-and-run (no FUSE2; **observed**, releasing.md L49–71) | `APPDIR` is a temporary extraction folder | can update. The running code is not the file. |
| Read-only folder | a probe write in the program file's folder fails with `EROFS` | "read-only" sentence (section 8) |
| A folder the person cannot write | the probe fails with `EACCES`/`EPERM` | "no-permission" sentence. The app never asks for a password. |
| Not an AppImage | `APPIMAGE` unset | "not-appimage" sentence |
| Data folder pinned by `GATES_LOCAL_DATA_DIR`, outside the test-build rule | data-dir.ts `serverDataDir` returns the pin first | refused (see below) |

The pinned data folder is refused because it is the only way two Electron profiles share one data folder. `GATES_LOCAL_USER_DATA` alone puts data inside that profile (data-dir.ts `serverDataDir`). The default packaged data folder belongs to the default packaged profile, so Electron's profile lock already keeps out a second writer. No smaller rule covers sharing.

**Three kinds of launch, one lock rule each.** `update.lock` is `<data dir>/updates/update.lock`, held through `acquireFileLock`. It is recoverable: an owner that is dead by pid and start time can be taken over.

| Launch | Started by | Locks |
|---|---|---|
| **Watcher mode** | `--gates-local-update-watch=<transaction>`, passed only by the old main at row H | Takes only `update.lock`, before it reads the transaction. If the lock is held, it exits and changes nothing. It never takes the profile instance lock and starts no server. It opens a window only for a failure page. |
| **Token launch** | T1 or T2 in `GATES_LOCAL_UPDATE_STARTUP_TOKEN`, spawned by the watcher | Takes the profile instance lock, retrying for up to 5 s, because an ordinary launch may be holding it on its way out. Without the retry, a double-click during an update would cause a false go-back. Its token must match the transaction's current launch row (`launch-new` or `launch-old`); that match is what lets it pass the live `update.lock`. It starts with admission closed. |
| **Ordinary launch** | the person | Takes the profile instance lock as today, then: no transaction, start normally. A transaction whose `copy` (real path of the program file, real path of the data folder) is not this copy: release the lock, say so, exit. `update.lock` held by a live owner: release the lock, say "updating", exit. A transaction with `update.lock` free or its owner dead: release the profile instance lock, then continue in this process as the watcher, under the watcher-mode rule. |

Walking the rows:

- **H.** The old main holds the profile lock, writes the transaction and spawns a watcher-mode process. That process takes `update.lock` (and needs no profile lock). The old main quits, which frees the profile lock. If an ordinary launch wins `update.lock` first, it becomes the watcher and the spawned one exits.
- **L1.** The watcher holds only `update.lock`. T1 takes the free profile lock, matches `launch-new`, and passes `update.lock`.
- **B4.** B1 has confirmed T1's tree stopped, so the profile lock is free. T2 takes it, matches `launch-old`, and passes `update.lock`.

**When the watcher dies (no self-takeover).** A token launch watches the `update.lock` owner while it waits. If that owner is dead and no result carries its token, it stops its server, does not open admission, and shows "Close Gates Local and start it again to finish the update." The next ordinary launch becomes the watcher. That watcher may find the world at L1 or L2: the path holds `new`, there is no result, and a T1 may have existed with or without a saved process record. It then does this:

1. **No T1 main holds the profile.** This launch just held the profile instance lock. A T1 still inside its 5 s lock retry is not ruled out by that; step 2 catches it, and it exits by itself once its token no longer matches the transaction.
2. **No T1 server is alive.** T1 was spawned detached, so it leads its own process group. Its server is spawned without `detached` (supervisor.ts:224), so it sits in that group. With T1's record saved, `treeGone` on it, which checks the whole group on Linux (identity.ts:108), confirms the server is gone. With no saved record, the outcome is `stuck` until the boot id changes.
3. **Retry once.** Rewrite `launch-new` with a fresh T1 and apply the 60 s rule again.

Each pass needs a person's launch, so it cannot loop by itself. If row `stop-new` was already written, the watcher continues at B1 instead, because the decision is one-way. At B4 the same three steps apply to T2's record and a fresh T2. A transaction that already says `accepted` or `went-back` is past both rules: it is never retried and never rolled back, whatever has happened to the result file (rows A and B4).

If the person's next launch is a new version whose main process cannot start at all, nobody can reconcile. That is a known limit. `.<name>.previous-<id>` stays next to the program file, and the person can start it by hand.

### The steps

The transaction lives on the data volume and the program file on the program volume; they may differ. "Flush" means fsync of the file, then fsync of the folder that holds it, on that volume. Each row writes its intent to the transaction (file plus data-folder flush) *before* the action.

Recovery never trusts the phase alone. It hashes what is at the program path and compares it with `old` and `new`. "Interrupted" means a crash found later. An action that *returns* an I/O error (full disk, permission) is handled by where it happens:

- **Before the replace (W2, S1, S2, and an S3 rename that failed with the path still holding `old`):** nothing the person uses has moved. The watcher deletes this transaction's incomplete staging files, writes `stopped` with the disk or permission sentence, and ends the transaction.
- **An S3 rename that returns an error:** the watcher does not trust the error. It applies S3's own recovery check to the program path at once. The path holds `old`: the case above. The path holds `new`: the replace took effect, so it flushes the program folder and carries on to L1. The path holds neither: the unknown-file path, `rollback-failed`. If that flush returns an error, the intent stays `replace` and every file stays; the outcome is `stuck` with the "replace paused" sentence, and a later launch resumes at S3, which finds `new` and flushes again.
- **While going back (the restore B2a and B2b, and the put-back B3):** the intent and every file stay. A spawn that fails at L1 counts as T1 having exited and goes to B1. The outcome is `stuck` with the "go-back paused" sentence, and a later launch resumes at the same row. Ending the transaction here would let an ordinary launch open a data folder with no `threads.sqlite` and create an empty store.
- **Row C:** the transaction stays at `cleanup`.

| Row | Intent written first | Action | Flushed after | Recovery when interrupted between this row and the next |
|---|---|---|---|---|
| H | `approved`, with: copy; from/to versions; list digest; artifact; approval deadline as uptime + 5 s with boot id; process records of the old main and its supervised server | main spawns the watcher, then quits | transaction | Watcher never started, or the deadline has passed: outcome `stopped`, change nothing |
| W1 | — | Wait for both recorded processes to end, bounded by the time left before the deadline (`waitForExit`, then `treeGone`). Then check the deadline again. | — | Old tree not confirmed gone, or the deadline passed: outcome `stopped` (or "did not close"), nothing moved, no relaunch. No fixed delay counts as confirmation. |
| W2 | `identified`, with: `old` = identity of what is at the program path, `new` = the pinned artifact identity, `storeBefore` = the thread store's `user_version`, read by a `node:sqlite` open and close (no other process runs) | Re-read the cached list. Verify its signature against the built-in keys, check its digest equals the pinned one and its version is above the running one, then hash the cached artifact. Re-check disk space on both volumes. | transaction | Any check fails: `stopped` with its sentence |
| S1 | `stage` | Copy the artifact to `.<name>.incoming-<id>` in the program folder, then chmod 0755 | incoming file + program folder | The incoming file is partial or does not match `new`: delete only `.incoming-<id>` and redo S1 |
| S2 | `keep-previous` | `link(<name>, .<name>.previous-<id>)`. If the volume refuses hard links: copy to `.previous-<id>.part`, flush, check it matches `old`, then rename. | program folder | `.previous-<id>` matches `old`: done. A `.part` or a mismatch: delete it and redo S2. |
| S3 | `replace` | `rename(.incoming-<id>, <name>)` | program folder | The path holds `new`: replaced. It holds `old` and the incoming file matches `new`: redo S3. It holds neither: **unknown file**, outcome `rollback-failed`, touch nothing. |
| L1 | `launch-new`, with token T1 | Spawn `<name>` with T1; save its process record | transaction | See "when the watcher dies" |
| L2 | — | Wait for the T1 ack, timed with `performance.now()`. The ack is a request, not a decision. | — | as L1 |
| A | `accepted`, written when the ack is seen inside 60 s. This is the decision, and it is one-way: after it, nothing goes back. | Write the result `updated` with T1 (file + data folder flushed). T1 reads it and opens admission. | result | The transaction says `accepted`: write the result again if it is not there, then go to C. Never B1, even when the person has already dismissed the result and written new chats. Any crash after the intent is an ordinary crash of the new version. |
| B1 | `stop-new` (no ack inside 60 s, or T1 exited). After this, `updated` is never written. | Stop T1's tree with the `createRelaunch.stop` policy | — | Not confirmed stopped: `stuck` |
| B2a | `restore-aside`. Entered only if the store's `user_version` is above `storeBefore`, and only after `store-copies/threads.v<storeBefore>.sqlite` has been opened and found to hold `storeBefore`. A missing or wrong copy is `rollback-failed` with nothing moved. | Move each of `threads.sqlite`, `-wal` and `-shm` that is present at the live path into `store-copies/aside-<id>/` | aside folder + data folder | Move whatever is still at the live path, then flush both. Nothing can create a live file in this phase: T1 is stopped and T2 does not exist. |
| B2b | `restore-install` | Copy `threads.v<storeBefore>.sqlite` to `threads.sqlite.restoring`, flush it, rename it to `threads.sqlite` | data folder | A `threads.sqlite` at the live path can only be this phase's rename: repeat the folder flush. Otherwise delete any `.restoring` and redo the copy. |
| B3 | `put-back` | `rename(.<name>.previous-<id>, <name>)` | program folder | The path holds `old`: done, even when `.previous-<id>` no longer exists. The path holds `new` and the previous file matches `old`: redo B3. |
| B4 | `launch-old`, with token T2 | Spawn `<name>` with T2 and wait as in L2. When the ack is seen, write intent `went-back`, then the result `rolled-back` with T2, flushed. | transaction, result | The transaction says `went-back`: write the result again if it is not there, then C. Not ready inside 60 s: stop T2's tree, outcome `rollback-failed` with B4's own sentence (section 8). |
| C | `cleanup` | Delete `.<name>.previous-<id>` (owner decision D2) and `updates/<to>/`, then the transaction. The result is never touched; the person dismisses it from the client. | — | A cleanup failure leaves `cleanup`. A later launch only retries the cleanup, never recovery. When that retry succeeds and no app of this copy is running, the watcher starts `<name>` as an ordinary launch, so the person's launch still gives them the app. |

`<id>` is the transaction's own id. No cleanup removes a file that an unfinished transaction names.

**Outcomes:**

| Outcome | What follows |
|---|---|
| `updated`, `rolled-back` | Row C. The token launch reads its result and opens admission. |
| `stopped` with nothing moved | Row C. If it was reached after the old tree was gone (W2, S1, S2), the watcher then releases `update.lock` and starts `<name>` as an ordinary launch, so the person gets their app back and sees the result there. |
| `rollback-failed` (B4, S3's unknown file, B2a's missing or wrong copy) | The result is written durably with the paths as they really are at that moment, then the transaction is removed. **No file is deleted**: `.previous-<id>`, `.incoming-<id>`, the download, the store copy and the aside folder all stay until the person dismisses the result. That holds on every deletion path: row C, the newer-list cleanup and the switch-off cleanup of section 6 all skip files an undismissed `rollback-failed` result names. The watcher itself opens a window with the failure page, which needs no server. Because the watcher can die before it shows that page, **every ordinary launch checks for an undismissed `rollback-failed` result before it starts its server and shows the same page first**, with one button, "Start Gates Local", that carries on with a normal start of whatever is at the program path. No new update is offered until the person dismisses the result, so the single result file is never overwritten by a later update. |
| `stuck` | The transaction stays unfinished and no file is deleted. The watcher shows the stuck page ("could not confirm it stopped"), the "go-back paused" page (a returned I/O error while going back) or the "replace paused" page (the program folder could not be flushed after the replace). A later ordinary launch becomes the watcher and resumes at the same row; for an unconfirmed stop, a changed boot id confirms it. |

**Update startup.** A token launch shows a status page, not the client. Its server starts with admission closed: every user write gets "Gates Local is finishing an update. Try again in a moment.", the phone included. On supervisor ready, main writes the ack. It opens admission and shows the client only when it reads a result carrying its own token. This changes `route()` in desktop main.ts:136–145, which today logs an acknowledgement error and shows the client anyway.

**Clocks.** The approval deadline is `os.uptime()` plus the boot id, as in the clone (`approvedHandoffEnv`, update-launch.ts:36; boot id from identity.ts:21–26). A suspend therefore counts toward the deadline, and a reboot expires it. **Assumed** for Linux, where `os.uptime` is taken to include suspend. The 60 s startup waits use `performance.now()`, as `waitForStartup` does (startup.ts:22). A suspend during the wait is taken not to count. **Assumed.**

## 3. Windows

Read from the template source, not run:

- The stock running-app check kills processes whose path `StartsWith('$INSTDIR')`, with no separator (allowOnlyOneInstallerInstance.nsh:66, :94). Its fallback is `taskkill /IM` for every process of that name owned by this user (:99).
- `--updated` skips the close prompt (:108–118).
- The old uninstaller is copied out and run `/S /KEEP_APP_DATA --updated` (installUtil.nsh:209–224). It moves files one by one into `$PLUGINSDIR\old-install` (uninstaller.nsh:70). That is not a power-loss transaction.
- A silent install starts the app only with `--force-run` (installSection.nsh:91–102), through `ExecShellAsUser`, which takes no environment and returns no pid (common.nsh:123–131).
- There is no downgrade refusal.

The install over the top was observed once, `0.0.8-native` → `0.0.9-native` (releasing.md:643).

### W-A, the default: verified installer, no automatic go-back

1. The verified download completes (section 6).
2. Before the button turns on, the app looks for the current version's verified installer in `updates/<current>/`, kept from the last update it applied. It names that path in the dialog, or names `releases/tag/v<current>` if there is none.
3. The person clicks "Restart to update".
4. After the admission commit, main re-verifies the list and hashes the installer, holding its server connection so the lease cannot lapse. It writes `updates/windows-pending.json` with the version and list digest (fsync), spawns `Setup.exe /S --updated --force-run` detached, and quits.
5. The installer's running-app check (replaced, see below) waits for this install's processes to exit. It uninstalls the old version, installs the new one and starts it.
6. Next launch: the version equals the pending version, so the app shows "Updated to version <v>." once and keeps that installer as the go-back installer for the next update. If it does not, the update did not finish (section 8), and part of the install may have changed.
7. If the new version's server fails, its desktop status page, which needs no server, adds: "To go back, run <path to the kept installer>." If its main process cannot start, the sentence from step 2 is all the person has.

Promised: the files that run are verified and nothing installs without a click. Not promised: going back by itself. A known gap: after a release that migrated the thread store, a reinstalled old version stops at "cannot open the thread store" (`StoreVersionTooNewError`), even though `store-copies/` holds its copy. Cost: one pending file, one kept installer of about 122 MB (releasing.md L232–389), no watcher and no copied runtime.

### W-B, a sketch: a recovery entry outside the replaced folder

A small recovery launcher in `%LOCALAPPDATA%\GatesLocalInstalled\recovery\`. The Start menu shortcut points at it, and during an update it is registered under `HKCU\...\RunOnce` so a reboot runs it at logon. It reads the transaction, then either starts the app with a token and writes its result, or runs the kept installer. Cost: a second executable built outside Electron (a new toolchain), or a PowerShell script exposed to execution-policy and antivirus rules; shortcut changes in a custom install macro; an uninstaller that removes it. Must be proven on a real Windows machine first:

- `RunOnce` fires after a forced power-off at each point of an install
- the launcher survives the installer
- Defender and SmartScreen leave it alone
- going back by installer leaves a startable app

### The running-app check, both options

Define `customCheckAppRunning` in `apps/desktop/build/installer.nsh`, passed through `nsis.include` (NsisTarget.js:709). The stock macro yields to it in the installer and in the uninstaller (allowOnlyOneInstallerInstance.nsh:5, :37–38; uninstaller.nsh:1–2, :19).

Ours lists processes whose path starts with `$INSTDIR\`, *with* the separator. It waits for them, polling, up to a bound set from IU-W1's measurement, and **never kills**. If PowerShell is unavailable it cannot scope the check by path. Silent runs then abort with a non-zero exit, and interactive runs say "Close every Gates Local window, then click Retry." A silent abort happens before `uninstallOldVersion` (installSection.nsh:33–36 come before :52).

The uninstaller that runs during an update is the *installed* version's. Every version able to start an update ships the macro, so every update it starts runs with it. A person running a new installer by hand over a version from before the macro still meets the stock kill.

## 4. Data across versions

The updater copies no user data. Each store protects itself or follows a rule.

**The thread store's pre-migration copy (Store lane: the copy only).** It lives in `threads/migrations.ts` and is independent of updates:

- **When:** in `migrate`, an existing database (`user_version` > 0) is below `LATEST_VERSION` and a step is about to run.
- **What:** before the first `BEGIN IMMEDIATE`, run `VACUUM INTO` to a temporary file in `<data dir>/store-copies/` (folder 0700, file 0600). This gives one consistent single file and needs nothing beyond `node:sqlite`'s `exec` (store.ts:8).
- **Naming:** open the copy read-only and name it for the `user_version` it holds: `threads.v<N>.sqlite`. Fsync it, rename it into place, and flush the folder. A copy that holds `LATEST_VERSION` (another process migrated first) is deleted.
- **Then** the first step runs. The existing re-read of the version under `BEGIN IMMEDIATE` (migrations.ts:126–141) is kept.
- **Full disk:** the copy fails, the temporary file is deleted, and `migrate` throws before any step. The server stops before ready with "Gates Local could not save a copy of your chats before upgrading them, because the disk is full. Free some space and start it again. Nothing was changed."
- **Pruning: none in the first release.** The app never deletes a store copy. Cost: one full copy of the thread store per release that migrates it. An interrupted migration can leave copies of intermediate versions too, and keeping them all means `threads.v<storeBefore>.sqlite` cannot disappear. Pruning is a later item.
- **Nullable column repairs** (`addMessageColumns`, `ensureMessageColumns`) bump no version and make no copy. The previous version still reads those tables (decisions.md).

The restore is L3's rows B2a and B2b, because it needs the transaction's intents. It is not part of the Store lane. **Pre-existing:** the clone updater still cannot restore a migrated store. `goBack` has no data folder or saved store version (`UpdateOptions`, apply.ts:86–103). That is a later item, not closed here.

**Every other store:**

| Store | Where | What startup can change | Rule |
|---|---|---|---|
| `settings.json` | data folder | sets a bad or newer file aside and loads defaults (settings/store.ts:83, :147). Unknown keys are dropped on decode (no `onExcessProperty`, :85–89; **assumed**). | previous version must still read it |
| `sources.json`, `snapshots/` | data folder | renames an unreadable registry, and folds `_archive/` into one copy per source, deleting the rest (sources/index.ts:110–223) | previous version must still read it |
| `library-imports/` | data folder | `owned.recover()` finishes durable removal decisions and empties staging (sources/owned.ts) | previous version must still read it |
| `images/` | data folder | deletes unreferenced paste images older than 24 h (chat/image-lifecycle.ts:37–43, started at app.ts:214–215) | previous version must still read it (image references stay where it looks) |
| `runtime/` (owned Ollama install, `owned-ollama.json`, serve log) | data folder | `runtime.ensure()` after ready may install or start the app's own Ollama (server main.ts:282) | previous version must still read it |
| `models/` | data folder or the person's Ollama folder | not touched at startup | not touched at startup |
| `update-result.json`, `update-startup.json`, `updates/` | data folder | updater only | rebuilt from other data |
| `store-copies/` | data folder | the Store lane | never deleted (above) |
| Electron profile (Chromium state) | `gates-local-installed` profile | Chromium may upgrade it | previous version must still read it. An Electron major bump is suspect. |
| IndexedDB `gates-local.composer` v1 | profile | opened at version 1 (draft-persistence.ts:19) | previous version must still read it (no version bump without handling `VersionError`) |
| localStorage (favourites, first run, stop-others) | profile | Picker.tsx:26, session/navigation.ts:113, session/chat.ts:63 | previous version must still read it |

**Skipped versions.** "The previous version" means the version actually installed, which can be several releases back. The thread-store copy covers any jump, since it is made before the first step. The other rows are a release rule checked by hand, and the first release tests going back only from the release just before it.

A release that breaks the rule on one platform publishes a list without that platform's artifact. The contract allows a single-platform list, and copies of the other platform get "nothing for this copy" (section 8). **Known limit:** a release that breaks the rule on both platforms publishes no list for that version, because an empty artifact list is refused (release-manifest.ts:64). Installed copies then keep saying "No newer version was found."

## 5. The feed and trust

| Question | Answer |
|---|---|
| URL shape | Feed base `B`. The list is at `B/latest/download/release.json` (+ `.sig`), files at `B/download/v<version>/<file>`. For GitHub, `B` = `https://github.com/<owner>/<repo>/releases`, the repository of `REPO_URL` (cli.ts:25). |
| Override | `GATES_LOCAL_UPDATE_FEED=<base>`, `https:` only |
| Test-build rule | `http:`/`file:` feeds, `GATES_LOCAL_UPDATE_TEST_KEYS` and fault hooks are read only when the packaged build contains `resources/test-build.json`. This is a build-process rule. Production release lists are assembled only from `release:artifact` records. `release:artifact` refuses test-build settings, and packages without `resources/test-build.json`, test keys or fault hooks. The signer verifies list bytes and artifact hashes; it does not inspect installer contents. `release:artifact` forwards `process.env` today (release-kit.ts:94); L1 adds the refusal. guard.ts only checks path containment (guard.ts:33–53), so it is no such rule. |
| When | `automaticChecks` runs only with `GATES_LOCAL_DESKTOP=1` (server main.ts:239; launch.ts:63). "Check for updates" always works. |
| Requests | `https` only. At most 5 redirects, each `https`. List at most 64 KiB, signature at most 1 KiB, artifact at most its listed `size`. 30 s connect/idle timeout, 60 s total for list and signature. No query string and no cookies. `User-Agent: Gates-Local`, without a version. |
| What the server learns | IP address, time, and that a copy checked. Downloading a version reveals that version. |
| Approval pins | the SHA-512 of the exact list bytes, plus the artifact's platform, arch, kind, size and SHA-512. Two validly signed lists for the same version with different bytes are therefore different approvals. |
| Rechecked, not remembered | before a file is moved into place (Linux W2/S1) or run (Windows step 4): the stored list's signature against the built-in keys, its digest against the pin, its version above the running one, and the artifact's hash |
| Not protected | hostile code already running as the same user. It can replace this unsigned per-user app directly. The signature protects only the path from the feed to the disk. |
| Stale list | A page controller can keep serving an old signed list. The copy then says "No newer version was found." (contract; said in docs/releasing.md). |

## 6. Download

| Question | Answer |
|---|---|
| Where | `<data dir>/updates/<version>/` (owner decision D5) |
| Cache completion | Download to `<file>.part`, verifying size and hash as it streams. Write `release.json` and `.sig` (the exact fetched bytes) first. Rename the artifact to `<file>` last. A folder without its list, or a `.part`, is incomplete and deleted. A complete folder is still re-verified before use (section 5). |
| Disk budget | Per volume, from the real sizes. Data volume: the artifact `size`. Linux program volume: `size` for the staged copy, plus the program file's size if hard links are refused. Windows: the installer's own space check, until IU-W1 measures extraction. Checked at download and again at W2. |
| Partial files | not resumed: deleted, then the next attempt starts over |
| Retry | With automatic checks on, a network error or a hash or size mismatch is retried at the next hourly check. With them off, the person uses "Check for updates". |
| Chats | The download streams in the server and holds no admission. Admission closes only at the click. |
| Without asking | yes, when the automatic switch is on (owner decision D1) |
| Switch off | cancels the retry timer and any download in flight, and deletes prepared folders that neither an unfinished transaction nor an undismissed `rollback-failed` result names. "Check for updates" then offers "Download". |
| Cleanup | When a newer list verifies, delete other versions' folders, except one named by an unfinished transaction or by an undismissed `rollback-failed` result, and, on Windows, the kept go-back installer |

## 7. Admission and the handoff deadline (roadmap `a34578dc`)

The 5 s lease (admission.ts:3, :57) and the uptime + 5 s approval deadline carry over unchanged. After commit, main does only quick work while it still holds its server connection, so the lease cannot lapse. The deadline gates the *start* of destructive work, exactly as cli.ts:308–315 does. The watcher waits for the old tree only as long as the deadline allows, then checks the deadline again. Once the old tree is confirmed gone before the deadline, no server exists that could reopen admission, so later rows do not race it. The roadmap's "including rollback" is met by B4's T2 token and its result.

| Abandon case | What happens |
|---|---|
| Window closed before commit | the reservation expires after 30 s |
| Window closed after commit, before the transaction | main's connection drops and admission reopens 5 s later. Nothing is on disk. |
| The phone | cannot approve (`phoneMay`, ws/server.ts:238). Sends during admission get `UPDATE_PAUSED` (admission.ts:5). |
| App killed after the watcher spawned | W1 sees the tree gone before the deadline and proceeds. The person approved. |
| Old app hangs past the deadline | outcome "did not close", nothing moved. The next launch shows it. |
| Another start during the update | the ordinary-launch rule (section 2) |

## 8. What the person sees

L1 names the copy **"Installed copy"**. It replaces "Not a git clone" (SettingsUpdates.tsx:28) and the docs' "Standalone copy" (releasing.md L92, L670). A sentence in *[brackets]* appears only while automatic checks are on.

| State | Words |
|---|---|
| version row | "Installed copy <v>" — "Updates come from the Gates Local release page." |
| no key | "This build has no release key, so it cannot check for updates. Download the latest version from the release page." + link |
| none found | "No newer version was found." |
| available | "Version <new> is available." |
| nothing for this copy | "Version <new> is available, but this copy cannot install it by itself. Download it from the release page." + link |
| could not check | "Could not reach the update server. Check your connection. *[Gates Local will try again in an hour.]*" |
| 404 | "No release list was found on the release page. *[Gates Local will try again in an hour.]*" |
| bad signature | "The release list did not pass its signature check, so Gates Local ignored it. Nothing was downloaded. If this keeps happening, download the latest version from the release page." + link |
| downloading | "Downloading version <new> (<a> of <b> MB). You can keep chatting." |
| bad download | "The download of version <new> did not match the signed release list, so it was deleted. *[It will be downloaded again at the next check.]*" |
| disk | "Not enough free space on <volume> for version <new> (needs <n> MB, <m> MB free). Free some space, then use Check for updates." |
| ready, Linux | "Restart to update" — "Gates Local will close, update and reopen." |
| ready, Windows | "Restart to update" — "If version <new> does not start, Gates Local will not go back by itself. To go back, run <path>." (or "…download version <current> from <release page link>.") |
| read-only / no-permission / not-appimage | "Gates Local cannot replace its own file because its folder is read-only / because you do not have permission to change its folder / because it was not started from an AppImage file. Download version <new> from the release page and replace the file yourself." + link |
| pinned data folder | "This copy keeps its data in a folder set by GATES_LOCAL_DATA_DIR, so it cannot update itself. Download version <new> from the release page." + link |
| update startup | "Gates Local is finishing an update." |
| watcher died | "Close Gates Local and start it again to finish the update." |
| second launch | "Gates Local is updating. It will reopen by itself." |
| other copy | "Another Gates Local copy at <path> is in the middle of an update. Start that copy to finish it." |
| updated | "Updated to version <new>." |
| rolled back | "Version <new> did not start, so Gates Local went back to <old>. Your chats are as they were when you clicked Restart." |
| stuck | "Gates Local could not confirm that version <new> stopped. Restart your computer and start Gates Local; it will finish going back." |
| replace paused | "Gates Local could not finish replacing its program file because <the disk is full / it has no permission to change <path>>. Nothing was deleted. Fix that, then start Gates Local again; it will carry on from where it stopped." |
| go-back paused | "Gates Local could not finish going back to version <old> because <the disk is full / it has no permission to change <path>>. Nothing was deleted. Fix that, then start Gates Local again; it will carry on from where it stopped." |
| rollback failed: the copy of the chats is missing or wrong (B2a; failure page) | "Version <new> did not start, and Gates Local could not go back to <old>, because the copy of your chats made before the update was not found at <store copy path>. Nothing was moved. Version <old> is saved at <.previous path>, but it cannot open chats that version <new> has already upgraded. Your chats are in <data folder>. Start Gates Local to try version <new> again, or download it again from the release page." + link |
| rollback failed: the old version did not start either (B4; failure page) | "Version <new> did not start. Gates Local put version <old> back at <path> and restored your chats, but version <old> did not start either. Your chats are in <data folder>; the files version <new> left are in <aside path>. Start Gates Local again. If it still does not start, download version <old> from the release page and replace <path>." + link. It never names a saved previous file here: B3 has already used it. |
| earlier failure not dismissed | "An earlier update did not finish. Read that note and dismiss it before updating again." |
| unknown file (watcher's failure page) | "Gates Local found a file it did not put at <path>, so it changed nothing. Version <old> is saved at <.previous path> and version <new> at <incoming path>. Put either one at <path>, or download it from the release page." + link |
| did not close | "The update did not start because Gates Local did not close in time. Nothing was changed. Try Restart to update again." |
| Windows did not finish | "The update to version <new> did not finish. Run <kept installer path> or download version <new> from the release page to finish or repair it." + link |

## 9. electron-updater, honestly

electron-updater is not in node_modules. Only electron-builder 26.18.0, app-builder-lib and builder-util-runtime 9.7.0 are. These lines are general knowledge, **not confirmed from local docs**.

- **It gives:** a tested NSIS `quitAndInstall` and AppImage self-replace, blockmap differential downloads, and a GitHub provider.
- **It does not give:** going back after a failed start, our admission, or Ed25519 lists. Its integrity is a `sha512` in `latest.yml` served beside the file. Its Windows publisher check needs signed installers, and ours are unsigned.

The decision of 2026-11-08 stands. Read its NSIS handling before the Windows lane.

## 10. Proof plan

- **Fault:** `resources/test-build.json` may carry `"fault": "server-never-ready"`. The packaged server then never prints ready. Such a build cannot reach a production list (section 5's build-process rule).
- **Feed fixture:** a fresh Ed25519 key in the test's work folder, outside any checkout, deleted at the end. Lists for N, N+1 and N+1-broken, served from a loopback server on a free port that is never 11434–11444 or 8188.
- **Interruption, row level.** `GATES_LOCAL_UPDATE_TEST_STOP_AT=<point>`, read only in a test build, kills the watcher at a named point. A relaunch is then checked against that row's recovery column. The points are `<row>.before` and `<row>.after` for each row, plus points inside operations:
  - after each B2a rename
  - after the B2b copy flush
  - after the B2b rename
  - after the S3 replacing rename
  - between the result write and row C
- **Interruption, store and restore level.** Built as fixtures in unit tests: a database moved aside while its WAL is still live; a copy installed before the aside moves were durable; interrupted migrations that leave intermediate copies. The packaged tests keep to ownership and admission.

| Test | Proves | Runs on |
|---|---|---|
| IU-01 | The installed version and the N+1 offer are shown, which fails today because the packaged server composes the clone updater. Also: "No newer version was found", each could-not-check sentence, nothing in `updates/`, no `git` spawned. | Linux test machine, extract mode |
| IS-01 | v4 fixture → latest writes `threads.v4.sqlite`. Injected ENOSPC refuses the migration with the DB still at v4. Interrupted migrations keep the original version's copy. | unit (Store) |
| IU-02 | Size cap, hash mismatch, incomplete cache, switch-off cancel and delete | Linux |
| IR-01 | B2a/B2b resumed from every store fixture state | unit (L3) |
| IU-03 | N → N+1: result with T1, `.previous` removed, no client before the result | Linux, extract and mounted |
| IU-04 | N → broken: B1–B4, store restored, T2 result, words | Linux |
| IU-05 | every named point; a double-click during an update; a dead watcher during L2 | Linux |
| IU-06 | `APPIMAGE` set in both modes; each refusal case | Linux |
| IU-W1 | W-A forward; pending note; kept installer; the bound for the custom check | native Windows (releasing.md L232–389 procedure) |
| IU-W2 | W-A with the broken build: nothing goes back, the status page names the installer | native Windows |
| IU-W3 | an unrelated copy in `...\Programs\gates-local-old\` survives the custom check | native Windows |

**Unproven without a person:**

- SmartScreen and Defender prompts
- shortcuts as seen
- double-click launches
- AppImageLauncher copies
- logging out or suspending during the 60 s wait
- a real power cut

## 11. Phases as lanes

Lanes that run at the same time share no file. A later lane edits a file an earlier lane changed only after that lane has landed. That applies to the wire union (`UpdateStatus`, shapes.ts:534) and to server and desktop composition. The contract reader and the release commands are already on main (648b098). L1 and Store start now, with these narrowed scopes.

| Lane | Delivers | Files | Done test, which fails before the lane's work |
|---|---|---|---|
| L1 (narrowed: check only) | Knows its version; checks; says available / none found / nothing for this copy / why not. Exposes no install action. Adds the test-build setting and the `release:artifact` refusal. | `packages/contracts/src/shapes.ts` (`UpdateVersion` installed kind and the check states only); `apps/server/src/update/installed/{check,feed,module}.ts` + tests; `apps/server/src/main.ts` (installed composition, and no `REPO_ROOT` clone module when packaged); `apps/desktop/src/launch.ts` (installed marker env); `apps/desktop/scripts/package.ts` (`test-build.json`); `scripts/release-kit.ts` and `test/release-kit.test.ts` (the refusal); `apps/desktop/scripts/packaged-smoke.ts` (:88–89 assertion); `apps/web/src/SettingsUpdates.tsx`, `Updates.tsx`; `docs/releasing.md` (name) | IU-01, plus a release-kit test that a test-build setting is refused |
| Store (narrowed: the copy only) | Pre-migration copy, naming, refusal when the copy cannot be made, no pruning | `apps/server/src/threads/{migrations,copies}.ts`, `errors.ts`, `store.test.ts` | IS-01 |
| L2 | Verified download with its status, bounded requests, cache completion, cleanup protection | `shapes.ts` (`UpdateStatus` download state, after L1); `installed/download.ts` + test; `installed/module.ts` (after L1); `apps/web/src/update-state.ts`, `SettingsUpdates.tsx` (after L1) | IU-02 |
| L3 | Linux replace, update startup, results, go back, store restore | `apps/desktop/src/installed-update/{watch,linux,launch-kinds,ack,restore,failure-page}.ts` + tests; desktop `main.ts` (launch kinds, `route()`); `preload.ts`, `bridge.ts`, `update-launch.ts`, `apps/web/src/update-install.ts`, `session/updates.ts` (approval target); `shapes.ts` (`UpdateInstallRequest`/`UpdateCommitRequest` target, `UpdateResult` outcome `rolled-back`); `admission.ts` (target name); `installed/module.ts` (prepare/commit; no `takeRecord` during update startup); `apps/server/src/update/record.ts` (`rolled-back`, `token`, fsync); server `main.ts` (update-startup admission hold); `scripts/packaged-upgrade.ts` | IR-01, IU-03 to IU-06 |
| L4 | Windows W-A, or W-B if the owner picks it | `apps/desktop/src/installed-update/windows.ts` + test; `apps/desktop/build/installer.nsh`; `package.ts` (`nsis.include`); desktop `main.ts` (pending note); `docs/releasing.md` (IU-W rounds) | IU-W1 to IU-W3 |

L1 and Store run together. L2 runs after L1. L3 starts after this protocol is reviewed, then L4.

**Later items:**

- pruning `store-copies/`
- clone `goBack` restoring a migrated store (pre-existing gap; needs the data folder and the store version in the clone transaction)
- the Windows store-copy gap in W-A

**Known limits, mechanism-free:**

- **Key rotation:** a copy that skipped every release signed by both keys reinstalls by hand. The bad-signature and no-key sentences carry the link.
- **Proxies and captive portals:** the check fails with its sentence and, with automatic checks on, retries hourly.
- **Metered links:** the automatic switch is the control. **Not done:** a launchability probe for `noexec` or removable volumes; a failed launch is already the go-back case.

## 12. Owner decisions

| # | Question | Options | Pick |
|---|---|---|---|
| D1 | Download quietly or ask first? | (a) quietly when the switch is on; (b) ask before each download | (a) |
| D2 | When is the previous program file deleted (Linux)? | (a) at row C after `updated`; (b) at the next update; (c) after 7 days. A `rollback-failed` keeps it until dismissed in every option. | (a). A manual return after a migration meets `StoreVersionTooNewError` anyway. |
| D3 | Windows | (a) W-A, no automatic go-back; (b) W-B, a recovery launcher first | (a) |
| D4 | AppImage file name after an update | (a) keep the person's name; (b) rename it to the new version | (a), so launchers keep working |
| D5 | Where downloads live | (a) `<data dir>/updates/`; (b) next to the program file, which saves the staging copy but leaves a hidden file in the person's folder for hours | (a) |

## 13. Unverified

**Read from source, not run.** These are settled from the templates and code cited in section 3:

- the stock kill-by-prefix with no separator, and the per-user `taskkill` fallback
- the `--updated` behaviour
- the old uninstaller's copy-out and the per-file move
- `--force-run` and `ExecShellAsUser`
- no downgrade refusal
- `customCheckAppRunning` replacing the stock check in installer and uninstaller

U8 (a single-platform list) is settled by the contract and the reader in 648b098, and removed.

| # | Claim | Settled by |
|---|---|---|
| U1 | `APPIMAGE` is set in both mount and extract modes | IU-06 |
| U2 | Electron main runs watcher mode with no window, opens a failure page when needed, and exits cleanly | IU-03, IU-04 |
| U3 | Renaming over a running FUSE-mounted AppImage leaves the old mount working | IU-03 mounted |
| U4 | `releaseSingleInstanceLock` frees the profile lock for a token launch within its 5 s retry | IU-05 |
| U5 | `VACUUM INTO` under `node:sqlite` in the packaged Electron gives a copy that opens at the source's `user_version` | IS-01 |
| U6 | Effect Schema drops unknown settings keys on decode | IU-04 |
| U7 | `os.uptime()` includes suspend on Linux; `performance.now()` excludes it | a manual suspend round |
| U9 | The custom check's wait bound, and the space the installer needs | IU-W1 |
| U10 | `Setup.exe /S --updated --force-run` started by the quitting app installs and starts the new version | IU-W1 |
| U11 | A file fetched by Node gets no Mark-of-the-Web, so SmartScreen does not prompt | IU-W1 + a person |
| U12 | GitHub `latest/download` skips drafts and prereleases | the release lane's first real release |
| U13 | Every electron-updater claim in section 9 | its source; it is not installed here |
| U14 | The T1 server is in T1's process group, so `treeGone` on T1's record covers it | IU-05 (dead watcher during L2) |
