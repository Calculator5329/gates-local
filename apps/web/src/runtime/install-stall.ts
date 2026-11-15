// The engine download's stall, as the server says it: one reading for the first window, the banner,
// the footer gear and Settings › Runtime, so no two of them say different things at one moment.
import type { RuntimeStatus } from "@gates-local/contracts";

type InstallSize = Pick<NonNullable<RuntimeStatus["install"]>, "receivedBytes" | "totalBytes" | "stalled">;

/**
 * A download (not the unpack) the server marked stalled: no new bytes for its own bound, after
 * which the speed and time left leave the status and a Retry starts the download again. The
 * window keeps no clock of its own, so it never offers a Retry the server would not act on.
 */
export function stalledNow(i: InstallSize | undefined): boolean {
  return i?.stalled === true && i.receivedBytes < i.totalBytes;
}
