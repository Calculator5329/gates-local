import { expect, it } from "vitest";
import { updateFixtureState } from "./update-fixture.ts";

it("AU-04 announcing an update persists the same available status through confirmation and cancellation", () => {
  const fixture = updateFixtureState();
  expect(fixture.status().lastCheck).toBeNull();
  const announced = fixture.show();
  expect(fixture.status()).toEqual(announced);
  fixture.work(["1 running reply"]);
  expect(fixture.status().lastCheck).toEqual(announced.lastCheck);
  expect(fixture.status().activity).toEqual(["1 running reply"]);
});
