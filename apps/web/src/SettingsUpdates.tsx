// Settings-only update controls, deferred with the Settings screen.
//
// The desktop server checks the clone's remote after 15 seconds and hourly
// when enabled. Browsers only check on request. Update and
// restart shows only in the desktop app, which quits and lets
// `pnpm run app-update` do the work. The phone listener exposes status only;
// a computer browser may check but installs from the desktop app. An
// installed copy (AppImage or installer) only reads the signed release list
// and points at the release page; it never shows an install control.
import type { Settings, UpdateCheck, UpdateStatus, UpdateVersion } from "@gates-local/contracts";
import { Icon } from "./icons.tsx";
import { canUpdateHere, checkForUpdates, updateAndRestart, updateSettings } from "./session.ts";
import { Fail, Grp, Na, Row, useAct } from "./settings-ui.tsx";
import { type Maybe, NA, useStore } from "./store.ts";

/** Subjects shown before the rest fold away under "Show all". */
export const SHOWN_CHANGES = 3;

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const changes = (n: number) => (n === 1 ? "1 change" : `${n} changes`);

function versionText(v: UpdateVersion): { value: string; desc: string } {
  switch (v.kind) {
    case "release":
      return { value: v.tag, desc: `Commit ${v.commit}${v.date === undefined ? "" : `, ${day(v.date)}`}.` };
    case "commit":
      return { value: v.commit, desc: v.date === undefined ? "A commit between releases." : `A commit from ${day(v.date)}, between releases.` };
    case "not-a-clone":
      return { value: "Not a git clone", desc: "This copy was not downloaded with git clone, so it cannot check for updates or update itself." };
    case "unreadable":
      return { value: "Unknown", desc: `Could not read the version: ${v.detail}.` };
    case "installed":
      return { value: `Installed copy ${v.version}`, desc: "Updates come from the Gates Local release page." };
  }
}

const AGAIN = "Gates Local will try again in an hour.";

/** An installed copy only reads the signed release list: the server's own
 *  words, a release-page link when they send the person there, and never an
 *  install control. A failed read promises a retry only while automatic
 *  checks are on now, so the sentence follows the switch, not the check. */
