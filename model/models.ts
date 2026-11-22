// What `node scripts/model-check.ts` runs: each model, the settings it must pass under, the past
// bugs it must fail on, and the product files it stands for.
import { leaseTable } from "./gpu/table.ts";
import { replyTable } from "./reply/table.ts";
import { updateTable } from "./update/table.ts";

/** A module the model extends, written from the product code on every run. `read` says what was read, for the output. */
export interface Table { readonly module: string; readonly text: string; readonly read: string }

/** The model's constants with some of them set differently. */
export interface Setting { readonly name: string; readonly set: Readonly<Record<string, string>> }

/**
 * A guard switched off inside the model. The run must FAIL on `fails`. `past` is the commit that
 * fixed the bug in the product; without it the replay is a switch the code itself carries.
 */
export interface Replay extends Setting {
  readonly fails: string;
  readonly bug: string;
  readonly guard: string;
  readonly past?: string;
}

/** A rule that holds only while something outside the app behaves. With `set`, the run must still fail on `fails`. */
export interface Finding extends Setting { readonly fails: string; readonly why: string }

export interface Model {
  /** The folder under model/. */
  readonly name: string;
  readonly spec: string;
  readonly tables: () => Promise<readonly Table[]>;
  /** The constants of the passing run. The bounds are among them and are printed on every run. */
  readonly constants: Readonly<Record<string, string>>;
  /** Other settings the true model must pass under as well. */
  readonly also: readonly Setting[];
  readonly invariants: readonly string[];
  /** Whether a state nothing can leave is an error. */
  readonly deadlock: boolean;
  readonly replays: readonly Replay[];
  readonly findings: readonly Finding[];
  /** Product files the model was written from by hand, and what of each it stands for. covered.json holds their hashes. */
  readonly covered: Readonly<Record<string, string>>;
}

const rule = (name: string, fails: string, bug: string, guard: string, past?: string): Replay =>
  ({ name, set: { Off: `"${name}"` }, fails, bug, guard, ...(past === undefined ? {} : { past }) });

const reply: Model = {
  name: "reply",
  spec: "Reply",
  tables: async () => {
    const t = replyTable();
    return [{ module: "ReplyCode", text: t.module, read: `${t.kinds} kinds of record and ${t.cells} moves from move() in apps/server/src/chat/reply.ts` }];
  },
  constants: { Msgs: "{A, B}", Wins: "{1}", Nobody: "Nobody", MaxTurns: "2", MaxRestarts: "1", Off: '"none"' },
  also: [],
  invariants: [
    "TypeOK", "StopHoldsTheQueue", "ARemovedMessageIsNeverAsked", "AskedOnce", "ARestartHoldsEverything",
    "NothingSavedForAStoppedStart", "EditingIsNeverSent", "AWaitingMessageWasNotAsked", "StartingHasItsWork", "OneReplyAtATime",
  ],
  deadlock: false,
  replays: [
    rule(
      "saveChecksStage", "NothingSavedForAStoppedStart",
      "Stop during a file save lost the hold: the stopped message's question was still stored and asked",
      "stillStarting() in apps/server/src/chat/reply.ts, asked at the moment the question would be stored",
      "960ed105",
    ),
    rule("lateStopHolds", "StopHoldsTheQueue", "a Stop that arrives after the reply's last word lets the queue go on", "move(), the stop call on an ended record, and replies.ts stop()"),
    rule("removeAnswersHonestly", "ARemovedMessageIsNeverAsked", "Remove says done for a message that is already starting", "move(), the remove call"),
    rule("sendChecksSaved", "AWaitingMessageWasNotAsked", "a second Send of a stored question makes a waiting row for it", "move(), the send call with `saved`"),
    rule("restartHolds", "ARestartHoldsEverything", "after a restart a message that was starting goes again by itself", "move(), the restart event"),
    rule("pickSkipsEditing", "EditingIsNeverSent", "a message open in a composer is taken and sent", "move(), the take event, and replies.ts goes()"),
    rule("restartReconciles", "AWaitingMessageWasNotAsked", "after a restart a stored question comes back as waiting", "replies.ts createReplies(), the `saved` event"),
    rule("removalIsRemembered", "ARemovedMessageIsNeverAsked", "a removed message is sent again by a window that had not heard", "replies.ts commit(), which keeps the removed record"),
  ],
  findings: [],
  covered: {
    "apps/server/src/chat/replies.ts": "send(), stop(), now(), hold(), remove(), edit(), pick(), take(), sent(), starting(), started(), refused(), left(), ended(), tell(), apply(), commit(), settle(), goes(), createReplies()",
    "apps/server/src/app/queue-pump.ts": "startNext(), start()",
    "apps/server/src/app/admit.ts": "admitTurn(): append()",
    "apps/server/src/app/drawing.ts": "the same append for a drawing",
    "apps/server/src/app.ts": "byThread, and the turn's end calling replies.left()",
  },
};

const GPU_WORLD = { AbandonedLoadGoesOn: "FALSE", AForeignEngineStaysStuck: "FALSE" };

