// Settings-only update controls, deferred with the Settings screen.
//
// Two rows: Version (the commit or version, said once, and what this copy
// follows, from the switch), then the state of the last check, labelled with
// that state, one grey line (when it checked, or what went wrong) and the one
// control that moves it on at the right. Neither row changes height between
// states: the grey line never wraps, a failure takes its place, and whatever
// else a state says (the changes, the server's further lines) is the label's
// tip. The release page link sits beside the control.
//
// The desktop server checks the clone's remote after 15 seconds and hourly
// when enabled. Browsers only check on request. Update and
// restart shows only in the desktop app, which quits and lets
// `pnpm run app-update` do the work. The phone listener exposes status only;
// a computer browser may check but installs from the desktop app. An
// installed copy (AppImage or installer) reads the signed release list and
// downloads a newer version for itself (Download while automatic checks are
// off). A Linux AppImage that can replace its own file then shows Restart to
// update; any other copy says why not and links the release page.
import type { Settings, UpdateChannel, UpdateCheck, UpdateStatus, UpdateVersion } from "@gates-local/contracts";
import { useState } from "react";
import { canUpdateHere, checkForUpdates, downloadUpdate, updateAndRestart, updateSettings } from "./session.ts";
import { Grp, Na, Row, Skel, useAct } from "./settings-ui.tsx";
import { type Maybe, NA, useStore } from "./store.ts";
import { esc } from "./ui.tsx";
import { outdated } from "./update-state.ts";

/** Subjects shown before the rest fold away under "Show all". */
export const SHOWN_CHANGES = 3;

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const changes = (n: number) => (n === 1 ? "1 change" : `${n} changes`);

/** Row 1: the commit or version once as the value; the description says what kind of copy it is and what it follows. */
function versionText(v: UpdateVersion, channel: UpdateChannel): { value: string; desc: string } {
  switch (v.kind) {
    case "release":
      return { value: v.tag, desc: `Commit ${v.commit}${v.date === undefined ? "" : `, ${day(v.date)}`}, following ${channel === "main" ? "every change on the main branch" : "releases"}.` };
    case "commit": {
      const when = v.date === undefined ? "A commit" : `A commit from ${day(v.date)}`;
      return { value: v.commit, desc: channel === "main" ? `${when} on the main branch.` : `${when}, between releases.` };
    }
    case "not-a-clone":
      return { value: "Not a git clone", desc: "This copy was not downloaded with git clone, so it cannot check for updates or update itself." };
    case "unreadable":
      return { value: "Unknown", desc: `Could not read the version: ${v.detail}.` };
    case "installed":
      return { value: v.version, desc: "An installed copy, following releases." };
  }
}

const AGAIN = "Gates Local will try again in an hour.";
// A file that did not match is not fetched again by a background check of the same list.
const DOWNLOAD_AGAIN = "Use Check for updates to try again.";

/** The sentence Settings adds while automatic checks are on now, so it follows the switch, not the check. */
function retryLine(check: UpdateCheck): string | undefined {
  if (check.state === "cannot-check") return check.reason === "unreachable" || check.reason === "no-list" ? AGAIN : undefined;
  if (check.state !== "newer") return undefined;
  if (check.download === "bad") return DOWNLOAD_AGAIN;
  return check.download === "failed" ? AGAIN : undefined;
}

/** The words send the person to the release page: a version this copy cannot use, or one it downloaded but cannot install. */
function linksPage(check: UpdateCheck): string | undefined {
  if (check.state === "cannot-check") return check.page;
  if (check.state !== "newer") return undefined;
  return !check.forThisCopy || (check.download === "ready" && check.restart !== true) ? check.page : undefined;
}

/** Row 2's label: the state in a few words, short enough for one line. */
function stateLabel(check: UpdateCheck | null, checking: boolean): string {
  if (checking) return "Checking…";
  if (check === null) return "Not checked yet";
  switch (check.state) {
    case "up-to-date":
      return "Up to date";
    case "available":
    case "newer":
      return `Update available: ${check.target}`;
    case "cannot-check":
      return "Couldn’t check";
  }
}

