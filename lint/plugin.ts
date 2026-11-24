import classInCss from "./rules/class-in-css.ts";
import closedPackage from "./rules/closed-package.ts";
import commentIsAKind from "./rules/comment-is-a-kind.ts";
import disableNeedsReason from "./rules/disable-needs-reason.ts";
import effectNeedsReason from "./rules/effect-needs-reason.ts";
import noRelativeImportAcrossPackages from "./rules/no-relative-import-across-packages.ts";
import noWaitForTimeout from "./rules/no-wait-for-timeout.ts";
import parentPidIsPassed from "./rules/parent-pid-is-passed.ts";
import testSwitchStaysInTests from "./rules/test-switch-stays-in-tests.ts";
import timerNeedsReason from "./rules/timer-needs-reason.ts";
import turnEndNotPolled from "./rules/turn-end-not-polled.ts";

export default {
  meta: { name: "gates" },
  rules: {
    "class-in-css": classInCss,
    "closed-package": closedPackage,
    "comment-is-a-kind": commentIsAKind,
    "disable-needs-reason": disableNeedsReason,
    "effect-needs-reason": effectNeedsReason,
    "no-relative-import-across-packages": noRelativeImportAcrossPackages,
    "no-wait-for-timeout": noWaitForTimeout,
    "parent-pid-is-passed": parentPidIsPassed,
    "test-switch-stays-in-tests": testSwitchStaysInTests,
    "timer-needs-reason": timerNeedsReason,
    "turn-end-not-polled": turnEndNotPolled,
  },
};
