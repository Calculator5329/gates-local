import closedPackage from "./rules/closed-package.ts";
import disableNeedsReason from "./rules/disable-needs-reason.ts";
import effectNeedsReason from "./rules/effect-needs-reason.ts";
import noRelativeImportAcrossPackages from "./rules/no-relative-import-across-packages.ts";
import noWaitForTimeout from "./rules/no-wait-for-timeout.ts";
import timerNeedsReason from "./rules/timer-needs-reason.ts";

export default {
  meta: { name: "gates" },
  rules: {
    "closed-package": closedPackage,
    "disable-needs-reason": disableNeedsReason,
    "effect-needs-reason": effectNeedsReason,
    "no-relative-import-across-packages": noRelativeImportAcrossPackages,
    "no-wait-for-timeout": noWaitForTimeout,
    "timer-needs-reason": timerNeedsReason,
  },
};
