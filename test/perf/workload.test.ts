import { expect, test } from "vitest";
import { threadReply } from "../fake-ollama/fake-ollama.ts";
import { parallelPrompt } from "./workload.ts";

test("parallel fixtures keep producing tokens through four switches without slowing their cadence", () => {
  for (const label of ["parallel alpha", "parallel beta"]) {
    const reply = threadReply(parallelPrompt(label));
    expect(reply.startsWith(`Reply 1 for ${label}`)).toBe(true);
    expect(reply.match(/\S+/g)?.length).toBeGreaterThanOrEqual(600);
  }
});
