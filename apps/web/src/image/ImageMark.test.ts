// The image models' mark: a family's short letters in the maker tile.
import { expect, it } from "vitest";
import { ImageMark } from "./ImageMark.tsx";

it.each([["sdxl", "XL"], ["flux", "FX"], ["moss", "MO"], ["zimage", "ZI"]])("the %s family's tile reads %s", (family, letters) => {
  expect(ImageMark({ family }).props.children).toBe(letters);
});