const checked = (check: UpdateCheck) => `Checked at ${clock(check.checkedAt)}.`;

/** Row 2's one grey line: when it checked, or what the state needs said first. It never wraps, so no state changes the row's height. */
function stateLine(check: UpdateCheck | null, control: boolean, canUpdate: boolean): string {
  // A space keeps the line's height before the first check.
  if (check === null) return control ? " " : "Check and install updates on the computer running Gates Local.";
  switch (check.state) {
    case "up-to-date":
      return checked(check);
    case "available":
      return canUpdate ? `${changes(check.total)}. ${checked(check)}` : "To install it, close Gates Local on the computer it runs on and run pnpm run app-update in its folder.";
    case "cannot-check":
      return check.lines[0] ?? checked(check);
    case "newer": {
      // The server's plain "Version X is available." is the label already.
      const first = check.lines[0];
      return first === undefined || first === `Version ${check.target} is available.` ? checked(check) : first;
    }
  }
}

/**
 * Row 2's tip: everything else the state says (the changes, the server's
 * further lines, when it tried), so nothing is added under the row.
 */
function stateTip(check: UpdateCheck | null, automatic: boolean, installed: boolean, canUpdate: boolean): string | undefined {
  if (check === null || check.state === "up-to-date") return undefined;
  if (check.state === "available") {
    const notes = check.notes?.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    const items = notes ?? check.changes;
    const more = (notes === undefined ? check.total : items.length) - Math.min(items.length, SHOWN_CHANGES);
    const list = `${notes === undefined ? changes(check.total) : "Release notes"}: ${items.slice(0, SHOWN_CHANGES).join("; ")}${more > 0 ? `; and ${more} more` : ""}.`;
    const how = canUpdate
      ? `Update and restart closes Gates Local, updates it and opens it again. If a step fails it goes back to ${check.current}.`
      : "To install it, close Gates Local on the computer it runs on and run pnpm run app-update in its folder.";
    return `${list} ${how}`;
  }
  const again = installed && automatic ? retryLine(check) : undefined;
  const parts = [...check.lines];
  if (again !== undefined) parts.push(again);
  if (check.state === "newer" && check.restart === true && canUpdate) parts.push("Gates Local will close, update and reopen.");
  if (check.state === "cannot-check") parts.push(`Tried at ${clock(check.checkedAt)}.`);
  return parts.join(" ");
}

/** The grey line cut to one line (the label's tip has the whole of it), or the last action's failure in its place with its own tip. */
function StateLine({ text, err, calm }: { text: string; err: string | null; calm: boolean }) {
  if (err !== null) return <span className="src-help act-err" role="alert" data-tip={esc(err)}>{err}</span>;
  return <span className="src-help" role={calm ? "status" : "alert"}>{text}</span>;
}

/** A check that failed, or a download that did: said as an alert. */
const troubled = (check: UpdateCheck | null) => check?.state === "cannot-check" || (check?.state === "newer" && (check.download === "bad" || check.download === "failed" || check.download === "disk"));

interface StateProps {
  readonly check: UpdateCheck | null;
  readonly automatic: boolean;
  /** Update and restart, or Restart to update: the desktop app, with control. */
  readonly canUpdate: boolean;
  readonly checking: boolean;
  readonly updating: boolean;
  readonly onCheck: () => void;
  readonly onUpdate: () => void;
  /** The Download control; absent where this window cannot control updates. */
  readonly onDownload?: (() => void) | undefined;
}

