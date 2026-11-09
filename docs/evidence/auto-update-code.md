# Automatic update implementation evidence

Initial implementation snapshot: `8df63ef`, based on `849a585`. At that
snapshot no browser or Electron execution had occurred. Later runtime
acceptance is recorded in `auto-update-runtime.md`.

The source updater is unchanged. Checks now hold its existing checkout lock,
and shutdown drains a check before install can start. One timer belongs to
the desktop-supervised server, not the connected windows. Successful checks
push to all clients. Background check failures neither replace the last
answer nor push a failure. Manual checks still report their failures.

The optional `updateAutomatic` setting defaults on when absent, preserving
old settings files. Off prevents future automatic checks. A check already
running finishes. Settings reset restores automatic checking. The setting
test reopens the real store with off, advances a fake clock by two hours,
and observes zero Runner commands, including zero git/network commands.

## Observed red tests

All were written in this lane; these are diagnostic probes, not independent
review or runtime acceptance.

| Probe | Observed failure |
| --- | --- |
| New pure button states against an empty resolver | Five tests failed: target/changes, release notes, installing, clicked failure, rollback record/log |
| New timer against an empty scheduler | Three tests failed: 15 seconds/hourly, enabling after off, offline retry |
| Shutdown reply preservation against existing shutdown | Failed: last saved message was the question, while the UI had received `one ` |
| Hide idle/browser button, disable automatic/browser checks, retain silent errors, exclude installs | Nine failures under explicit temporary mutations; bypasses restored |
| Confirmation and single install action | Two failures under temporary bypasses: no confirmation and two bridge calls; bypasses restored |
| Push during hydration | Failed: an older status snapshot replaced the newer available update; added update.changed to the existing held-channel batch |

Focused tests passed after restoration, including the real server/thread
store shutdown probe. The full verify command includes typecheck, warning-free
lint and all unit tests. See the lane handoff for its final exit and count.

## Production build

`pnpm --filter @gates-local/web build` exited 0. The budget test sums
`gzipSync` bytes for **all** JS/CSS assets, so splitting chunks does not hide
new code from this budget. Using that exact calculation:

| Assets | Gzip bytes | KiB | Existing limit | Result |
| --- | ---: | ---: | ---: | --- |
| JS | 148243 | 144.7686 | less than 144 | Over by 787 bytes |
| CSS | 12953 | 12.6494 | less than 13 | Within |

The standalone size assertion exited 1. Neither budget was changed. Vite's
own compression summary uses a different calculation and is not the gate.

## T3 reference and deliberate differences

Read-only reference: T3 Code commit
`d137c5081ac5efb2b8ea9aec8b334e1bb4d0182a`, especially
`apps/web/src/components/sidebar/SidebarUpdatePill.tsx`,
`DesktopUpdateStatusIcon.tsx`, `components/desktopUpdate.logic.ts`,
`components/desktopUpdate.toast.tsx`, `state/desktopUpdate.ts`,
`apps/desktop/src/updates/updateMachine.ts` and `DesktopUpdates.ts`.

| T3 behavior | Gates Local |
| --- | --- |
| Sidebar footer icon beside Settings/usage | Absolute slot beside Settings; no layout footprint when shown |
| Idle button checks manually; checking spins | Sidebar hidden unless actionable; manual checking remains in Settings |
| Available version, notes; click downloads | Target commit/tag and notes/subjects in tooltip; click starts existing source update |
| Downloading percent, disabled | Closing/installing state, disabled; no invented install percentage |
| Downloaded version; click installs and restarts | No separate downloaded stage, because source install/build happen after closing |
| Install confirmation warns all running tasks will stop | Query server activity first; name replies across clients, image jobs and model downloads; also warn local drafts/queued messages |
| Download/install failure can retry | Shared retry action; transaction result/log and next-start note remain |
| Desktop checks after 15 seconds and every 4 minutes | One desktop timer after 15 seconds, then hourly after each check finishes; default-on preference can disable it |
| Release notes toast and external release URL | Existing next-start result note and fetched git change subjects/notes; no extra network request |
| Packaged electron-updater/signing/architecture warning | Existing clone transaction; no packaged pipeline, tags, signing, Mac warning or staged downloads |

At the initial snapshot the closed-window gap was **not measured**. During it the detached updater
installs/builds with no progress window, then relaunches; output is retained
in the existing update log. Real update/rollback/manual-path proof and the
gap measurement await the virtual-screen runner. Windows is unverified.
