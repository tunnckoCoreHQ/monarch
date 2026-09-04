import { describe, expect, it } from "vite-plus/test";
import { add, subtract, multiply, divide, modulo, power, squareRoot } from "@tunnckocore/calc";

describe("add", () => {
  it.each([
    [2, 3, 5],
    [-2, -3, -5],
    [-2, 3, 1],
    [3, -2, 1],
    [1.25, 2.5, 3.75],
    [0, 7, 7],
    [7, 0, 7],
    [7, -7, 0],
    [-0, -0, -0],
    [-0, 0, 0],
    [Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER],
    [Number.MAX_VALUE, Number.MAX_VALUE, Infinity],
    [Infinity, 3, Infinity],
    [-Infinity, 3, -Infinity],
    [Infinity, -Infinity, NaN],
    [NaN, 1, NaN],
    [1, NaN, NaN],
  ])("add(%s, %s) returns %s", (left, right, expected) => {
    expect(add(left, right)).toBe(expected);
  });

  it("uses floating-point arithmetic for decimal sums", () => {
    expect(add(0.1, 0.2)).toBeCloseTo(0.3);
  });
});

describe("subtract", () => {
  it.each([
    [7, 3, 4],
    [3, 7, -4],
    [-7, -3, -4],
    [-7, 3, -10],
    [7, -3, 10],
    [2.5, 1.25, 1.25],
    [0, 7, -7],
    [7, 0, 7],
    [7, 7, 0],
    [-0, 0, -0],
    [0, -0, 0],
    [-0, -0, 0],
    [Number.MAX_SAFE_INTEGER, 1, 9007199254740990],
    [-Number.MAX_VALUE, Number.MAX_VALUE, -Infinity],
    [Infinity, 1, Infinity],
    [1, Infinity, -Infinity],
    [Infinity, Infinity, NaN],
    [NaN, 1, NaN],
    [1, NaN, NaN],
  ])("subtract(%s, %s) returns %s", (left, right, expected) => {
    expect(subtract(left, right)).toBe(expected);
  });
});

describe("multiply", () => {
  it.each([
    [3, 4, 12],
    [-3, 4, -12],
    [3, -4, -12],
    [-3, -4, 12],
    [1.5, 2.5, 3.75],
    [7, 1, 7],
    [1, 7, 7],
    [7, 0, 0],
    [0, 7, 0],
    [-7, 0, -0],
    [7, -0, -0],
    [-7, -0, 0],
    [Number.MAX_VALUE, 2, Infinity],
    [Number.MIN_VALUE, 0.5, 0],
    [-Number.MIN_VALUE, 0.5, -0],
    [Infinity, -2, -Infinity],
    [-Infinity, -2, Infinity],
    [Infinity, 0, NaN],
    [NaN, 1, NaN],
    [1, NaN, NaN],
  ])("multiply(%s, %s) returns %s", (left, right, expected) => {
    expect(multiply(left, right)).toBe(expected);
  });
});

describe("divide", () => {
  it.each([
    [12, 3, 4],
    [3, 12, 0.25],
    [-12, 3, -4],
    [12, -3, -4],
    [-12, -3, 4],
    [1.5, 0.5, 3],
    [7, 1, 7],
    [0, 7, 0],
    [0, -7, -0],
    [-0, -7, 0],
    [7, 0, Infinity],
    [-7, 0, -Infinity],
    [7, -0, -Infinity],
    [-7, -0, Infinity],
    [0, 0, NaN],
    [0, -0, NaN],
    [Infinity, Infinity, NaN],
    [Infinity, -2, -Infinity],
    [2, Infinity, 0],
    [2, -Infinity, -0],
    [Number.MIN_VALUE, 2, 0],
    [Number.MAX_VALUE, 0.5, Infinity],
    [NaN, 1, NaN],
    [1, NaN, NaN],
  ])("divide(%s, %s) returns %s", (left, right, expected) => {
    expect(divide(left, right)).toBe(expected);
  });

  it("returns a floating-point quotient for non-exact division", () => {
    expect(divide(1, 3)).toBeCloseTo(0.3333333333333333);
  });
});

describe("modulo", () => {
  it.each([
    [7, 3, 1],
    [-7, 3, -1],
    [7, -3, 1],
    [-7, -3, -1],
    [3, 7, 3],
    [5.5, 2, 1.5],
    [7, 0.5, 0],
    [6, 3, 0],
    [-6, 3, -0],
    [0, 3, 0],
    [-0, 3, -0],
    [7, 0, NaN],
    [7, -0, NaN],
    [0, 0, NaN],
    [7, Infinity, 7],
    [-7, Infinity, -7],
    [7, -Infinity, 7],
    [Infinity, 3, NaN],
    [-Infinity, 3, NaN],
    [Infinity, Infinity, NaN],
    [NaN, 1, NaN],
    [1, NaN, NaN],
  ])("modulo(%s, %s) returns %s", (left, right, expected) => {
    expect(modulo(left, right)).toBe(expected);
  });
});

describe("power", () => {
  it.each([
    [2, 3, 8],
    [3, 2, 9],
    [-2, 3, -8],
    [-2, 2, 4],
    [2, -3, 0.125],
    [4, 0.5, 2],
    [0.5, 2, 0.25],
    [-4, 0.5, NaN],
    [7, 0, 1],
    [0, 0, 1],
    [NaN, 0, 1],
    [1, 7, 1],
    [0, 3, 0],
    [-0, 3, -0],
    [-0, 2, 0],
    [0, -1, Infinity],
    [-0, -1, -Infinity],
    [-0, -2, Infinity],
    [Infinity, 2, Infinity],
    [-Infinity, 3, -Infinity],
    [-Infinity, 2, Infinity],
    [Infinity, -1, 0],
    [-Infinity, -1, -0],
    [Infinity, 0, 1],
    [2, Infinity, Infinity],
    [2, -Infinity, 0],
    [0.5, Infinity, 0],
    [0.5, -Infinity, Infinity],
    [1, Infinity, NaN],
    [-1, Infinity, NaN],
    [Number.MAX_VALUE, 2, Infinity],
    [Number.MIN_VALUE, 2, 0],
    [NaN, 1, NaN],
    [1, NaN, NaN],
  ])("power(%s, %s) returns %s", (base, exponent, expected) => {
    expect(power(base, exponent)).toBe(expected);
  });
});

describe("squareRoot", () => {
  it.each([
    [0, 0],
    [-0, -0],
    [1, 1],
    [4, 2],
    [9, 3],
    [0.25, 0.5],
    [-1, NaN],
    [-0.25, NaN],
    [Infinity, Infinity],
    [-Infinity, NaN],
    [NaN, NaN],
  ])("squareRoot(%s) returns %s", (value, expected) => {
    expect(squareRoot(value)).toBe(expected);
  });

  it("returns an approximate root for a non-square", () => {
    expect(squareRoot(2)).toBeCloseTo(1.4142135623730951);
  });

  it.each([Number.MIN_VALUE, Number.MAX_VALUE])(
    "keeps the root of %s positive and finite",
    (value) => {
      const result = squareRoot(value);
      expect(result).toBeGreaterThan(0);
      expect(Number.isFinite(result)).toBe(true);
    },
  );
});
