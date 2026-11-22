import { expect, expectTypeOf, test } from "vitest";
import { z } from "zod";

import { zagora } from "../src/index";

const noHandlerError = {
  kind: "UNKNOWN_ERROR",
  message: "No handler set: call .handler() before .callable()",
  cause: undefined,
  stack: undefined,
};

test("a builder without a handler has no callable", () => {
  const memory = new Map();
  const cache = {
    has: (key: string) => memory.has(key),
    get: (key: string) => memory.get(key),
    set: (key: string, value: unknown) => {
      memory.set(key, value);
    },
  };

  // @ts-expect-error a handler is required before callable
  zagora().callable();
  // @ts-expect-error a handler is required before callable
  zagora().input(z.string()).callable();
  // @ts-expect-error a handler is required before callable
  zagora().output(z.string()).callable();
  // @ts-expect-error a handler is required before callable
  zagora()
    .errors({ NOT_FOUND: z.object({ id: z.string() }) })
    .callable();
  // @ts-expect-error a handler is required before callable
  zagora().context({ userId: "1" }).callable();
  // @ts-expect-error a handler is required before callable
  zagora()
    .env(z.object({ API_KEY: z.string() }))
    .callable();
  // @ts-expect-error a handler is required before callable
  zagora().cache(cache).callable();
});

test("a builder with a handler has callable", () => {
  const builder = zagora()
    .input(z.string())
    .handler((_, name) => name);

  expectTypeOf(builder).toHaveProperty("callable");
  expect(builder.callable()("hi")).toEqual({ ok: true, data: "hi", error: undefined });
});

test("a handler-less procedure returns the no-handler error on the sync path", () => {
  const contract = zagora().input(z.string()).output(z.string());
  const fn = (contract as any).callable();

  expect(() => fn("hi")).not.toThrow();
  expect(fn("hi")).toEqual({ ok: false, isTypedError: false, error: noHandlerError });
});

test("a handler-less procedure returns the no-handler error on the async path", async () => {
  const contract = zagora().input(z.string().refine(async () => true));
  const fn = (contract as any).callable();

  const result = fn("hi");
  expect(result).toBeInstanceOf(Promise);
  expect(await result).toEqual({ ok: false, isTypedError: false, error: noHandlerError });
});
