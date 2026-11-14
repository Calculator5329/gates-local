// Settings-only update controls, deferred with the Settings screen.
//
// Two rows (audit of 0.2.4, decision 25): the version, said once in the label,
// with the state of the last check as its one grey line and the one control
// that moves it on at the right; then the automatic switch. A clone's further
// rows (every change or only releases, what the update brings) fold away
// under the group's chevron. No label, row or value carries a tooltip: what a
// row needs said is on the row.
//
// The desktop server checks the clone's remote after 15 seconds and hourly
// when enabled. Browsers only check on request. Restart to update shows only
// in the desktop app, which quits and lets `pnpm run app-update` do the work.
// The phone listener exposes status only; a computer browser may check but
// installs from the desktop app. An installed copy (AppImage or installer)
// reads the signed release list and downloads a newer version for itself
// (Download while automatic checks are off). A Linux AppImage that can
// replace its own file then shows Restart to update; any other copy keeps
// the checked download and opens its folder, to run it from there
// (decision 24).
import type { Settings, UpdateCheck, UpdateStatus, UpdateVersion } from "@gates-local/contracts";
import { type ReactNode, useState } from "react";
import { Icon } from "./icons.tsx";
import { canShowUpdate, canUpdateHere, checkForUpdates, downloadUpdate, showUpdate, updateAndRestart, updateSettings } from "./session.ts";
import { Grp, Na, Row, Skel, useAct } from "./settings-ui.tsx";
import { type Maybe, NA, useStore } from "./store.ts";
import { ITSELF, RESTART, clock, outdated, retryable, ver } from "./update-state.ts";

/** Subjects shown in the clone's fold before the rest are counted. */
export const SHOWN_CHANGES = 3;

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const changes = (n: number) => (n === 1 ? "1 change" : `${n} changes`);

/** Row 1's label: the commit or version, said once. */
function versionLabel(v: UpdateVersion): ReactNode {
  switch (v.kind) {
    case "release":
      return <>Version <span className="mono">{ver(v.tag)}</span></>;
    case "commit":
      return <>Version <span className="mono">{v.commit}</span></>;
    case "installed":
      return <>Version <span className="mono">{ver(v.version)}</span></>;
    case "not-a-clone":
      return "Version";
    case "unreadable":
      return "Version unknown";
  }
}

/** The clone's fold: which commit this is and when, for the switch that decides what it follows. */
function cloneDetail(v: UpdateVersion): string | undefined {
  if (v.kind === "release") return `Commit ${v.commit}${v.date === undefined ? "" : `, ${day(v.date)}`}.`;
  if (v.kind === "commit") return v.date === undefined ? undefined : `A commit from ${day(v.date)}.`;
  return undefined;
}

/** The release page, when the line sends the person there: a version this copy cannot use, or a check that names one. */
function linksPage(check: UpdateCheck, folder: boolean): string | undefined {
  if (check.state === "cannot-check") return check.page;
  if (check.state !== "newer") return undefined;
  if (!check.forThisCopy) return check.page;
  // A checked download this copy cannot install: its folder, or the page where the desktop app cannot open one.
  return check.download === "ready" && check.restart !== true && !folder ? check.page : undefined;
}

/** A server line as the grey line: one that led into a list ends as a sentence, not on a colon. */
const whole = (line: string) => line.replace(/:$/, ".");

/**
 * Row 1's one grey line: the state of the last check. It never wraps, so no
 * state changes the row's height, except a checked download this copy cannot
 * install, whose line says what to do with it and is never cut off.
 */