const gpu: Model = {
  name: "gpu",
  spec: "Gpu",
  tables: async () => {
    const t = await leaseTable();
    return [{ module: "LeaseCode", text: t.module, read: `${t.states} states and ${t.steps} steps of createGpuLease() in apps/server/src/gpu/lease.ts` }];
  },
  constants: { MaxSwitches: "2", ...GPU_WORLD, StuckPictureKeepsLease: "TRUE", RefusedSwitchKeepsRecord: "TRUE" },
  also: [],
  invariants: [
    "TypeOK", "NeverTwoLoadingAtOnce", "ARunningReplysModelStaysLoaded", "NoStaleRecordAfterASwitch",
    "ARefusedSwitchForgetsNothing", "NothingPassesAWaitingPicture", "NoTwoWaitOnEachOther",
  ],
  deadlock: true,
  replays: [
    {
      name: "stuck-picture", set: { StuckPictureKeepsLease: "FALSE" }, fails: "NeverTwoLoadingAtOnce", past: "7cac7552",
      bug: "a picture's Stop timed out, the card was given back, and a chat model loaded beside the picture still loading",
      guard: "heldWhileStuck() in apps/server/src/image/module.ts keeps the lease while the stopped picture is on the card",
    },
    {
      name: "refused-switch", set: { RefusedSwitchKeepsRecord: "FALSE" }, fails: "ARefusedSwitchForgetsNothing", past: "7cac7552",
      bug: "a refused switch of runtime forgot which models the app had loaded, so it never asked them to leave again",
      guard: "runtimeKept() in apps/server/src/runtime/load.ts puts the cleared record back",
    },
  ],
  findings: [
    {
      name: "abandoned-load", set: { AbandonedLoadGoesOn: "TRUE" }, fails: "NeverTwoLoadingAtOnce",
      why: "a reply stopped while its model loads gives back the gate and the lease at once (load.ts end()); the rule holds only if Ollama drops a load whose request was dropped",
    },
    {
      name: "foreign-engine", set: { AForeignEngineStaysStuck: "TRUE" }, fails: "NeverTwoLoadingAtOnce",
      why: "after STUCK_HOLD_MS the lease is given back with a ComfyUI the app did not start still at the stopped picture (image/module.ts heldWhileStuck(), \"limit\"); the app never stops an engine it did not start",
    },
  ],
  covered: {
    "apps/server/src/gpu/gate.ts": "createFifoGate()",
    "apps/server/src/gpu/memory.ts": "handoff(), chatLeaves(), engineLeaves(), stage(), settled(), engineGone()",
    "apps/server/src/runtime/load.ts": "reserve(), admit(), firstToken(), end(), runtimeChanged(), runtimeKept(), runtimeSettled(), unloaded()",
    "apps/server/src/runtime/switch.ts": "setMode(), baseUrl(), stopIfStartedHere()",
    "apps/server/src/runtime/services.ts": "endTurnsForSwitch()",
    "apps/server/src/image/module.ts": "claimed(), fit(), heldWhileStuck()",
    "apps/server/src/image/client.ts": "cancelPrompt() and its wait",
    "apps/server/src/app/admit.ts": "admitTurn(): lease.acquire(), load.admit(), ending()",
    "apps/server/src/app/run-turn.ts": "the calls to load.firstToken() and load.end()",
  },
};

const UPDATE_GUARDS = { AStartFinishesTheUpdateFirst: "TRUE", ServerGraceIsTheDeadline: "TRUE" };

const update: Model = {
  name: "update",
  spec: "Update",
  tables: async () => {
    const t = updateTable();
    return [{
      module: "UpdateCode", text: t.module,
      read: `decideCheckoutStart() in packages/update/src/checkout-start.ts for ${t.starts} starts, and ${t.states} states and ${t.steps} steps of createUpdateAdmission() in packages/update/src/admission.ts`,
    }];
  },
  constants: { Kind: '"checkout"', MaxApprovals: "2", MaxCrashes: "2", MaxStarts: "3", ...UPDATE_GUARDS },
  also: [{ name: "installed", set: { Kind: '"installed"' } }],
  invariants: ["TypeOK", "NoNewWorkOnceApproved", "ALateCancelCannotReopenAdmission", "NoAppRunsOnAHalf", "NothingUnfinishedMeansWhole"],
  deadlock: false,
  replays: [
    {
      name: "start-on-a-half", set: { AStartFinishesTheUpdateFirst: "FALSE" }, fails: "NoAppRunsOnAHalf", past: "69973b02",
      bug: "a copy run from source was started on a half-installed update",
      guard: "decideCheckoutStart() in packages/update/src/checkout-start.ts, asked by startCheckout() before anything runs",
    },
    {
      name: "short-grace", set: { Kind: '"installed"', ServerGraceIsTheDeadline: "FALSE" }, fails: "NoNewWorkOnceApproved", past: "69973b02",
      bug: "an installed copy's server let work back in after 5 s while its updater gave the old app 30 s, so new work was cut off",
      guard: "apps/server/src/update/installed/module.ts commit() passes INSTALLED_APPROVAL_MS, the updater's own deadline, as the wait",
    },
  ],
  findings: [],
  covered: {
    "apps/server/src/update/module.ts": "prepare(), commit(), cancel() for a copy run from source",
    "apps/server/src/update/installed/module.ts": "prepare(), commit(), cancel() for an installed copy",
    "apps/desktop/src/update-launch.ts": "launchApprovedUpdate(), approvedHandoffEnv()",
    "packages/update/src/installed/transaction.ts": "INSTALLED_APPROVAL_MS as the installed deadline",
    "packages/update/src/cli.ts": "the wait for the old app and the deadline read after it",
    "packages/update/src/apply.ts": "transact(), recover(), installAndBuild(), goBack(), changing(), settle()",
    "packages/update/src/startup.ts": "acknowledgeStartup(), reportStartupFailure()",
    "apps/desktop/src/checkout-start.ts": "startCheckout()",
  },
};

export const MODELS: readonly Model[] = [reply, gpu, update];
