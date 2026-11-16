/**
 * The guards a test can switch off, each named for what goes wrong without it:
 * - grace-is-the-short-one: the server lets work back in after its short wait while an installed copy's update can still go ahead.
 * - reservation-lets-work-in: a reservation alone does not keep new work out.
 * - commit-leaves-the-window-its-key: the window keeps the key that can call the update off after main took over.
 * - cancel-after-a-good-start: main calls the update off after it started the updater.
 * - deadline-read-once: the updater reads the approval's deadline before its wait and not after.
 * - checkout-start-skips-the-look: a source checkout's start does not read the lock or the saved update.
 * - part-way-copy-not-refused: a copy part way between two versions is not refused.
 * - update-saved-after-the-change: the update is saved only after the command that changes the copy has ended.
 * - go-back-over-edits: going back does not stop for the person's edits, and resets over them.
 * - installed-start-skips-the-look: an installed copy's start does not read the saved update.
 * - program-written-in-place: the new program is written over the old file in place of a rename.
 * - delete-a-folder-in-use: a version folder is deleted without asking whether it is in use.
 * - go-back-drops-the-store: going back deletes the thread store it should move aside.
 * - any-ready-note-counts: a ready note from any launch counts as this one's.
 */
export const BREAKS = [
  "grace-is-the-short-one",
  "reservation-lets-work-in",
  "commit-leaves-the-window-its-key",
  "cancel-after-a-good-start",
  "deadline-read-once",
  "checkout-start-skips-the-look",
  "part-way-copy-not-refused",
  "update-saved-after-the-change",
  "go-back-over-edits",
  "installed-start-skips-the-look",
  "program-written-in-place",
  "delete-a-folder-in-use",
  "go-back-drops-the-store",
  "any-ready-note-counts",
] as const;

export type Break = (typeof BREAKS)[number];

let broken: Break | undefined;

/** Whether this guard is switched off. False in every run that is not a test of it. */
export const brokenForTest = (name: Break): boolean => broken === name;

/** Switches one guard off, or with no name all back on. Only inside the test runner. */
export function breakForTest(name?: Break): void {
  if (process.env["VITEST"] === undefined) throw new Error("breakForTest is for tests only");
  broken = name;
}
