// One guard of the update code, switched off for the length of one test.
//
// The rules an update keeps (no work starts after the person approved, a
// start never runs a half-installed copy, nothing of the person's is written
// over) each rest on a line of code. A test of such a rule proves little
// until it has been seen to fail with that line gone. So each guard asks
// `brokenForTest` with its own name, and the rule's test runs twice: as it
// is, and with the guard off, where it must fail.
//
// Nothing outside a test can turn a guard off. `breakForTest` is the only
// way to set one and it throws unless the test runner started this process;
// break-for-test.test.ts reads every source file and fails when one that is
// not a test calls it. There is no flag, variable or setting that reaches it.

/** The guards that can be switched off, each named for what goes wrong without it. */
export const BREAKS = [
  /** The server lets work back in after its short wait, while an installed copy's update can still go ahead. */
  "grace-is-the-short-one",
  /** A reservation alone does not keep new work out. */
  "reservation-lets-work-in",
  /** The window keeps the key that can call the update off, after main took over. */
  "commit-leaves-the-window-its-key",
  /** Main calls the update off after it started the updater. */
  "cancel-after-a-good-start",
  /** The updater reads the approval's deadline once, before its wait, and not after. */
  "deadline-read-once",
  /** A source checkout's start does not read the lock or the saved update. */
  "checkout-start-skips-the-look",
  /** A copy part way between two versions is not refused. */
  "part-way-copy-not-refused",
  /** The update is saved only after the command that changes the copy has ended. */
  "update-saved-after-the-change",
  /** Going back does not stop for the person's edits, and resets over them. */
  "go-back-over-edits",
  /** An installed copy's start does not read the saved update. */
  "installed-start-skips-the-look",
  /** The new program is written over the old file, in place of a rename. */
  "program-written-in-place",
  /** A version folder is deleted without asking whether it is in use. */
  "delete-a-folder-in-use",
  /** Going back deletes the thread store it should move aside. */
  "go-back-drops-the-store",
  /** A ready note from any launch counts as this one's. */
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