function InstalledResult({ check, automatic }: { check: UpdateCheck; automatic: boolean }) {
  if (check.state === "up-to-date") {
    return (
      <div className="upd-res" role="status">
        <b>No newer version was found.</b> Checked at {clock(check.checkedAt)}.
      </div>
    );
  }
  if (check.state === "available") return null;
  const retries = automatic && check.state === "cannot-check" && (check.reason === "unreachable" || check.reason === "no-list");
  const [first, ...rest] = retries ? [...check.lines, AGAIN] : check.lines;
  return (
    <div className="upd-res" role={check.state === "newer" ? "status" : "alert"}>
      {first === undefined ? null : <b>{first}</b>}
      {rest.length > 0 ? (
        <div className="upd-lines">
          {rest.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      ) : null}
      {check.page === undefined ? null : (
        <div className="upd-act">
          <a className="link" href={check.page} target="_blank" rel="noreferrer noopener">Open the release page</a>
        </div>
      )}
      <div className="upd-when">{check.state === "newer" ? "Checked" : "Tried"} at {clock(check.checkedAt)}.</div>
    </div>
  );
}

const channelText = (c: "main" | "release") => (c === "release" ? "Following releases." : "Following every change on the main branch.");

function CheckResult({ check, canUpdate, onUpdate, updateErr, updating }: { check: UpdateCheck; canUpdate: boolean; onUpdate: () => void; updateErr: string | null; updating: boolean }) {
  switch (check.state) {
    case "up-to-date":
      return (
        <div className="upd-res" role="status">
          <b>Up to date</b> ({check.current}). {channelText(check.channel)} Checked at {clock(check.checkedAt)}.
        </div>
      );
    case "cannot-check":
      return (
        <div className="upd-res" role="alert">
          <b>Could not check for updates.</b>
          <div className="upd-lines">
            {check.lines.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
          <div className="upd-when">Tried at {clock(check.checkedAt)}.</div>
        </div>
      );
    case "newer":
      // Only an installed copy answers "newer"; UpdatesView renders it there.
      return <InstalledResult check={check} automatic={false} />;
    case "available": {
      const notes = check.notes?.split("\n").filter((l) => l.trim() !== "");
      const items = notes ?? check.changes;
      const more = notes === undefined ? check.total - check.changes.length : 0;
      return (
        <div className="upd-res" role="status">
          <b>
            {changes(check.total)} from {check.current} to {check.target}
          </b>
          . {channelText(check.channel)} Checked at {clock(check.checkedAt)}.
          <ul className="upd-list">
            {items.slice(0, SHOWN_CHANGES).map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
          {items.length > SHOWN_CHANGES || more > 0 ? (
            <details className="upd-more">
              <summary>Show all {notes === undefined ? changes(check.total) : "release notes"}</summary>
              <ul className="upd-list">
                {items.slice(SHOWN_CHANGES).map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
              {more > 0 ? <div className="upd-when">…and {more} more.</div> : null}
            </details>
          ) : null}
          {canUpdate ? (
            <div className="upd-act">
              <button type="button" className="btn primary" disabled={updating} onClick={onUpdate}>
                {updating ? "Closing to update…" : "Update and restart"}
              </button>
              <span className="d">Gates Local closes, updates and opens again. If a step fails it goes back to {check.current}.</span>
              <Fail err={updateErr} />
            </div>
          ) : (
            <div className="upd-when">
              To install it, close Gates Local on the computer it runs on and run <span className="mono">pnpm run app-update</span> in its folder.
            </div>
          )}
        </div>
      );
    }
  }
}

export interface UpdatesViewProps {
  readonly status: Maybe<UpdateStatus>;
  readonly settings: Maybe<Settings>;
  readonly settingsLocked: boolean;
  readonly checking: boolean;
  readonly canUpdate: boolean;
  readonly updating?: boolean;
  readonly checkErr?: string | null;
  readonly switchErr?: string | null;
  readonly updateErr?: string | null;
  readonly onCheck: () => void;
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
  const version = p.status === undefined ? { value: "…", desc: "Reading the version." } : versionText(p.status.version);
  const clone = p.status !== undefined && (p.status.version.kind === "release" || p.status.version.kind === "commit");
  const installed = p.status?.version.kind === "installed";
  const check = p.status?.lastCheck ?? null;
  const settings = p.settings === NA ? undefined : p.settings;
  const every = settings?.updateEveryChange === true;
  const canControl = p.status?.canControl !== false;
  return (
    <Grp title="Updates">
      <Row label="Version" desc={version.desc}>
        <span className="mono">{version.value}</span>
      </Row>
      {clone || installed ? (
        <>
          {canControl ? <Row label="Check for updates" desc={installed ? "Reads the signed list of versions on the Gates Local release page. Nothing is downloaded or installed." : "Asks the git remote this copy was cloned from. Git fetches commit and tag data; dependencies install only when you choose to update."} err={p.checkErr ?? null}>
            <button type="button" className="btn outline" disabled={p.checking || p.updating} onClick={p.onCheck}>
              {p.checking ? (
                <>
                  <Icon id="spin" cls="spin" /> Checking…
                </>
              ) : (
                "Check for updates"
              )}
            </button>
          </Row> : <Row label="Updates" desc="Check and install updates on the computer running Gates Local." />}
          {check === null || p.checking ? null : installed ? (
            <InstalledResult check={check} automatic={settings !== undefined && settings.updateAutomatic !== false} />
          ) : (
            <CheckResult check={check} canUpdate={p.canUpdate && canControl} onUpdate={p.onUpdate} updateErr={p.updateErr ?? null} updating={p.updating === true} />
          )}
          {settings === undefined || p.settingsLocked || !canControl ? null : (
            <>
            <Row label="Check for updates automatically" desc={installed ? "Desktop app only: reads the release page's list 15 seconds after startup, then hourly. Default on. Off stops automatic requests; a check in progress finishes. Manual checks still work." : "Desktop app only: asks this clone's git remote 15 seconds after startup, then hourly. Default on. Off prevents future automatic git processes and network requests; a check in progress finishes. Manual checks still work."} err={p.switchErr ?? null}>
              <button type="button" className="switch" role="switch" aria-checked={settings.updateAutomatic !== false} aria-label="Check for updates automatically" onClick={() => p.onAutomatic?.(settings.updateAutomatic === false)} />
            </Row>
            {installed ? null : <Row label="Get every change, not only releases" desc="Off: only releases, once there are any. On: every change on the main branch as soon as it lands." err={p.switchErr ?? null}>
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
  const [switchErr, runSwitch] = useAct();
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
      switchErr={switchErr}
      updateErr={updateErr}
      onCheck={() => void runCheck(checkForUpdates())}
      onEveryChange={(on) => void runSwitch(updateSettings({ updateEveryChange: on }))}
      onAutomatic={(on) => void runSwitch(updateSettings({ updateAutomatic: on }))}
      onUpdate={() => void updateAndRestart()}
    />
  );
}