/** Row 2's one control: what moves this state on, else Check for updates, whose label never changes while it runs. */
function StateAction({ check, automatic, canUpdate, checking, updating, onCheck, onUpdate, onDownload }: StateProps) {
  if (check?.state === "available" && canUpdate) {
    return (
      <button type="button" className="btn primary" disabled={updating} onClick={onUpdate}>
        {updating ? "Closing to update…" : "Update and restart"}
      </button>
    );
  }
  if (check?.state === "newer" && check.restart === true && canUpdate) {
    return (
      <button type="button" className="btn primary" disabled={updating} onClick={onUpdate}>
        {updating ? "Closing to update…" : "Restart to update"}
      </button>
    );
  }
  if (check?.state === "newer" && check.forThisCopy && check.download === undefined && !automatic && onDownload !== undefined) {
    return <button type="button" className="btn outline" onClick={onDownload}>Download</button>;
  }
  return (
    <button type="button" className="btn outline" disabled={checking || updating} onClick={onCheck}>
      Check for updates
    </button>
  );
}

/** Beside the control, on the row's own line: the release page, when the words send the person there. */
function PageLink({ check }: { check: UpdateCheck | null }) {
  const page = check === null ? undefined : linksPage(check);
  return page === undefined ? null : <a className="link" href={page} target="_blank" rel="noreferrer noopener">Open the release page</a>;
}

export interface UpdatesViewProps {
  readonly status: Maybe<UpdateStatus>;
  readonly settings: Maybe<Settings>;
  readonly settingsLocked: boolean;
  readonly checking: boolean;
  readonly canUpdate: boolean;
  readonly updating?: boolean;
  readonly checkErr?: string | null;
  /** The last check's time when the failed Check for updates was clicked: a newer check clears that failure, as in the footer. */
  readonly checkErrSince?: number | null;
  readonly switchErr?: string | null;
  readonly updateErr?: string | null;
  readonly downloadErr?: string | null;
  readonly onCheck: () => void;
  /** An installed copy's Download click. */
  readonly onDownload?: () => void;
  readonly onUpdate: () => void;
  readonly onEveryChange: (on: boolean) => void;
  readonly onAutomatic?: (on: boolean) => void;
}

