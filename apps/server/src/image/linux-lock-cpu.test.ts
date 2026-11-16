import { expect, it } from "vitest";
import { CUDA_ONLY, LINUX_LOCK_CPU } from "./linux-lock-cpu.ts";

const names = (lock: string) => lock.split(/\n(?=\S)/).filter((e) => /^[A-Za-z0-9_.-]+==/.test(e)).map((e) => e.split("==")[0]);

it("pins 84 packages: the cu130 lock's 103 less its 19 CUDA-only ones", () => {
  expect(CUDA_ONLY).toHaveLength(19);
  expect(names(LINUX_LOCK_CPU)).toHaveLength(84);
  expect(new Set(names(LINUX_LOCK_CPU)).size).toBe(84);
});