function stateLine(check: UpdateCheck | null, checking: boolean, control: boolean, canUpdate: boolean): string {
  if (checking) return "Checking…";
  if (check === null) return control ? "Not checked yet." : "Check and install updates on the computer running Gates Local.";
  switch (check.state) {
    case "up-to-date":
      return `Up to date. Checked at ${clock(check.checkedAt)}.`;
    case "available":
      return canUpdate ? `Update ${ver(check.target)}: ${changes(check.total)}.` : `Update ${ver(check.target)}: run pnpm run app-update on the computer.`;
    case "cannot-check":
      return check.lines[0] === undefined ? (retryable(check.reason) ? "Couldn’t check." : `${ITSELF}.`) : whole(check.lines[0]);
    case "newer": {
      const target = ver(check.target);
      if (!check.forThisCopy) return `Update ${target} is not built for this copy.`;
      if (check.download === undefined) return `Update ${target} available.`;
      if (check.download === "ready" && check.restart === true) return `Update ${target} downloaded and checked.`;
      return check.lines[0] ?? `Update ${target} available.`;
    }
  }
}

/** The grey line, or the last action's failure in its place. */
function StateLine({ text, err, calm, wrap }: { text: string; err: string | null; calm: boolean; wrap: boolean }) {
  if (err !== null) return <span className="src-help act-err" role="alert">{err}</span>;
  return <span className="src-help" role={calm ? "status" : "alert"} style={wrap ? { whiteSpace: "normal" } : undefined}>{text}</span>;
}

/** A check that failed, or a download that did: said as an alert. */
const troubled = (check: UpdateCheck | null) => check?.state === "cannot-check" || (check?.state === "newer" && (check.download === "bad" || check.download === "failed" || check.download === "disk"));

/** A checked download this copy cannot install by itself (decision 24). */
const keptDownload = (check: UpdateCheck | null): check is Extract<UpdateCheck, { state: "newer" }> => check?.state === "newer" && check.forThisCopy && check.download === "ready" && check.restart !== true;

interface StateProps {
  readonly check: UpdateCheck | null;
  readonly automatic: boolean;
  /** Restart to update: the desktop app, with control. */
  readonly canUpdate: boolean;
  /** The desktop app can open a checked download's folder. */
  readonly canShow: boolean;
  readonly checking: boolean;
  readonly updating: boolean;
  readonly onCheck: () => void;
  readonly onUpdate: () => void;
  /** The Download control; absent where this window cannot control updates. */
  readonly onDownload?: (() => void) | undefined;
  readonly onFolder?: (() => void) | undefined;
}

/** Row 1's one control: what moves this state on, else Check for updates, whose label never changes while it runs. */
function StateAction({ check, automatic, canUpdate, canShow, checking, updating, onCheck, onUpdate, onDownload, onFolder }: StateProps) {
  if (check?.state === "available" && canUpdate) {
    return (
      <button type="button" className="btn primary" data-testid="settings.updates.update" disabled={updating} onClick={onUpdate}>
        {updating ? "Closing to update…" : RESTART}
      </button>
    );
  }
  if (check?.state === "newer" && check.restart === true && canUpdate) {
    return (
      <button type="button" className="btn primary" data-testid="settings.updates.restart" disabled={updating} onClick={onUpdate}>
        {updating ? "Closing to update…" : RESTART}
      </button>
    );
  }
  if (keptDownload(check) && canShow && onFolder !== undefined) {
    return <button type="button" className="btn primary" data-testid="settings.updates.folder" onClick={onFolder}>Open folder</button>;
  }
  if (check?.state === "newer" && check.forThisCopy && check.download === undefined && !automatic && onDownload !== undefined) {
    return <button type="button" className="btn outline" data-testid="settings.updates.download" onClick={onDownload}>Download</button>;
  }
  return (
    <button type="button" className="btn outline" data-testid="settings.updates.check" disabled={checking || updating} onClick={onCheck}>
      Check for updates
    </button>
  );
}

/** Beside the control, on the row's own line: the release page, when the line sends the person there. */
function PageLink({ check, folder }: { check: UpdateCheck | null; folder: boolean }) {
  const page = check === null ? undefined : linksPage(check, folder);
  return page === undefined ? null : <a className="link" href={page} data-testid="settings.updates.release-page" target="_blank" rel="noreferrer noopener">Release page</a>;
}

