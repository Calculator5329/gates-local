// Settings › General › Updates, and the one-time note after an update.
//
// Nothing here checks on its own: the version comes from update.status
// (read from the .git folder at hydrate), and only the Check for updates
// button calls update.check, which asks the clone's git remote. Update and
// restart shows only in the desktop app, which quits and lets
// `pnpm run app-update` do the work; phones and browsers see the version and
// the check.
import { useState } from "react";
import type { Settings, UpdateCheck, UpdateResult, UpdateStatus, UpdateVersion } from "@gates-local/contracts";
import { Icon } from "./icons.tsx";
import { type ActionResult, canUpdateHere, checkForUpdates, dismissUpdateResult, updateAndRestart, updateSettings } from "./session.ts";
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
  }
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
  const check = p.status?.lastCheck ?? null;
  const settings = p.settings === NA ? undefined : p.settings;
  const every = settings?.updateEveryChange === true;
  return (
    <Grp title="Updates">
      <Row label="Version" desc={version.desc}>
        <span className="mono">{version.value}</span>
      </Row>
      {clone ? (
        <>
          <Row label="Check for updates" desc="Only when you click. It asks the git remote this copy was cloned from; nothing is downloaded until you update." err={p.checkErr ?? null}>
            <button type="button" className="btn outline" disabled={p.checking} onClick={p.onCheck}>
              {p.checking ? (
                <>
                  <Icon id="spin" cls="spin" /> Checking…
                </>
              ) : (
                "Check for updates"
              )}
            </button>
          </Row>
          {check !== null && !p.checking ? (
            <CheckResult check={check} canUpdate={p.canUpdate} onUpdate={p.onUpdate} updateErr={p.updateErr ?? null} updating={p.updating === true} />
          ) : null}
          {settings === undefined || p.settingsLocked ? null : (
            <Row label="Get every change, not only releases" desc="Off: only releases, once there are any. On: every change on the main branch as soon as it lands." err={p.switchErr ?? null}>
              <button type="button" className="switch" role="switch" aria-checked={every} aria-label="Get every change, not only releases" onClick={() => p.onEveryChange(!every)} />
            </Row>
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
  const [updateErr, runUpdate] = useAct();
  const [updating, setUpdating] = useState(false);
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
      onUpdate={() => {
        setUpdating(true);
        void runUpdate(
          updateAndRestart().then((r: ActionResult) => {
            // On success the app is quitting; the button stays in its closing state.
            if (r !== null) setUpdating(false);
            return r;
          }),
        );
      }}
    />
  );
}

/** The one-time note after an update: shown on the first start after it, until dismissed. */
export function UpdateNoteView({ result, onDismiss }: { result: UpdateResult; onDismiss: () => void }) {
  const ok = result.outcome === "updated";
  return (
    <div className="banner" role={ok ? "status" : "alert"}>
      <Icon id={ok ? "checkc" : "alert"} cls={ok ? undefined : "warn"} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="bt">{ok ? "Gates Local updated" : "The update did not finish"}</div>
        <div className="bm">{result.line}</div>
        {result.commands !== undefined && result.commands.length > 0 ? (
          <div className="bm upd-lines mono">
            {result.commands.map((c, i) => (
              <div key={i}>{c}</div>
            ))}
          </div>
        ) : null}
        {!ok && result.logPath !== undefined ? (
          <div className="bm">
            The full log is in <span className="mono">{result.logPath}</span>.
          </div>
        ) : null}
        <div className="ba">
          <button type="button" className="btn outline" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

export function UpdateNote() {
  const result = useStore((s) => (s.update === undefined || s.update === NA ? null : s.update.result));
  return result === null ? null : <UpdateNoteView result={result} onDismiss={() => void dismissUpdateResult()} />;
}
