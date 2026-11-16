import { describe, expect, it } from "vitest";
import { engineStatus, mayWrite, type StatusWriter } from "./engine-status.ts";

const READ: StatusWriter = { kind: "read" };
const JOB_A: StatusWriter = { kind: "job", jobId: "a" };
const FACT: StatusWriter = { kind: "fact" };
const URL = "http://127.0.0.1:8188";

describe("who may set the picture engine's status", () => {
  it.each([
    ["a read with no picture queued or running", READ, 0, undefined, true],
    ["a read while a picture waits for the card", READ, 1, undefined, false],
    ["a read while a picture runs", READ, 1, "a", false],
    ["a job before any job holds the card", JOB_A, 1, undefined, true],
    ["the job that holds the card", JOB_A, 2, "a", true],
    ["a job while another job holds the card", JOB_A, 2, "b", false],
    ["a fact while a picture runs", FACT, 1, "b", true],
  ] as const)("%s: %s", (_name, writer, jobs, activeJob, may) => {
    expect(mayWrite(writer, jobs, activeJob)).toBe(may);
  });
});

describe("the owner the status names", () => {
  it.each([
    ["an engine the app started, even while it is not answering", { state: "stopped" } as const, true, "app"],
    ["an answering engine the app did not start", { state: "ready" } as const, false, "external"],
    ["a busy engine not yet found", { state: "busy", answering: false } as const, false, "none"],
    ["a busy engine that answers", { state: "busy", answering: true } as const, false, "external"],
    ["a unit another program is starting", { state: "starting", answering: true } as const, false, "external"],
    ["a unit the app is about to start", { state: "starting", answering: false } as const, false, "none"],
    ["an error from an engine that still runs a stuck prompt", { state: "error", answering: true } as const, false, "external"],
    ["nothing at the address", { state: "missing" } as const, false, "none"],
  ])("%s", (_name, seen, startedByApp, owner) => {
    expect(engineStatus(seen, { baseUrl: URL, startedByApp }).owner).toBe(owner);
  });

  it("off names no address and says when there is no engine anywhere", () => {
    expect(engineStatus({ state: "off", nowhere: true }, { startedByApp: false })).toEqual({ state: "off", owner: "none", nowhere: true });
    expect(engineStatus({ state: "off", nowhere: false }, { startedByApp: true })).toEqual({ state: "off", owner: "app" });
  });

  it("every state with an address carries the address marks and the detail", () => {
    expect(engineStatus({ state: "missing", detail: "No ComfyUI answers." }, { baseUrl: URL, startedByApp: false, addressSet: true }))
      .toEqual({ state: "missing", owner: "none", baseUrl: URL, addressSet: true, detail: "No ComfyUI answers." });
    expect(engineStatus({ state: "ready" }, { baseUrl: URL, startedByApp: true, own: true }))
      .toEqual({ state: "ready", owner: "app", baseUrl: URL, own: true });
  });
});
