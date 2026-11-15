import { methodNames, phoneMay } from "@gates-local/contracts";
import { expect, it } from "vitest";
import { computerOnlyMethods } from "./platform.ts";

it("marks exactly what the method table denies when the page came from the phone listener", () => {
  expect(Object.keys(computerOnlyMethods(true)).toSorted()).toEqual(methodNames.filter((m) => !phoneMay(m)).toSorted());
});

it("marks nothing on the computer, whatever the window's size", () => {
  expect(computerOnlyMethods(false)).toEqual({});
});
