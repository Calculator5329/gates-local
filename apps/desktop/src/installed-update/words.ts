// What the person reads about an installed copy's update: section 8 of
// docs/design/installed-updates.md, word for word, as functions of the values
// each sentence shows. words.test.ts reads the design and compares.
//
// `link` means the sentence is followed by a link to the release page.
// `detail` is the second line under a title ("Restart to update" — "...").

export interface Words {
  readonly text: string;
  readonly detail?: string;
  readonly link?: true;
}

/** Why a replace or a go-back stopped part way: the two returned errors the design names. */
export type PauseCause = { readonly kind: "disk" } | { readonly kind: "permission"; readonly path: string };

const say = (text: string): Words => ({ text });
const withLink = (text: string): Words => ({ text, link: true });
const retry = (automatic: boolean, sentence: string): string => automatic ? ` ${sentence}` : "";

export const versionRow = (version: string): Words => ({ text: `Installed copy ${version}`, detail: "Updates come from the Gates Local release page." });
export const noKey = (): Words => withLink("This build has no release key, so it cannot check for updates. Download the latest version from the release page.");
export const noneFound = (): Words => say("No newer version was found.");
export const available = (version: string): Words => say(`Version ${version} is available.`);
export const nothingForThisCopy = (version: string): Words => withLink(`Version ${version} is available, but this copy cannot install it by itself. Download it from the release page.`);
export const couldNotCheck = (automatic: boolean): Words => say(`Could not reach the update server. Check your connection.${retry(automatic, "Gates Local will try again in an hour.")}`);
export const notFound404 = (automatic: boolean): Words => say(`No release list was found on the release page.${retry(automatic, "Gates Local will try again in an hour.")}`);
export const badSignature = (): Words => withLink("The release list did not pass its signature check, so Gates Local ignored it. Nothing was downloaded. If this keeps happening, download the latest version from the release page.");
export const downloading = (version: string, doneMb: number, totalMb: number): Words => say(`Downloading version ${version} (${doneMb} of ${totalMb} MB). You can keep chatting.`);
export const badDownload = (version: string, automatic: boolean): Words =>
  say(`The download of version ${version} did not match the signed release list, so it was deleted.${retry(automatic, "Use Check for updates to try again.")}`);
export const disk = (volume: string, version: string, needMb: number, freeMb: number): Words =>
  say(`Not enough free space on ${volume} for version ${version} (needs ${needMb} MB, ${freeMb} MB free). Free some space, then use Check for updates.`);
export const readyLinux = (): Words => ({ text: "Restart to update", detail: "Gates Local will close, update and reopen." });
export const readyWindows = (version: string, goBack: { readonly installer: string } | { readonly current: string; readonly releasePage: string }): Words => ({
  text: "Restart to update",
  detail: `If version ${version} does not start, Gates Local will not go back by itself. To go back, ${"installer" in goBack ? `run ${goBack.installer}.` : `download version ${goBack.current} from ${goBack.releasePage}.`}`,
});

const CANNOT_REPLACE = {
  "read-only": "because its folder is read-only",
  "no-permission": "because you do not have permission to change its folder",
  "not-appimage": "because it was not started from an AppImage file",
} as const;
export type CannotReplace = keyof typeof CANNOT_REPLACE;
export const cannotReplace = (reason: CannotReplace, version: string): Words =>
  withLink(`Gates Local cannot replace its own file ${CANNOT_REPLACE[reason]}. Download version ${version} from the release page and replace the file yourself.`);
export const pinnedDataFolder = (version: string): Words =>
  withLink(`This copy keeps its data in a folder set by GATES_LOCAL_DATA_DIR, so it cannot update itself. Download version ${version} from the release page.`);

export const updateStartup = (): Words => say("Gates Local is finishing an update.");
export const watcherDied = (): Words => say("Close Gates Local and start it again to finish the update.");
export const secondLaunch = (): Words => say("Gates Local is updating. It will reopen by itself.");
export const otherCopy = (programPath: string): Words => say(`Another Gates Local copy at ${programPath} is in the middle of an update. Start that copy to finish it.`);
export const updated = (version: string): Words => say(`Updated to version ${version}.`);
export const rolledBack = (newVersion: string, oldVersion: string): Words =>
  say(`Version ${newVersion} did not start, so Gates Local went back to ${oldVersion}. Your chats are as they were when you clicked Restart.`);
export const stuck = (version: string): Words =>
  say(`Gates Local could not confirm that version ${version} stopped. Restart your computer and start Gates Local; it will finish going back.`);

