---- MODULE Update ----
\* An update, from the person's approval to a copy that is whole again: the handoff from the running
\* app to the updater (both kinds of copy), and what is on disk for a copy run from source.
\*
\* Two parts are NOT written here. They are the tables in UpdateCode, which model/update/table.ts
\* reads from the real code on every run:
\*   StartCode  what a start does, from decideCheckoutStart() in packages/update/src/checkout-start.ts
\*   AdmStep    how admission answers, from createUpdateAdmission() in packages/update/src/admission.ts
\*   Deadline   how long the updater waits for the old app, from the constants the code uses
\* Everything else is written by hand from the code each action names, and model/update/covered.json
\* holds the hash of each of those files.
\*
\* Time is steps. The one place two waits race (the server's wait before it lets work in again, and
\* the updater's deadline) is decided by their lengths: see AdmissionTimerRunsOut.
EXTENDS Naturals, UpdateCode

CONSTANTS
  Kind,          \* "checkout" (a copy run from source) or "installed"
  MaxApprovals, MaxCrashes, MaxStarts,
  \* Guards that closed a real bug. TRUE is the code today; FALSE is the code before the fix.
  AStartFinishesTheUpdateFirst,  \* a start asks decideCheckoutStart() before it runs anything
  ServerGraceIsTheDeadline       \* an installed copy's server waits INSTALLED_APPROVAL_MS, as its updater does

VARIABLES
  adm,        \* admission, as a state of UpdateCode
  stage,      \* the approval: idle, reserved, committed, started
  approvals,
  upd,        \* the updater: none, waiting (for the old app to close), running, gaveUp, dead, done
  app,        \* the app that was running when the update was approved: up, gone
  expired,    \* the updater's deadline has passed
  saved,      \* the saved update on disk: none, forward, launch_token, launch_plain, back
  head,       \* the commit the files are at: old, torn (git was cut off moving them), new
  built,      \* what the install and builds are for: old, torn, new
  doing,      \* the command the updater is in the middle of
  newApp,     \* an app started since: none, starting (the updater's own launch), up
  tried,      \* the next start follows an attempt to finish the saved update
  crashes, starts,
  \* The rest only remember what happened, for the rules at the bottom.
  lateWork, wentAhead, reopened

vars == <<adm, stage, approvals, upd, app, expired, saved, head, built, doing, newApp, tried,
          crashes, starts, lateWork, wentAhead, reopened>>

Handoff == <<adm, stage, approvals, expired, lateWork, wentAhead, reopened>>
Disk == <<saved, head, built, doing>>
Bounds == <<crashes, starts>>

Whole == head # "torn" /\ built = head
AnAppIsRunning == app = "up" \/ newApp # "none"
Approved == stage \in {"committed", "started"}
Checkout == Kind = "checkout"

Init ==
  /\ adm = AdmFree /\ stage = "idle" /\ approvals = 0
  /\ upd = "none" /\ app = "up" /\ expired = FALSE
  /\ saved = "none" /\ head = "old" /\ built = "old" /\ doing = "idle"
  /\ newApp = "none" /\ tried = FALSE
  /\ crashes = 0 /\ starts = 0
  /\ lateWork = FALSE /\ wentAhead = FALSE /\ reopened = FALSE

\* ---- the handoff ----------------------------------------------------------------------------------

\* The person presses "Restart to update": apps/server/src/update/module.ts prepare() and
\* apps/server/src/update/installed/module.ts prepare() end in admission.reserve(target).
PersonApproves ==
  /\ app = "up" /\ stage = "idle" /\ upd = "none" /\ approvals < MaxApprovals
  /\ AdmStep[adm].reserve.ok
  /\ adm' = AdmStep[adm].reserve.next
  /\ stage' = "reserved" /\ approvals' = approvals + 1
  /\ expired' = FALSE /\ lateWork' = FALSE
  /\ UNCHANGED <<upd, app, Disk, newApp, tried, Bounds, wentAhead, reopened>>

\* apps/desktop/src/update-launch.ts launchApprovedUpdate(): control.commit(), which is
\* admission.commit(...) with the default wait in apps/server/src/update/module.ts (a checkout) and
\* with INSTALLED_APPROVAL_MS in apps/server/src/update/installed/module.ts (an installed copy).
\* A commit that is refused means the approval ran out; nothing starts.
CommitEvent == IF Kind = "installed" /\ ServerGraceIsTheDeadline THEN "commit_long" ELSE "commit_default"
MainCommits ==
  /\ app = "up" /\ stage = "reserved"
  /\ adm' = AdmStep[adm][CommitEvent].next
  /\ stage' = IF AdmStep[adm][CommitEvent].ok THEN "committed" ELSE "idle"
  /\ UNCHANGED <<approvals, upd, app, expired, Disk, newApp, tried, Bounds, lateWork, wentAhead, reopened>>

\* launchApprovedUpdate(): start() began the detached updater. apps/desktop/src/update-launch.ts
\* approvedHandoffEnv() gives it its deadline, counted from before the commit.
MainStartsTheUpdater ==
  /\ app = "up" /\ stage = "committed"
  /\ stage' = "started" /\ upd' = "waiting"
  /\ UNCHANGED <<adm, approvals, app, expired, Disk, newApp, tried, Bounds, lateWork, wentAhead, reopened>>

\* launchApprovedUpdate(): the updater did not start, so main gives back the pause with its own key,
\* then with the window's: control.cancel(release), control.cancel(request.reservation).
MainStartFails ==
  /\ app = "up" /\ stage = "committed"
  /\ adm' = AdmStep[AdmStep[adm].cancel_main.next].cancel_window.next
  /\ stage' = "idle"
  /\ UNCHANGED <<approvals, upd, app, expired, Disk, newApp, tried, Bounds, lateWork, wentAhead, reopened>>

\* The window gives back its reservation (the person closed the dialog, or the page was reloaded):
\* the server's update.cancel handler, admission.cancel(reservation). After the commit the window's
\* key opens nothing.
WindowCancels ==
  /\ app = "up" /\ stage # "idle"
  /\ adm' = AdmStep[adm].cancel_window.next
  /\ reopened' = (reopened \/ (Approved /\ AdmStep[adm].cancel_window.ok))
  /\ stage' = IF stage = "reserved" THEN "idle" ELSE stage
  /\ UNCHANGED <<approvals, upd, app, expired, Disk, newApp, tried, Bounds, lateWork, wentAhead>>

\* The connection the commit came in on is lost (main quit, or the socket dropped): the `disconnected`
\* signal of admission.commit() starts the wait after which work is let in again.
ConnectionIsLost ==
  /\ app = "up" /\ Approved /\ AdmStep[adm].disconnect.ok
  /\ adm' = AdmStep[adm].disconnect.next
  /\ UNCHANGED <<stage, approvals, upd, app, expired, Disk, newApp, tried, Bounds, lateWork, wentAhead, reopened>>

\* admission.ts expire(): the wait ran out and the hold is cancelled. A wait at least as long as the
\* updater's deadline cannot end before that deadline, because the deadline is counted from before
\* the commit and this wait from after it. A shorter one can.
AdmissionTimerRunsOut ==
  /\ app = "up" /\ AdmStep[adm].timer.ok
  /\ adm' = AdmStep[adm].timer.next
  /\ expired' = (expired \/ (Approved /\ AdmWait[adm] >= Deadline[Kind]))
  /\ UNCHANGED <<stage, approvals, upd, app, Disk, newApp, tried, Bounds, lateWork, wentAhead, reopened>>

\* The updater's deadline passes: packages/update/src/cli.ts remaining() <= 0, and for an installed
\* copy the deadline in packages/update/src/installed/transaction.ts.
DeadlinePasses ==
  /\ upd = "waiting" /\ ~expired
  /\ expired' = TRUE
  /\ UNCHANGED <<adm, stage, approvals, upd, app, Disk, newApp, tried, Bounds, lateWork, wentAhead, reopened>>

\* A reply, an image job, a download or an import begins: admission.admit() let it in.
WorkStarts ==
  /\ app = "up" /\ AdmAdmits[adm]
  /\ lateWork' = (lateWork \/ Approved)
  /\ UNCHANGED <<adm, stage, approvals, upd, app, expired, Disk, newApp, tried, Bounds, wentAhead, reopened>>

\* The old app closes, by the handoff or by the person; its server's admission.close() runs.
OldAppCloses ==
  /\ app = "up"
  /\ app' = "gone" /\ adm' = AdmStep[adm].close.next
  /\ UNCHANGED <<stage, approvals, upd, expired, Disk, newApp, tried, Bounds, lateWork, wentAhead, reopened>>

\* packages/update/src/cli.ts: waitForExit() saw the old app gone. The deadline is read again after
\* the wait, and packages/update/src/apply.ts transact() refuses while any app is running.
UpdaterSeesTheOldAppGone ==
  /\ upd = "waiting" /\ app = "gone"
  /\ IF expired \/ newApp # "none"
     THEN upd' = "gaveUp" /\ UNCHANGED wentAhead
     ELSE upd' = "running" /\ wentAhead' = TRUE
  /\ UNCHANGED <<adm, stage, approvals, app, expired, Disk, newApp, tried, Bounds, lateWork, reopened>>

\* cli.ts: the old app did not close in time. Nothing was changed.
UpdaterStopsWaiting ==
  /\ upd = "waiting" /\ app = "up"
  /\ upd' = "gaveUp"
  /\ UNCHANGED <<Handoff, app, Disk, newApp, tried, Bounds>>

\* An installed copy's updater is the watcher; what it does to the files is not in this model.
InstalledUpdateFinishes ==
  /\ ~Checkout /\ upd = "running"
  /\ upd' = "done"
  /\ UNCHANGED <<Handoff, app, Disk, newApp, tried, Bounds>>

\* ---- a copy run from source: what the updater does to it -------------------------------------------

Working == Checkout /\ upd = "running" /\ doing = "idle"

\* packages/update/src/apply.ts changing(): the update is saved before the first command that
\* changes the copy.
SaveForward ==
  /\ Working /\ saved = "none" /\ head = "old"
  /\ saved' = "forward"
  /\ UNCHANGED <<Handoff, upd, app, head, built, doing, newApp, tried, Bounds>>

\* apply.ts transact(): git merge --ff-only begins, and ends.
MergeBegins ==
  /\ Working /\ saved = "forward" /\ head = "old"
  /\ head' = "torn" /\ doing' = "merge"
  /\ UNCHANGED <<Handoff, upd, app, saved, built, newApp, tried, Bounds>>
MergeEnds ==
  /\ Checkout /\ upd = "running" /\ doing = "merge"
  /\ head' = "new" /\ doing' = "idle"
  /\ UNCHANGED <<Handoff, upd, app, saved, built, newApp, tried, Bounds>>

\* apply.ts installAndBuild(): install, build-web and build-desktop begin, and end or fail.
BuildBegins ==
  /\ Working /\ saved = "forward" /\ head = "new" /\ built # "new"
  /\ built' = "torn" /\ doing' = "build"
  /\ UNCHANGED <<Handoff, upd, app, saved, head, newApp, tried, Bounds>>
BuildEnds ==
  /\ Checkout /\ upd = "running" /\ doing = "build"
  /\ built' = "new" /\ doing' = "idle"
  /\ UNCHANGED <<Handoff, upd, app, saved, head, newApp, tried, Bounds>>
BuildFails ==
  /\ Checkout /\ upd = "running" /\ doing = "build"
  /\ saved' = "back" /\ doing' = "idle"
  /\ UNCHANGED <<Handoff, upd, app, head, built, newApp, tried, Bounds>>

\* installAndBuild(): the launch is saved with a token and the new version is started with it.
\* The start is asked of decideCheckoutStart() like any other, carrying the token.
SaveLaunchAndStart ==
  /\ Working /\ saved = "forward" /\ head = "new" /\ built = "new"
  /\ saved' = "launch_token"
  /\ newApp' = IF StartCode["launch_token"]["updating"]["fresh"]["match"] = "start" THEN "starting" ELSE "none"
  /\ doing' = "launch"
  /\ UNCHANGED <<Handoff, upd, app, head, built, tried, Bounds>>

\* installAndBuild() with no startApp (the updater was run from a terminal): the launch is saved
\* without a token and the run ends "awaiting-start".
SaveLaunchAndEnd ==
  /\ Working /\ saved = "forward" /\ head = "new" /\ built = "new"
  /\ saved' = "launch_plain" /\ upd' = "done"
  /\ UNCHANGED <<Handoff, app, head, built, doing, newApp, tried, Bounds>>

\* packages/update/src/startup.ts acknowledgeStartup(): the new version's server is ready, so the
\* saved update is cleared.
NewVersionIsReady ==
  /\ newApp = "starting"
  /\ newApp' = "up" /\ saved' = "none"
  /\ upd' = IF upd = "running" THEN "done" ELSE upd
  /\ doing' = "idle"
  /\ UNCHANGED <<Handoff, app, head, built, tried, Bounds>>

\* startup.ts reportStartupFailure(), or the updater stopping a start that takes too long: the new
\* version is gone, and a running updater starts back (apply.ts goBack(), step "start").
NewVersionFails ==
  /\ newApp = "starting"
  /\ newApp' = "none"
  /\ saved' = IF upd = "running" THEN "back" ELSE saved
  /\ doing' = "idle"
  /\ UNCHANGED <<Handoff, upd, app, head, built, tried, Bounds>>

\* apply.ts goBack(): git reset --keep to the old commit begins, and ends.
ResetBegins ==
  /\ Working /\ saved = "back" /\ head = "new" /\ newApp = "none"
  /\ head' = "torn" /\ doing' = "reset"
  /\ UNCHANGED <<Handoff, upd, app, saved, built, newApp, tried, Bounds>>
ResetEnds ==
  /\ Checkout /\ upd = "running" /\ doing = "reset"
  /\ head' = "old" /\ doing' = "idle"
  /\ UNCHANGED <<Handoff, upd, app, saved, built, newApp, tried, Bounds>>

\* goBack(): the old version is installed and built again.
RebuildBegins ==
  /\ Working /\ saved = "back" /\ head = "old" /\ built # "old"
  /\ built' = "torn" /\ doing' = "rebuild"
  /\ UNCHANGED <<Handoff, upd, app, saved, head, newApp, tried, Bounds>>
RebuildEnds ==
  /\ Checkout /\ upd = "running" /\ doing = "rebuild"
  /\ built' = "old" /\ doing' = "idle"
  /\ UNCHANGED <<Handoff, upd, app, saved, head, newApp, tried, Bounds>>

\* apply.ts settle(): back on the old version, whole, the saved update is cleared.
Settle ==
  /\ Working /\ saved = "back" /\ head = "old" /\ built = "old"
  /\ saved' = "none" /\ upd' = "done"
  /\ UNCHANGED <<Handoff, app, head, built, doing, newApp, tried, Bounds>>

\* ---- what can cut it off ---------------------------------------------------------------------------

\* The updater is killed. A command it was in the middle of leaves what it had half done.
UpdaterDies ==
  /\ Checkout /\ upd = "running" /\ crashes < MaxCrashes
  /\ upd' = "dead" /\ doing' = "idle" /\ crashes' = crashes + 1
  /\ UNCHANGED <<Handoff, app, saved, head, built, newApp, tried, starts>>

\* The power goes: every process stops.
PowerCut ==
  /\ Checkout /\ upd \in {"waiting", "running"} /\ crashes < MaxCrashes
  /\ upd' = "dead" /\ doing' = "idle" /\ crashes' = crashes + 1
  /\ app' = "gone" /\ newApp' = "none"
  /\ adm' = AdmStep[adm].close.next
  /\ UNCHANGED <<stage, approvals, expired, lateWork, wentAhead, reopened, saved, head, built, tried, starts>>

\* packages/update/src/apply.ts recover(), reached from transact(). It refuses while an app runs,
\* and refuses a copy git left part way ("partial-checkout"): only the person's hands finish that.
\* A saved launch goes back; a saved forward that never moved the commit is settled; the rest goes on.
CanRecover == ~AnAppIsRunning /\ head # "torn" /\ saved # "none"
SavedAfterRecover ==
  IF saved \in {"launch_token", "launch_plain"} THEN "back"
  ELSE IF saved = "forward" /\ head = "old" THEN "none"
  ELSE saved
UpdAfterRecover == IF SavedAfterRecover = "none" THEN "done" ELSE "running"

\* The person runs the updater again by hand.
UpdaterRunsAgain ==
  /\ Checkout /\ upd \in {"dead", "done", "gaveUp"} /\ CanRecover
  /\ saved' = SavedAfterRecover /\ upd' = UpdAfterRecover
  /\ UNCHANGED <<Handoff, app, head, built, doing, newApp, tried, Bounds>>

\* ---- a start ---------------------------------------------------------------------------------------

\* apps/desktop/src/checkout-start.ts startCheckout(): the start looks (checkoutStartFacts(), then
\* decideCheckoutStart()) and does what it is told. "start" runs the app, and a launch saved without
\* a token is acknowledged by it (acknowledgeStartup()). "finish" runs the updater first and the start
\* after it carries `tried`. "wait" and "say" start nothing.
Told ==
  IF AStartFinishesTheUpdateFirst
  THEN StartCode[saved][IF upd = "running" THEN "updating" ELSE "idle"][IF tried THEN "tried" ELSE "fresh"]["none"]
  ELSE "start"
PersonStartsTheApp ==
  /\ Checkout /\ ~AnAppIsRunning /\ starts < MaxStarts
  /\ starts' = starts + 1
  /\ CASE Told = "start" ->
            /\ newApp' = "up" /\ tried' = FALSE
            /\ saved' = IF saved = "launch_plain" THEN "none" ELSE saved
            /\ UNCHANGED upd
       [] Told = "finish" ->
            /\ tried' = TRUE
            /\ saved' = IF CanRecover THEN SavedAfterRecover ELSE saved
            /\ upd' = IF CanRecover THEN UpdAfterRecover ELSE upd
            /\ UNCHANGED newApp
       [] OTHER -> tried' = FALSE /\ UNCHANGED <<saved, upd, newApp>>
  /\ UNCHANGED <<Handoff, app, head, built, doing, crashes>>

\* No code: the person closes the app they started.
PersonClosesTheApp ==
  /\ Checkout /\ newApp = "up"
  /\ newApp' = "none"
  /\ UNCHANGED <<Handoff, upd, app, Disk, tried, Bounds>>

Next ==
  \/ PersonApproves \/ MainCommits \/ MainStartsTheUpdater \/ MainStartFails \/ WindowCancels
  \/ ConnectionIsLost \/ AdmissionTimerRunsOut \/ DeadlinePasses \/ WorkStarts \/ OldAppCloses
  \/ UpdaterSeesTheOldAppGone \/ UpdaterStopsWaiting \/ InstalledUpdateFinishes
  \/ SaveForward \/ MergeBegins \/ MergeEnds \/ BuildBegins \/ BuildEnds \/ BuildFails
  \/ SaveLaunchAndStart \/ SaveLaunchAndEnd \/ NewVersionIsReady \/ NewVersionFails
  \/ ResetBegins \/ ResetEnds \/ RebuildBegins \/ RebuildEnds \/ Settle
  \/ UpdaterDies \/ PowerCut \/ UpdaterRunsAgain \/ PersonStartsTheApp \/ PersonClosesTheApp

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ adm \in AdmStates
  /\ stage \in {"idle", "reserved", "committed", "started"}
  /\ upd \in {"none", "waiting", "running", "gaveUp", "dead", "done"}
  /\ app \in {"up", "gone"} /\ newApp \in {"none", "starting", "up"}
  /\ saved \in {"none", "forward", "launch_token", "launch_plain", "back"}
  /\ head \in {"old", "torn", "new"} /\ built \in {"old", "torn", "new"}
  /\ doing \in {"idle", "merge", "build", "launch", "reset", "rebuild"}
  /\ approvals \in 0..MaxApprovals /\ crashes \in 0..MaxCrashes /\ starts \in 0..MaxStarts

\* ---- the rules, in the owner's words ---------------------------------------------------------------

\* Once an update is approved and goes ahead, no reply, image job, download or import began after
\* the approval: it would be cut off when the app closes.
NoNewWorkOnceApproved == ~(lateWork /\ wentAhead)

\* The window's key stops working at the commit: a late cancel from it cannot let work back in.
ALateCancelCannotReopenAdmission == ~reopened

\* No app runs on a copy that is part way between two versions.
NoAppRunsOnAHalf == AnAppIsRunning => Whole

\* When nothing is saved as unfinished, the copy is whole.
NothingUnfinishedMeansWhole == saved = "none" => Whole
====
