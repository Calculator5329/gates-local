import type { RuntimeStatus } from "@gates-local/contracts";

type InstallSize = Pick<NonNullable<RuntimeStatus["install"]>, "receivedBytes" | "totalBytes" | "stalled">;

export function stalledNow(i: InstallSize | undefined): boolean {
  return i?.stalled === true && i.receivedBytes < i.totalBytes;
}
