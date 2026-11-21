import { expect, test } from "vitest";

import { createValidationError } from "../src/errors";
import { zagora } from "../src/index";
import { deepMerge } from "../src/utils";

test("context merging preserves __proto__ as an own data property", () => {
  const override = JSON.parse('{"nested":{"__proto__":{"admin":true}}}');
  const merged = deepMerge({ nested: { retained: true } }, override);

  expect(Object.getPrototypeOf(merged.nested)).toBe(Object.prototype);
  expect(Object.getOwnPropertyDescriptor(merged.nested, "__proto__")?.value).toEqual({
    admin: true,
  });
  expect(merged.nested.retained).toBe(true);
  expect(merged.nested.admin).toBeUndefined();
});

test("validation messages resolve Standard Schema path segments", () => {
  const issues = [
    { message: "Invalid input: expected string", path: [{ key: "users" }, { key: 0 }, "name"] },
  ];
  const error = createValidationError("input", issues);

  expect(error.message).toBe("Input validation failed: users.0.name => expected string");
  expect(error.issues).toBe(issues);
});

test("validation messages support symbol path keys", () => {
  const error = createValidationError("output", [
    { message: "expected string", path: [Symbol("field"), { key: Symbol("nested") }] },
  ]);

  expect(error.message).toBe(
    "Output validation failed: Symbol(field).Symbol(nested) => expected string",
  );
});

test("a non-string thrown error kind becomes an internal error", () => {
  const thrown = { kind: Symbol("failure") };
  const procedure = zagora()
    .errors({
      FAILURE: { "~standard": { version: 1, vendor: "test", validate: (value) => ({ value }) } },
    })
    .handler(() => {
      throw thrown;
    })
    .callable();

  expect(procedure()).toMatchObject({
    ok: false,
    isTypedError: false,
    error: { kind: "UNKNOWN_ERROR", cause: thrown },
  });
});
