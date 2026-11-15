import { CHAT_MODELS } from "@gates-local/contracts";
import { describe, expect, it } from "vitest";
import { makerOf, memoryRuler, pickerLabel, pickerLabels } from "./picker-models.ts";

describe("model picker presentation", () => {
  it("keeps single names clean and falls back to a full tag when collision suffixes also match", () => {
    const a = "hf.co/someone/gemma-4-26B-A4B-it-GGUF:Q4_K_M";
    const b = a.replace(":Q4_K_M", ":Q8_0");
    expect(pickerLabels([a]).get(a)).toBe(pickerLabel(a));
    const pair = pickerLabels([a, b]);
    expect(pair.get(a)).toContain("Q4_K_M"); expect(pair.get(b)).toContain("Q8_0");
    const sameSuffix = pickerLabels(["local-a:latest", "local-b:latest"], [{ name: "local-a:latest", label: "Same name" }, { name: "local-b:latest", label: "Same name" }]);
    expect(sameSuffix.get("local-a:latest")).toContain("local-a:latest");
    expect(new Set(sameSuffix.values()).size).toBe(2);
  });
  it("normalizes installed tags without losing a community build's identity", () => {
    const examples = [
      ["gemma4:12b", "Gemma 4 12B"],
      ["gemma3-abliterated:12b-q4", "Gemma 3 12B abliterated"],
      ["gemma4-abliterated:26b", "Gemma 4 26B abliterated"],
      // a Hugging Face copy: its repository's words, its publisher in brackets (no per-name rules)
      ["hf.co/someone/gemma-4-26B-A4B-it-GGUF:Q4_K_M", "Gemma 4 26B A4B it (someone)"],
      ["hf.co/another/Qwen3.8-27B-Instruct-GGUF:IQ3_M", "Qwen3.8 27B Instruct (another)"],
      ["milo-e2b-v3:latest", "Milo E2B v3"],
      ["milo-e4b-v3:latest", "Milo E4B v3"],
      ["milo-e4b-v4:latest", "Milo E4B v4"],
      ["qwen3.5:9b", "Qwen 3.5 9B"],
      ["qwen3.8-abliterated:27b", "Qwen 3.8 27B abliterated"],
      ["qwen2.5-coder:14b", "Qwen 2.5 14B coder"],
      ["phi4:latest", "Phi 4"],
      ["gpt-oss:20b", "gpt-oss 20B"],
    ];
    for (const [tag, label] of examples) expect(pickerLabel(tag ?? "")).toBe(label);
  });
  it("groups raw and hosted variants under a stable maker, including downloads", () => {
    const makers = CHAT_MODELS.makers;
    expect(makerOf("gemma4-abliterated:26b", makers)).toBe("Gemma");
    expect(makerOf("hf.co/person/Qwen3.8-custom-GGUF:Q4_K_M", makers)).toBe("Qwen");
    expect(makerOf("milo-e4b-v4:latest", makers)).toBe("Milo");
    expect(makerOf("mistral-small3.2:24b", makers)).toBe("Mistral");
    expect(makerOf("phi4:latest", makers)).toBe("Phi");
    expect(makerOf("gpt-oss:20b", makers)).toBe("gpt-oss");
    expect(makerOf("an-unknown-local-name:latest", makers)).toBe("Other");
  });
  it("takes its makers from the list the server sends, and names none before it arrives", () => {
    expect(makerOf("newco-7b:latest", [{ name: "Newco", match: "^newco" }])).toBe("Newco");
    expect(makerOf("gemma4:12b", undefined)).toBe("Other");
  });
  it("scales to usable memory, exposes overflow, and keeps a bounded display", () => {
    const fitting = memoryRuler(7.64, 11.56);
    expect(fitting.fill).toBeCloseTo(7.64 / 11.56 * 100);
    expect(fitting.overflow).toBe(0);
    const spill = memoryRuler(14.59, 11.56);
    expect(spill.fill).toBe(100);
    expect(spill.overflow).toBeCloseTo(3.03 / 11.56 * 100);
    expect(spill.continues).toBe(false);
    expect(memoryRuler(32.59, 11.56).continues).toBe(true);
    expect(memoryRuler(32.59, 11.56).overflow).toBeLessThanOrEqual(36);
    expect(memoryRuler(5, 0)).toEqual({ fill: 0, overflow: 36, continues: true });
  });
});
