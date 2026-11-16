import { expect, it } from "vitest";
import { LINUX_LOCK } from "./linux-lock.ts";

const entries = (lock: string) => lock.split(/\n(?=\S)/).filter((e) => /^[A-Za-z0-9_.-]+==/.test(e));
const pin = (lock: string, name: string) => entries(lock).find((e) => e.startsWith(`${name}==`))?.split(" ")[0];

it("names PyPI and PyTorch's cu130 index first, as uv's --emit-index-url wrote them", () => {
  expect(LINUX_LOCK.split("\n").slice(0, 3)).toEqual(["--index-url https://pypi.org/simple", "--extra-index-url https://download.pytorch.org/whl/cu130", ""]);
});

it("pins the 103 packages uv resolved, one entry each", () => {
  const names = entries(LINUX_LOCK).map((e) => e.split("==")[0]);
  expect(names).toHaveLength(103);
  expect(new Set(names).size).toBe(103);
});

it("holds torch and torchvision to the cu130 index's 2.14.1 and 0.29.1", () => {
  expect([pin(LINUX_LOCK, "torch"), pin(LINUX_LOCK, "torchvision")]).toEqual(["torch==2.14.1+cu130", "torchvision==0.29.1+cu130"]);
});
