import { expect, it } from "vitest";
import { insertTranscript } from "./voice-audio.ts";

it("inserts speech at the cursor without removing either side of an existing draft", () => {
  expect(insertTranscript("before after", 7, "spoken words")).toEqual({ draft: "before spoken words after", cursor: 20 });
  expect(insertTranscript("existing", 0, "hello")).toEqual({ draft: "hello existing", cursor: 6 });
  expect(insertTranscript("", 0, "hello")).toEqual({ draft: "hello", cursor: 5 });
});