/** The clone's fold, under the Every change switch: what the update brings, its release notes or its commits. */
function ChangeList({ check }: { check: Extract<UpdateCheck, { state: "available" }> }) {
  const notes = check.notes?.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const items = notes ?? check.changes;
  const more = (notes === undefined ? check.total : items.length) - Math.min(items.length, SHOWN_CHANGES);
  return (
    <ul className="d" data-testid="settings.updates.changes">
      {items.slice(0, SHOWN_CHANGES).map((c) => <li key={c}>{c}</li>)}
      {more > 0 ? <li>{`and ${more} more`}</li> : null}
    </ul>
  );
}

export interface UpdatesViewProps {
  readonly status: Maybe<UpdateStatus>;
  readonly settings: Maybe<Settings>;
  readonly settingsLocked: boolean;
  readonly checking: boolean;
  readonly canUpdate: boolean;
  /** The desktop app can open a checked download's folder (canShowUpdate). */
  readonly canShow?: boolean;
  readonly updating?: boolean;
  readonly checkErr?: string | null;
  /** The last check's time when the failed Check for updates was clicked: a newer check clears that failure, as in the footer. */
  readonly checkErrSince?: number | null;
  readonly switchErr?: string | null;
  readonly updateErr?: string | null;
  readonly downloadErr?: string | null;
  /** The same for a failed Download: a newer check, or the server saying it downloads, clears it. */
  readonly downloadErrSince?: number | null;
  readonly folderErr?: string | null;
  /** The clone's fold starts open (a test renders it). */
  readonly open?: boolean;
  readonly onCheck: () => void;
  /** An installed copy's Download click. */
  readonly onDownload?: () => void;
  readonly onFolder?: () => void;
  readonly onUpdate: () => void;
  readonly onEveryChange: (on: boolean) => void;
  readonly onAutomatic?: (on: boolean) => void;
}

