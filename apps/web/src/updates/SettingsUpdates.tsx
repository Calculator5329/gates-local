import type { Settings, UpdateCheck, UpdateStatus, UpdateVersion } from "@gates-local/contracts";
import { type ReactNode, useState } from "react";
import { Icon } from "../lib/ui/icons.tsx";
import { canShowUpdate, canUpdateHere, checkForUpdates, downloadUpdate, showUpdate, updateAndRestart, updateSettings } from "../lib/session/index.ts";
import { Grp, Na, Row, Skel, useAct } from "../lib/ui/settings-ui.tsx";
import { type Maybe, NA, useStore } from "../lib/store/store.ts";
import { ITSELF, RESTART, clock, outdated, retryable, ver } from "./update-state.ts";

export const SHOWN_CHANGES = 3;

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const changes = (n: number) => (n === 1 ? "1 change" : `${n} changes`);

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

function cloneDetail(v: UpdateVersion): string | undefined {
  if (v.kind === "release") return `Commit ${v.commit}${v.date === undefined ? "" : `, ${day(v.date)}`}.`;
  if (v.kind === "commit") return v.date === undefined ? undefined : `A commit from ${day(v.date)}.`;
  return undefined;
}

function linksPage(check: UpdateCheck, folder: boolean): string | undefined {
  if (check.state === "cannot-check") return check.page;
  if (check.state !== "newer") return undefined;
  if (!check.forThisCopy) return check.page;
  return check.download === "ready" && check.restart === undefined && !folder ? check.page : undefined;
}

const whole = (line: string) => line.replace(/:$/, ".");

function stateLine(check: UpdateCheck | null, checking: boolean, control: boolean, canUpdate: boolean): string {
  if (checking || restartComing(check)) return "Checking…";
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
      return check.lines[0] ?? `Update ${target} available.`;
    }
  }
}

function StateLine({ text, err, calm, kept }: { text: string; err: string | null; calm: boolean; kept: string | null }) {
  const shown = err ?? text;
  const className = err === null ? "src-help" : "src-help act-err";
  const role = err === null && calm ? "status" : "alert";
  if (kept === null) return <span className={className} role={role}>{shown}</span>;
  if (shown === kept) return <span className={className} role={role} style={{ whiteSpace: "normal" }}>{shown}</span>;
  return (
    <span className={className} role={role} style={{ display: "grid" }}>
      <span style={{ gridArea: "1 / 1" }}>{shown}</span>
      <span aria-hidden="true" style={{ gridArea: "1 / 1", whiteSpace: "normal", visibility: "hidden" }}>{kept}</span>
    </span>
  );
}

const troubled = (check: UpdateCheck | null) => check?.state === "cannot-check" || (check?.state === "newer" && (check.download === "bad" || check.download === "failed" || check.download === "disk"));

const keptDownload = (check: UpdateCheck | null): check is Extract<UpdateCheck, { state: "newer" }> => check?.state === "newer" && check.forThisCopy && check.download === "ready" && check.restart === undefined;
const restartComing = (check: UpdateCheck | null) => check?.state === "newer" && check.download === "ready" && check.restart === false;

interface StateProps {
  readonly check: UpdateCheck | null;
  readonly automatic: boolean;
  readonly canUpdate: boolean;
  readonly canShow: boolean;
  readonly checking: boolean;
  readonly updating: boolean;
  readonly onCheck: () => void;
  readonly onUpdate: () => void;
  readonly onDownload?: (() => void) | undefined;
  readonly onFolder?: (() => void) | undefined;
}

function StateAction({ check, automatic, canUpdate, canShow, checking, updating, onCheck, onUpdate, onDownload, onFolder }: StateProps) {
  if (check?.state === "available" && canUpdate) {
    return (
      <button type="button" className="btn primary" data-testid="settings.updates.update" disabled={updating} onClick={onUpdate}>
        {updating ? "Closing to update…" : RESTART}
      </button>
    );
  }
  if (check?.state === "newer" && check.restart !== undefined && canUpdate) {
    return (
      <button type="button" className="btn primary" data-testid="settings.updates.restart" disabled={updating || check.restart === false} onClick={onUpdate}>
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

function PageLink({ check, folder }: { check: UpdateCheck | null; folder: boolean }) {
  const page = check === null ? undefined : linksPage(check, folder);
  return page === undefined ? null : <a className="link" href={page} data-testid="settings.updates.release-page" target="_blank" rel="noreferrer noopener">Release page</a>;
}

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
  readonly canShow?: boolean;
  readonly updating?: boolean;
  readonly checkErr?: string | null;
  readonly checkErrSince?: number | null;
  readonly switchErr?: string | null;
  readonly updateErr?: string | null;
  readonly downloadErr?: string | null;
  readonly downloadErrSince?: number | null;
  readonly folderErr?: string | null;
  readonly open?: boolean;
  readonly onCheck: () => void;
  readonly onDownload?: () => void;
  readonly onFolder?: () => void;
  readonly onUpdate: () => void;
  readonly onEveryChange: (on: boolean) => void;
  readonly onAutomatic?: (on: boolean) => void;
}

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
  const updateErr = restartHere ? p.updateErr : undefined;
  const checkErr = p.checkErr != null && !outdated({ click: "check", message: p.checkErr, since: p.checkErrSince ?? null }, check) ? p.checkErr : null;
  const downloadErr = p.downloadErr != null && !outdated({ click: "download", message: p.downloadErr, since: p.downloadErrSince ?? null }, check) ? p.downloadErr : null;
  const folderErr = keptDownload(check) ? (p.folderErr ?? null) : null;
  const err = canControl ? (updateErr ?? folderErr ?? downloadErr ?? checkErr) : null;
  const switches = settings !== undefined && !p.settingsLocked && canControl;
  const detail = p.status === undefined ? undefined : cloneDetail(p.status.version);
  const fold = clone && switches;
  const label = p.status === undefined ? <>Version <Skel w="4em" /></> : versionLabel(p.status.version);
  const desc =
    p.status === undefined ? <Skel w="14em" />
    : kind === "not-a-clone" ? "This copy can't update itself. Install Gates Local from its release page to get updates."
    : kind === "unreadable" && p.status.version.kind === "unreadable" ? `Could not read the version: ${p.status.version.detail}.`
    : <StateLine text={stateLine(check, p.checking, canControl, canUpdate)} err={err} calm={!troubled(check)} kept={keptDownload(check) ? stateLine(check, false, canControl, canUpdate) : null} />;
  const more = fold ? (
    <button type="button" className="ibtn" data-testid="settings.updates.more" aria-expanded={open} aria-label="More" data-tip="More" onClick={() => setOpen(!open)}>
      <Icon id={open ? "down" : "right"} />
    </button>
  ) : undefined;
  return (
    <Grp title="Updates" busy={p.status === undefined} {...(more === undefined ? {} : { action: more })}>
      <Row label={label} desc={desc}>
        {(clone || installed) && canControl ? (
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
