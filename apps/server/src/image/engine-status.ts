import type { ImageStatus } from "@gates-local/contracts";

export type StatusWriter = { kind: "read" } | { kind: "job"; jobId: string } | { kind: "fact" };

export type Seen =
  | { state: "off"; nowhere: boolean }
  | { state: "ready"; detail?: string }
  | { state: "starting" | "busy" | "error"; answering: boolean; detail?: string }
  | { state: "stopped" | "missing"; detail?: string };

export interface At {
  baseUrl?: string;
  startedByApp: boolean;
  addressSet?: boolean;
  own?: boolean;
}

export function mayWrite(writer: StatusWriter, queuedOrRunning: number, activeJob: string | undefined): boolean {
  if (writer.kind === "read") return queuedOrRunning === 0;
  if (writer.kind === "job") return activeJob === undefined || activeJob === writer.jobId;
  return true;
}

export function engineStatus(seen: Seen, at: At): ImageStatus {
  const answering = seen.state === "ready" || ("answering" in seen && seen.answering);
  const owner = at.startedByApp ? "app" : answering ? "external" : "none";
  if (seen.state === "off") return { state: "off", owner, ...seen.nowhere ? { nowhere: true } : {} };
  return {
    state: seen.state,
    owner,
    ...at.baseUrl === undefined ? {} : { baseUrl: at.baseUrl },
    ...at.addressSet === true ? { addressSet: true } : {},
    ...at.own === true ? { own: true } : {},
    ...seen.detail === undefined ? {} : { detail: seen.detail },
  };
}