/** The group itself, from props, so each state renders in a test without a server. */
export function UpdatesView(p: UpdatesViewProps) {
  const [open, setOpen] = useState(p.open === true);
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
  const check = p.status?.lastCheck ?? null;
  const settings = p.settings === NA ? undefined : p.settings;
  const every = settings?.updateEveryChange === true;
  const kind = p.status?.version.kind;
  const clone = kind === "release" || kind === "commit";
  const installed = kind === "installed";
  const canControl = p.status?.canControl !== false;
  const automatic = settings !== undefined && settings.updateAutomatic !== false;
  const canUpdate = p.canUpdate && canControl;
  const canShow = p.canShow === true && canControl;
  const restartHere = canUpdate && (check?.state === "available" || (check?.state === "newer" && check.restart === true));
  // A failure takes the grey line's place, so it never adds a line. The newest action's failure wins; a check that answered after a failed click clears it.
  const updateErr = restartHere ? p.updateErr : undefined;
  const checkErr = p.checkErr != null && !outdated({ click: "check", message: p.checkErr, since: p.checkErrSince ?? null }, check) ? p.checkErr : null;
  const downloadErr = p.downloadErr != null && !outdated({ click: "download", message: p.downloadErr, since: p.downloadErrSince ?? null }, check) ? p.downloadErr : null;
  const folderErr = keptDownload(check) ? (p.folderErr ?? null) : null;
  const err = canControl ? (updateErr ?? folderErr ?? downloadErr ?? checkErr) : null;
  const switches = settings !== undefined && !p.settingsLocked && canControl;
  const detail = p.status === undefined ? undefined : cloneDetail(p.status.version);
  const fold = clone && switches;
  // Settings waits for the version before it shows (whenSettingsReady); a placeholder covers a slow server.
  const label = p.status === undefined ? <>Version <Skel w="4em" /></> : versionLabel(p.status.version);
  const desc =
    p.status === undefined ? <Skel w="14em" />
    : kind === "not-a-clone" ? "Can't update: not a git clone."
    : kind === "unreadable" && p.status.version.kind === "unreadable" ? `Could not read the version: ${p.status.version.detail}.`
    : <StateLine text={stateLine(check, p.checking, canControl, canUpdate)} err={err} calm={!troubled(check)} wrap={keptDownload(check)} />;
  const more = fold ? (
    <button type="button" className="ibtn" data-testid="settings.updates.more" aria-expanded={open} aria-label="More" data-tip="More" onClick={() => setOpen(!open)}>
      <Icon id={open ? "down" : "right"} />
    </button>
  ) : undefined;
  return (
    <Grp title="Updates" busy={p.status === undefined} {...(more === undefined ? {} : { action: more })}>
      <Row label={label} desc={desc}>
        {(clone || installed) && canControl ? (
          // One line for the link and the control, reserved on a phone, so the link showing never grows the row.
          <span className="upd-acts">
            <PageLink check={check} folder={canShow} />
            <StateAction
              check={check}
              automatic={automatic}
              canUpdate={canUpdate}
              canShow={canShow}
              checking={p.checking}
              updating={p.updating === true}
              onCheck={p.onCheck}
              onUpdate={p.onUpdate}
              onDownload={p.onDownload}
              onFolder={p.onFolder}
            />
          </span>
        ) : null}
      </Row>
      {(clone || installed) && switches ? (
        <Row label="Check for updates automatically" desc={installed ? "Checks hourly and downloads newer versions." : "Asks this clone's git remote hourly."} err={p.switchErr ?? null}>
          <button type="button" className="switch" role="switch" data-testid="settings.updates.automatic" aria-checked={automatic} aria-label="Check for updates automatically" onClick={() => p.onAutomatic?.(!automatic)} />
        </Row>
      ) : null}
      {fold && open ? (
        <>
          <Row label="Get every change, not only releases" {...(detail === undefined ? {} : { desc: detail })} err={p.switchErr ?? null}>
            <button type="button" className="switch" role="switch" data-testid="settings.updates.every-change" aria-checked={every} aria-label="Get every change, not only releases" onClick={() => p.onEveryChange(!every)} />
          </Row>
          {check?.state === "available" ? (
            <Row label={check.notes === undefined ? `What ${ver(check.target)} brings: ${changes(check.total)}` : `What ${ver(check.target)} brings`} desc={<ChangeList check={check} />} />
          ) : null}
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
  const [downloadErrSince, setDownloadErrSince] = useState<number | null>(null);
  const [folderErr, runFolder] = useAct();
  const updateErr = useStore((s) => s.updateError);
  const updating = useStore((s) => s.updateInstalling || (s.update !== NA && s.update?.installing === true));
  const target = status === NA || status?.lastCheck?.state !== "newer" ? undefined : status.lastCheck.target;
  return (
    <UpdatesView
      status={status}
      settings={settings}
      settingsLocked={settingsLocked}
      checking={checking}
      canUpdate={canUpdateHere()}
      canShow={canShowUpdate()}
      updating={updating}
      checkErr={checkErr}
      checkErrSince={checkErrSince}
      switchErr={switchErr}
      updateErr={updateErr}
      downloadErr={downloadErr}
      downloadErrSince={downloadErrSince}
      folderErr={folderErr}
      onCheck={() => {
        setCheckErrSince(status === NA ? null : (status?.lastCheck?.checkedAt ?? null));
        void runCheck(checkForUpdates());
      }}
      onDownload={() => {
        setDownloadErrSince(status === NA ? null : (status?.lastCheck?.checkedAt ?? null));
        void runDownload(downloadUpdate());
      }}
      onFolder={() => {
        if (target !== undefined) void runFolder(showUpdate(target));
      }}
      onEveryChange={(on) => void runSwitch(updateSettings({ updateEveryChange: on }))}
      onAutomatic={(on) => void runSwitch(updateSettings({ updateAutomatic: on }))}
      onUpdate={() => void updateAndRestart()}
    />
  );
}