/** The group itself, from props, so each state renders in a test without a server. */
export function UpdatesView(p: UpdatesViewProps) {
  if (p.status === NA) {
    return (
      <Grp title="Updates">
        <Row label="Version">
          <Na>
            To update, run <span className="mono">pnpm run app-update</span> in the Gates Local folder.
          </Na>
        </Row>
      </Grp>
    );
  }
  const last = p.status?.lastCheck ?? null;
  const settings = p.settings === NA ? undefined : p.settings;
  const every = settings?.updateEveryChange === true;
  // The switch says what this copy follows, so flipping it changes row 1 now, not after the next check.
  const channel: UpdateChannel = every ? "main" : "release";
  // Settings waits for the version before it shows (whenSettingsReady); a placeholder covers a slow server.
  const version = p.status === undefined ? { value: <Skel w="6em" />, desc: <Skel w="14em" /> } : versionText(p.status.version, channel);
  const clone = p.status !== undefined && (p.status.version.kind === "release" || p.status.version.kind === "commit");
  // A clone's check of the other channel says nothing about what the switch follows now, so row 2 waits for a check of this one.
  const check = clone && last !== null && "channel" in last && last.channel !== channel ? null : last;
  const installed = p.status?.version.kind === "installed";
  const canControl = p.status?.canControl !== false;
  const automatic = settings !== undefined && settings.updateAutomatic !== false;
  const canUpdate = p.canUpdate && canControl;
  const restartHere = canUpdate && (check?.state === "available" || (check?.state === "newer" && check.restart === true));
  // A failure takes the grey line's place, so it never adds a line. The newest action's failure wins; a check that answered after a failed click clears it.
  const updateErr = restartHere ? p.updateErr : undefined;
  const checkErr = p.checkErr != null && !outdated({ click: "check", message: p.checkErr, since: p.checkErrSince ?? null }, last) ? p.checkErr : null;
  const err = canControl ? (updateErr ?? p.downloadErr ?? checkErr) : null;
  return (
    <Grp title="Updates" busy={p.status === undefined}>
      <Row label="Version" desc={version.desc}>
        <span className="mono">{version.value}</span>
      </Row>
      {clone || installed ? (
        <>
          <Row label={stateLabel(check, p.checking)} desc={<StateLine text={stateLine(check, canControl, canUpdate)} err={err} calm={!troubled(check)} />} tip={stateTip(check, automatic, installed, canUpdate)}>
            {canControl ? (
              // One line for the link and the control, reserved on a phone, so the link showing never grows the row.
              <span className="upd-acts">
                <PageLink check={check} />
                <StateAction
                  check={check}
                  automatic={automatic}
                  canUpdate={canUpdate}
                  checking={p.checking}
                  updating={p.updating === true}
                  onCheck={p.onCheck}
                  onUpdate={p.onUpdate}
                  onDownload={p.onDownload}
                />
              </span>
            ) : (
              <PageLink check={check} />
            )}
          </Row>
          {settings === undefined || p.settingsLocked || !canControl ? null : (
            <>
            <Row label="Check for updates automatically"
              desc={installed ? "Checks hourly and downloads newer versions; off deletes them." : "Asks this clone's git remote hourly."}
              tip={installed
                ? "Desktop app only: reads the release page's list 15 seconds after startup, then hourly, and downloads a newer version for this copy. Default on. Off stops automatic requests, stops a download in progress and deletes downloaded versions; a check in progress finishes. Manual checks still work."
                : "Desktop app only: asks this clone's git remote 15 seconds after startup, then hourly. Default on. Off prevents future automatic git processes and network requests; a check in progress finishes. Manual checks still work."}
              err={p.switchErr ?? null}>
              <button type="button" className="switch" role="switch" aria-checked={settings.updateAutomatic !== false} aria-label="Check for updates automatically" onClick={() => p.onAutomatic?.(settings.updateAutomatic === false)} />
            </Row>
            {installed ? null : <Row label="Get every change, not only releases" tip="Off: only releases, once there are any. On: every change on the main branch as soon as it lands." err={p.switchErr ?? null}>
              <button type="button" className="switch" role="switch" aria-checked={every} aria-label="Get every change, not only releases" onClick={() => p.onEveryChange(!every)} />
            </Row>}
            </>
          )}
        </>
      ) : null}
    </Grp>
  );
}

export function Updates() {
  const status = useStore((s) => s.update);
  const settings = useStore((s) => s.settings);
  const settingsLocked = useStore((s) => s.unavailable["settings.update"] === true);
  const checking = useStore((s) => s.updateChecking);
  const [checkErr, runCheck] = useAct();
  const [checkErrSince, setCheckErrSince] = useState<number | null>(null);
  const [switchErr, runSwitch] = useAct();
  const [downloadErr, runDownload] = useAct();
  const updateErr = useStore((s) => s.updateError);
  const updating = useStore((s) => s.updateInstalling || (s.update !== NA && s.update?.installing === true));
  return (
    <UpdatesView
      status={status}
      settings={settings}
      settingsLocked={settingsLocked}
      checking={checking}
      canUpdate={canUpdateHere()}
      updating={updating}
      checkErr={checkErr}
      checkErrSince={checkErrSince}
      switchErr={switchErr}
      updateErr={updateErr}
      downloadErr={downloadErr}
      onCheck={() => {
        setCheckErrSince(status === NA ? null : (status?.lastCheck?.checkedAt ?? null));
        void runCheck(checkForUpdates());
      }}
      onDownload={() => void runDownload(downloadUpdate())}
      onEveryChange={(on) => void runSwitch(updateSettings({ updateEveryChange: on }))}
      onAutomatic={(on) => void runSwitch(updateSettings({ updateAutomatic: on }))}
      onUpdate={() => void updateAndRestart()}
    />
  );
}
