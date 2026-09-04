import { describe, expect, it } from "vite-plus/test";
import { absolute } from "@tunnckocore/calc";

describe("absolute", () => {
  it.each([
    [-7, 7],
    [7, 7],
    [-1.5, 1.5],
    [1.5, 1.5],
    [0, 0],
  ])("returns %s as %s", (value, expected) => expect(absolute(value)).toBe(expected));

  it("converts negative zero to positive zero", () => expect(absolute(-0)).toBe(0));

  it.each([Infinity, -Infinity])("returns positive infinity for %s", (value) => {
    expect(absolute(value)).toBe(Infinity);
  });

  it("preserves NaN", () => expect(absolute(NaN)).toBeNaN());
});