/** A `permission` cause also covers a read-only volume (EROFS), so the clause names neither. */
const because = (cause: PauseCause): string => cause.kind === "disk" ? "the disk is full" : `it cannot change ${cause.path}`;
const CARRY_ON = "Nothing was deleted. Fix that, then start Gates Local again; it will carry on from where it stopped.";
export const replacePaused = (cause: PauseCause): Words => say(`Gates Local could not finish replacing its program file because ${because(cause)}. ${CARRY_ON}`);
export const goBackPaused = (oldVersion: string, cause: PauseCause): Words => say(`Gates Local could not finish going back to version ${oldVersion} because ${because(cause)}. ${CARRY_ON}`);

export const rollbackFailedStoreCopy = (o: { readonly newVersion: string; readonly oldVersion: string; readonly storeCopy: string; readonly previous: string; readonly dataFolder: string }): Words =>
  withLink(`Version ${o.newVersion} did not start, and Gates Local could not go back to ${o.oldVersion}, because the copy of your chats made before the update was not found at ${o.storeCopy}. Nothing was moved. Version ${o.oldVersion} is saved at ${o.previous}, but it cannot open chats that version ${o.newVersion} has already upgraded. Your chats are in ${o.dataFolder}. Start Gates Local to try version ${o.newVersion} again, or download it again from the release page.`);
export const rollbackFailedOldDidNotStart = (o: { readonly newVersion: string; readonly oldVersion: string; readonly path: string; readonly dataFolder: string; readonly aside: string }): Words =>
  withLink(`Version ${o.newVersion} did not start. Gates Local put version ${o.oldVersion} back at ${o.path} and restored your chats, but version ${o.oldVersion} did not start either. Your chats are in ${o.dataFolder}; the files version ${o.newVersion} left are in ${o.aside}. Start Gates Local again. If it still does not start, download version ${o.oldVersion} from the release page and replace ${o.path}.`);
/** B3: the path holds the new version and nothing at `.previous-<id>` is the old one; `saved` says whether anything is there. */
export const rollbackFailedSavedOld = (o: { readonly newVersion: string; readonly oldVersion: string; readonly previous: string; readonly saved: "missing" | "not-old"; readonly path: string; readonly dataFolder: string }): Words =>
  withLink(`Version ${o.newVersion} did not start, and Gates Local could not go back to ${o.oldVersion}, because the file it saved at ${o.previous} ${o.saved === "missing" ? "is missing" : `is not version ${o.oldVersion}`}. Version ${o.newVersion} is still at ${o.path}. Your chats are in ${o.dataFolder}. Download version ${o.oldVersion} from the release page and put it at ${o.path}.`);
export const earlierFailure = (): Words => say("An earlier update did not finish. Read that note and dismiss it before updating again.");
/** A version kept on disk, at a path whose bytes match it. */
export interface Saved { readonly version: string; readonly path: string }
/** The unknown-file page names only the saved versions that are there: both, one, or none. */
export function unknownFile(programPath: string, old: Saved | null, next: Saved | null): Words {
  const found = `Gates Local found a file it did not put at ${programPath}, so it changed nothing.`;
  if (old !== null && next !== null) {
    return withLink(`${found} Version ${old.version} is saved at ${old.path} and version ${next.version} at ${next.path}. Put either one at ${programPath}, or download it from the release page.`);
  }
  const one = old ?? next;
  if (one !== null) return withLink(`${found} Version ${one.version} is saved at ${one.path}. Put it at ${programPath}, or download a version from the release page.`);
  return withLink(`${found} Download Gates Local from the release page and put it at ${programPath}.`);
}
export const didNotClose = (): Words => say("The update did not start because Gates Local did not close in time. Nothing was changed. Try Restart to update again.");
/** Gates Local closed, but the update was not started in time after the click (a slow start, or a restart of the computer). */
export const startedTooLate = (): Words => say("The update did not start in time after Gates Local closed. Nothing was changed. Try Restart to update again.");
export const couldNotStartUpdate = (file: string): Words =>
  say(`Gates Local could not start the update because it cannot change ${file}. Nothing was changed. Fix that, then try Restart to update again.`);
export const cleanupPending = (folder: string): Words =>
  say(`Gates Local could not remove files left by the last update in ${folder}. Check that folder's permissions, then try Restart to update again.`);
export const transactionUnreadable = (file: string): Words =>
  say(`Gates Local cannot read its update record at ${file}, so it changed nothing and did not start. Move that file somewhere else, then start Gates Local again.`);
export const windowsDidNotFinish = (version: string, installer: string): Words =>
  withLink(`The update to version ${version} did not finish. Run ${installer} or download version ${version} from the release page to finish or repair it.`);
