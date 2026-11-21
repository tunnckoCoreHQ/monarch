// SPDX-License-Identifier: Apache-2.0

import * as v from "valibot";
import { expect, expectTypeOf, test } from "vitest";
import { z } from "zod";

import { isDefinedError, isInternalError, isValidationError } from "../src/errors";
import { zagora } from "../src/index";

const errorSchemas = {
  NETWORK_ERROR: z.object({
    message: z.string(),
    statusCode: z.number().int().min(400).max(599).default(409),
    retryAfter: z.number().optional(),
  }),
  AUTH_ERR: z.object({
    message: z.string(),
    field: z.string(),
  }),
};

test("typed error returns exact object with isDefined=true", () => {
  const fn = zagora()
    .input(z.string())
    .output(z.string())
    .errors(errorSchemas)
    .handler(({ errors }, input) => {
      if (input === "fail") {
        throw errors.NETWORK_ERROR({
          message: "Connection failed",
          statusCode: 503,
        });
      }
      return input;
    })
    .callable();

  const success = fn("hello");
  if (success.ok) {
    expect(success.data).toBe("hello");
  } else {
    expect(false, "Expected success for hello").toBe(true);
  }

  const res = fn("fail");
  if (res.error && res.error.kind === "NETWORK_ERROR") {
    expect(res.error.statusCode).toBe(503);
  } else {
    expect(false, "Expected internal error").toBe(true);
  }
});

test("context method works", () => {
  const fn = zagora()
    .context({ db: "mock" })
    .input(z.number())
    .output(z.string())
    .handler(({ context }, input) => {
      expectTypeOf(input).toEqualTypeOf<number>();
      expectTypeOf(context).toEqualTypeOf<{ db: string }>();

      return `${input}-${context.db}`;
    })
    .callable();

  const res = fn(1001);
  if (res.ok) {
    expect(res.data).toBe("1001-mock");
  } else {
    expect(false, "Expected success").toBe(true);
  }
});

test("context override in callable", () => {
  const fn = zagora()
    .context({ db: "default" })
    .input(z.string())
    .output(z.string())
    .handler(({ context }, input) => `${input}-${context.db}`)
    .callable({ context: { db: "override" } });

  const res = fn("baz");
  if (res.ok) {
    expect(res.data).toBe("baz-override");
  } else {
    expect(false, "Expected success").toBe(true);
  }
});

test("untyped error wrapped in ZagoraError with isDefined=false", () => {
  const fn = zagora()
    .input(z.string())
    .output(z.string())
    .handler((_, input) => {
      if (input === "crash") {
        throw new Error("Something broke");
      }
      return input;
    })
    .callable();

  const res = fn("crash");
  if (!res.ok && isInternalError(res.error)) {
    expect(res.error.cause).toBeInstanceOf(Error);
    expect((res.error.cause as Error).message).toBe("Something broke");
  } else {
    expect(false, "Expected internal error").toBe(true);
  }
});

test("multiple typed errors discriminated union", () => {
  const fn = zagora()
    .input(z.string())
    .output(z.string())
    .errors(errorSchemas)
    .handler(({ errors }, input) => {
      if (input === "net") {
        throw errors.NETWORK_ERROR({ message: "Failed", statusCode: 500 });
      }
      if (input === "val") {
        throw errors.AUTH_ERR({ message: "Bad", field: "email" });
      }
      return input;
    })
    .callable();

  const netRes = fn("net");
  if (!netRes.ok && isDefinedError(netRes.error)) {
    expect(netRes.error.kind).toBe("NETWORK_ERROR");
  } else {
    expect(false, "Expected NETWORK_ERROR").toBe(true);
  }

  const valRes = fn("val");
  if (!valRes.ok && isDefinedError(valRes.error)) {
    expect(valRes.error.kind).toBe("AUTH_ERR");
  } else {
    expect(false, "Expected success").toBe(true);
  }
});

test("async input schema", async () => {
  const asyncSchema = z.string().refine(async (val) => val.length > 2, "Min 3 chars");

  const fn = zagora()
    .input(asyncSchema)
    .output(z.string())
    .handler((_, input) => {
      expectTypeOf(input).toEqualTypeOf<string>();

      return input.toUpperCase();
    })
    .callable();

  const res = await fn("ab");
  expect(res.ok).toBe(false);
});

test("async output schema", async () => {
  const asyncSchema = z.string().refine(async (val) => val !== "bad", "Bad value");

  const fn = zagora()
    .input(z.string())
    .output(asyncSchema)
    .handler((_, input) => input)
    .callable();

  const res = await fn("bad");
  expect(res.ok).toBe(false);
});

test("Valibot async schemas always return promises", async () => {
  const asyncOutput = v.pipeAsync(
    v.string(),
    v.checkAsync(async (value) => value !== "bad"),
  );
  const outputProcedure = zagora()
    .input(v.string())
    .output(asyncOutput)
    .handler((_, input) => input)
    .callable();

  const invalidInputResult = outputProcedure(123 as any);
  expect(invalidInputResult).toBeInstanceOf(Promise);
  expect((await invalidInputResult).ok).toBe(false);

  const invalidOutputResult = outputProcedure("bad");
  expect(invalidOutputResult).toBeInstanceOf(Promise);
  expect((await invalidOutputResult).ok).toBe(false);

  const asyncError = v.pipeAsync(
    v.object({ message: v.string() }),
    v.checkAsync(async () => true),
  );
  const errorProcedure = zagora()
    .input(v.string())
    .errors({ ASYNC_ERROR: asyncError })
    .handler(({ errors }, input) => {
      if (input === "fail") {
        throw errors.ASYNC_ERROR({ message: "failed" });
      }
      return input;
    })
    .callable();

  const successResult = errorProcedure("success");
  expect(successResult).toBeInstanceOf(Promise);
  expect((await successResult).ok).toBe(true);

  const failedErrorResult = errorProcedure("fail");
  expect(failedErrorResult).toBeInstanceOf(Promise);
  expect((await failedErrorResult).ok).toBe(false);
});

test("union-typed Valibot schemas preserve runtime return shape", async () => {
  const syncSchema = v.string();
  const asyncSchema = v.pipeAsync(
    v.string(),
    v.checkAsync(async () => true),
  );
  const createProcedure = (schema: typeof syncSchema | typeof asyncSchema) =>
    zagora()
      .input(schema)
      .handler((_, input) => input)
      .callable();

  const syncResult = createProcedure(syncSchema)("sync");
  expect(syncResult).not.toBeInstanceOf(Promise);
  expect((await syncResult).ok).toBe(true);

  const asyncResult = createProcedure(asyncSchema)("async");
  expect(asyncResult).toBeInstanceOf(Promise);
  expect((await asyncResult).ok).toBe(true);
});

test("handleError with async schema validation", async () => {
  const asyncErrorSchema = z.object({
    message: z.string().refine(async (val) => val.length < 500, "Message too long"),
  });

  const fn = zagora()
    .input(z.string())
    .output(z.string())
    .errors({ ASYNC_ERROR: asyncErrorSchema })
    .handler(({ errors }, input) => {
      if (input === "fail") {
        throw errors.ASYNC_ERROR({ message: "a".repeat(600) });
      }
      return input;
    })
    .callable();

  const res = await fn("fail");
  expect(res.ok).toBe(false);
});

test("async handler typed error", async () => {
  const fn = zagora()
    .input(z.string())
    .output(z.string())
    .errors(errorSchemas)
    .handler(async ({ errors }, input) => {
      if (input === "fail") {
        throw errors.NETWORK_ERROR({ message: "Timeout", statusCode: 408 });
      }
      return input;
    })
    .callable();

  const res = await fn("fail");
  if (!res.ok && isDefinedError(res.error) && res.error.kind === "NETWORK_ERROR") {
    expect(res.error.statusCode).toBe(408);
  } else {
    expect(false, "Expected NETWORK_ERROR in async").toBe(true);
  }
});

test("async handler regular untyped error thrown", async () => {
  const fn = zagora()
    .input(z.string())
    .output(z.string())
    .handler(async (_, input) => {
      if (input === "fail") {
        throw new Error("Some custom err thrown from async handler");
      }
      return input;
    })
    .callable();

  const res = await fn("fail");
  if (!res.ok && isInternalError(res.error)) {
    expect(res.error.cause).toBeInstanceOf(Error);
    expect((res.error.cause as Error).message).toBe("Some custom err thrown from async handler");
  } else {
    expect(false, "Expected internal error from async").toBe(true);
  }
});

test("Error.cause is set on wrapped errors", () => {
  const originalError = new Error("Original message");

  const fn = zagora()
    .input(z.string())
    .output(z.string())
    .handler((_, input) => {
      expectTypeOf(input).toEqualTypeOf<string>();
      if (input === "fail") {
        throw originalError;
      }
      return input;
    })
    .callable();

  const res = fn("fail");
  if (!res.ok && isInternalError(res.error)) {
    expect(res.error.cause).toBe(originalError);
    expect(res.error.message).toBe("Sync handler threw unknown error");
    expect((res.error.cause as Error).message).toBe("Original message");
  } else {
    expect(false, "Expected internal error with cause").toBe(true);
  }
});

test("input schema array of string should work", () => {
  const fn = zagora()
    .input(z.array(z.string()))
    .output(z.array(z.string()))
    .handler((_, input) => {
      expectTypeOf(input).toEqualTypeOf<string[]>();

      return input.map((x) => {
        expectTypeOf(x).toEqualTypeOf<string>();

        return x.toUpperCase();
      });
    })
    .callable();

  const res = fn(["foo", "bar"]);

  if (res.ok) {
    expect(res.data).toStrictEqual(["FOO", "BAR"]);
  } else {
    expect(false, "Expected success").toBe(true);
  }
});

test("input validation failure", () => {
  const fn = zagora()
    .input(z.string())
    .output(z.string())
    .handler((_, input) => input)
    .callable();

  const res = fn(123 as any);
  expect(res.ok).toBe(false);
});

test("output validation failure", () => {
  const fn = zagora()
    .input(z.string())
    .output(z.number())
    .handler((_, input) => input)
    .callable();

  const res = fn("foo");
  expect(res.ok).toBe(false);
  expect(res.error?.kind).toBe("VALIDATION_ERROR");
  expect(res.error?.message).toContain("Output validation failed");
});

test("no error schema works", () => {
  const fn = zagora()
    .input(z.string())
    .output(z.string())
    .handler((_, input) => {
      expectTypeOf(input).toEqualTypeOf<string>();

      if (input === "fail") {
        throw new Error("Untyped");
      }
      return input;
    })
    .callable();

  const res = fn("fail");
  expect(res.ok).toBe(false);
  expect(isInternalError(res.error)).toBe(true);
});

test("tuple input arguments", () => {
  const fn = zagora()
    .input(z.tuple([z.string(), z.number()]))
    .output(z.string())
    .handler((_, str, num) => {
      expectTypeOf(str).toEqualTypeOf<string>();
      expectTypeOf(num).toEqualTypeOf<number>();

      return `${str}-${num}`;
    })
    .callable();

  const res = fn("hello", 42);
  if (res.ok) {
    expect(res.data).toBe("hello-42");
  } else {
    expect(false, "Expected success").toBe(true);
  }
});

test("thrown ZagoraError passed through", () => {
  const customErr = { kind: "CUSTOM_ERROR", message: "qux" };

  const fn = zagora()
    .input(z.string())
    .output(z.string())
    .handler((_, input) => {
      expectTypeOf(input).toEqualTypeOf<string>();

      if (input === "throw now") {
        throw customErr;
      }
      return input;
    })
    .callable();

  const res = fn("throw now");
  if (!res.ok && isInternalError(res.error)) {
    expect(res.error.cause).toEqual(customErr);
  } else {
    expect(false, "Expected internal error").toBe(true);
  }
});

test("multiple procedures (calculator) from single instance (autoCallable:true)", () => {
  const za = zagora({ autoCallable: true, disableOptions: true });

  const add = za.input(z.tuple([z.number(), z.number()])).handler((a, b) => {
    expectTypeOf({ a, b }).toEqualTypeOf<{
      a: number;
      b: number;
    }>();

    return a + b;
  });

  const subtract = za.input(z.tuple([z.number(), z.number()])).handler((a, b) => a - b);

  const multiply = za.input(z.tuple([z.number(), z.number()])).handler((a, b) => a * b);

  const divide = za.input(z.tuple([z.number(), z.number()])).handler((a, b) => a / b);

  const added = add(1, 2);
  if (added.ok) {
    expectTypeOf(added.data).toEqualTypeOf<number>();
    expect(added.data).toBe(3);
  } else if (added.error) {
    expectTypeOf(added.error).not.toBeUndefined();
    expectTypeOf(added.error.kind).not.toBeUndefined();
    expect(false, "added should be ok").toBe(true);
  }

  const subtracted = subtract(10, 5);
  if (subtracted.ok) {
    expectTypeOf(subtracted.data).toEqualTypeOf<number>();
    expect(subtracted.data).toBe(5);
  } else if (subtracted.error) {
    expectTypeOf(subtracted.error).not.toBeUndefined();
    expectTypeOf(subtracted.error.kind).not.toBeUndefined();
    expect(false, "subtracted should be ok").toBe(true);
  }

  const multiplied = multiply(2, 3);
  if (multiplied.ok) {
    expectTypeOf(multiplied.data).toEqualTypeOf<number>();
    expect(multiplied.data).toBe(6);
  } else if (multiplied.error) {
    expectTypeOf(multiplied.error).not.toBeUndefined();
    expectTypeOf(multiplied.error.kind).not.toBeUndefined();
    expect(false, "multiplied should be ok").toBe(true);
  }

  const divided = divide(10, 2);
  if (divided.ok) {
    expectTypeOf(divided.data).toEqualTypeOf<number>();
    expect(divided.data).toBe(5);
  } else if (divided.error) {
    expectTypeOf(divided.error).not.toBeUndefined();
    expectTypeOf(divided.error.kind).not.toBeUndefined();
    expect(false, "divide should be ok").toBe(true);
  }
});

test("handle optional/default values in object schemas", async () => {
  const SpeedSchema = z.enum(["slow", "normal", "fast"]);
  const NumberSchema = z.string().transform(Number).pipe(z.number().int().gte(0));

  const InputSchema = z.object({
    speed: SpeedSchema,
    num: z.number().default(123),
    includeDetails: z.boolean().default(false),
  });

  const SuccessSchema = z.object({
    block_number: NumberSchema,
    base_fee: NumberSchema,
    next_fee: NumberSchema,
    eth_price: z.string().transform(Number).pipe(z.number().gte(0)),
    gas_price: z.string().transform(Number).pipe(z.number().gte(0)),
    gas_fee: NumberSchema,
    priority_fee: NumberSchema,
  });

  const errorSchemas = {
    NET_ERR: z.object({
      code: z.number(),
      message: z.string(),
      url: z.string().optional(),
    }),
    AUTH_ERR: z.object({
      userId: z.string(),
      url: z.url().optional(),
    }),
    RATE_LIMIT: z.object({
      retryAfter: z.number(),
      limit: z.number(),
      message: z.string(),
    }),
  };

  const getPricesContract = zagora({ autoCallable: true })
    .errors(errorSchemas)
    .input(InputSchema)
    .output(SuccessSchema);

  const getPrices = getPricesContract.handler(async ({ errors: err }, input) => {
    const { speed, num, includeDetails } = input;
    expectTypeOf(input).toEqualTypeOf<{
      speed: "slow" | "normal" | "fast";
      num: number;
      includeDetails: boolean;
    }>();

    if (num && num > 1000) {
      throw err.RATE_LIMIT({
        retryAfter: 60,
        limit: 1000,
        message: "Rate limit exceeded, try again in 60 seconds",
      });
    }

    if (speed === "slow" && includeDetails) {
      throw err.AUTH_ERR({
        userId: "user123",
        url: "https://www.ethgastracker.com/api/gas/latest",
      });
    }

    try {
      const resp = await fetch("https://www.ethgastracker.com/api/gas/latest");

      if (!resp.ok) {
        throw err.NET_ERR({
          code: resp.status,
          message: `HTTP ${resp.status}: ${resp.statusText}`,
          url: resp.url,
        });
      }

      const { data }: any = await resp.json();

      return {
        block_number: String(data.blockNr),
        base_fee: String(data.baseFee),
        next_fee: String(data.nextFee),
        eth_price: String(data.ethPrice),
        gas_price: String(data.oracle[speed].gwei),
        gas_fee: String(data.oracle[speed].gasFee),
        priority_fee: String(data.oracle[speed].priorityFee),
      };
    } catch (error) {
      throw new Error(`Failed to fetch gas prices: ${String(error)}`, { cause: error });
    }
  });

  const prices = await getPrices({
    speed: "normal",
    num: 50,
    includeDetails: false,
  });

  expect(prices.ok).toBe(true);

  if (prices.error && prices.error.kind === "NET_ERR") {
    expect(prices.error.code).not.toBeUndefined();
    expect(prices.error.code).toBeTypeOf("number");
    expect(prices.error.url).toBeTypeOf("string");
  }

  const pricesLimited = await getPrices({
    speed: "fast",
    num: 1500,
  });
  expect(pricesLimited.ok).toBe(false);
  if (pricesLimited.error && pricesLimited.error.kind === "RATE_LIMIT") {
    expect(pricesLimited.error.limit).toStrictEqual(1000);
    expect(pricesLimited.error.retryAfter).toStrictEqual(60);
  }

  const pricesFailing = await getPrices({
    speed: "slow",
    includeDetails: true,
  });
  expect(pricesLimited.ok).toBe(false);
  if (pricesFailing.error && pricesFailing.error.kind === "AUTH_ERR") {
    expect(pricesFailing.error.url).toBeTypeOf("string");
    expect(pricesFailing.error.userId).toStrictEqual("user123");
  }
});

test("basic in-memory caching/memoization", async () => {
  const cache = new Map();
  const za = zagora({ autoCallable: true }).cache({
    has(key: string) {
      return cache.has(key);
    },
    get(key: string) {
      return cache.get(key);
    },
    set(key: string, value: any) {
      cache.set(key, value);
    },
  });

  let called = 0;
  const hello = za.input(z.string()).handler(async (_, name) => {
    expectTypeOf(name).toEqualTypeOf<string>();

    called += 1;
    await new Promise((resolve) => setTimeout(resolve, 100));
    return `Hello, ${name}!`;
  });

  const helloRes = await hello("World");
  expect(called, "Expects to be called just once").toBe(1);

  if (helloRes.ok) {
    expect(helloRes.data).toBe("Hello, World!");
  } else {
    expect(false, "Should not reach here").toBe(true);
  }

  const helloRes2 = await hello("World");
  expect(called, "Expects to be called once after second call").toBe(1);

  if (helloRes2.ok) {
    expect(helloRes2.data).toBe("Hello, World!");
  } else {
    expect(false, "Should be instant and not reach here").toBe(true);
  }

  const _ = await hello("Bobby");
  expect(called, "Expects `called` to be incremented").toBe(2);
});

async function fixture(withSetError = false, withGetError = false, withHasError = false) {
  let called = 0;
  const cache = new Map();
  const hello = zagora()
    .context({ age: 10 })
    .input(z.string())
    .handler(({ context }) => {
      expectTypeOf(context).toEqualTypeOf<{ age: number }>();

      called += 1;
      return context.age + called;
    })
    .callable({
      cache: {
        has(key: string) {
          if (withHasError) {
            throw new Error("The has is not implemented");
          }
          return cache.has(key);
        },
        get(key: string) {
          if (withGetError) {
            throw new Error("Get method not implemented yet");
          }
          return cache.get(key);
        },
        async set(key: string, value: any) {
          if (withSetError) {
            throw new Error("Set method is not implemented");
          }
          cache.set(key, value);
        },
      },
    });

  const res = await hello("foo");
  if (withSetError || withHasError) {
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.kind).toBe("UNKNOWN_ERROR");
      expect(res.error.message).toContain(
        withSetError ? "Failure in async CacheAdapter.set" : "Failure in CacheAdapter.has",
      );
      if (withSetError) {
        expect((res.error as any)?.cause?.message).toContain("Set method is");
      }
      if (withHasError) {
        expect((res.error as any)?.cause?.message).toContain("The has is not impl");
      }
    }

    return;
  }
  expect(res.ok).toBe(true);
  expect(called, "expects to be called once").toBe(1);
  expect((res as any).data).toStrictEqual(11);

  const res2 = await hello("foo");
  if (withGetError) {
    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.error.kind).toBe("UNKNOWN_ERROR");
      expect(res2.error.message).toContain("Failure in CacheAdapter.get");
      expect((res2.error as any)?.cause?.message).toContain("Get method not impl");
    }

    return;
  }
  expect(res2.ok).toBe(true);
  expect(called, "expects to be called only once").toBe(1);
  expect((res2 as any).data).toStrictEqual(11);
}

test("cache adapter passed through `.callable` method", async () => {
  await fixture();
  await fixture(true);
  await fixture(true, true);
  await fixture(false, true);
  await fixture(false, true, true);
  await fixture(true, false);
  await fixture(true, true, false);
  await fixture(false, false, true);
});

test("the cache stores only the validated output", async () => {
  const cache = new Map();
  let called = 0;
  const procedure = zagora()
    .cache({
      has: (key: string) => cache.has(key),
      get: async (key: string) => cache.get(key),
      set: (key: string, value: unknown) => cache.set(key, value),
    })
    .input(z.string())
    .output(z.string().transform((value) => value.length))
    .handler((_, input) => {
      called += 1;
      return called === 1 ? 123 : input;
    })
    .callable();

  expect((await procedure("foo")).ok).toBe(false);
  expect(await procedure("foo")).toEqual({ ok: true, data: 3 });

  expect(await procedure("foo")).toEqual({ ok: true, data: 3 });
  expect(called).toBe(2);
  expect([...cache.values()]).toEqual([3]);
});

test("a cache entry that expires between `has` and `get` runs the handler", () => {
  let called = 0;
  const procedure = zagora()
    .cache({ has: () => true, get: () => undefined, set: () => {} })
    .input(z.string())
    .output(z.string())
    .handler((_, input) => {
      called += 1;
      return input;
    })
    .callable();

  expect(procedure("foo")).toEqual({ ok: true, data: "foo" });
  expect(called).toBe(1);
});

test("failing env validation schema through `.env` method", () => {
  const envPopulatedProcedure = zagora()
    .input(z.string())
    .env(
      z.object({
        DATABASE_URL: z.string().min(4).default("file://db.sqlite"),
        SOME_SECRET: z.string().min(2),
        PORT: z.coerce.number(),
      }),
      process.env,
    )
    .handler(({ env }, input) => {
      expectTypeOf(env).toEqualTypeOf<{
        DATABASE_URL: string;
        SOME_SECRET: string;
        PORT: number;
      }>();

      return `input=${input};url=${env.DATABASE_URL};secret=${env.SOME_SECRET};PORT=${env.PORT}`;
    })
    .callable({
      env: { SOME_SECRET: "sasa" } as any,
    });

  const res = envPopulatedProcedure("foo");
  if (!res.ok && isValidationError(res.error)) {
    expect(res.error.kind).toBe("VALIDATION_ERROR");
    expect(res.error.message).toContain("Env validation failed");
  } else {
    expect(false, "env validation should fail").toBe(true);
  }
});

test("async env schema should fail", async () => {
  const failingAsyncEnvSchemaProc = zagora()
    .input(z.string())
    .env(
      z.union([
        z.object({
          ABC: z
            .string()
            .min(2)
            .refine(async (x) => x.length > 2),
        }),
        z.record(z.string(), z.string()),
      ]),
    )
    .handler(({ env }, input) => {
      expectTypeOf(env.ABC).toEqualTypeOf<string>();
      expectTypeOf(input).toEqualTypeOf<string>();

      return `env.ABC=${env.ABC}-${input}`;
    })
    .callable({
      env: {
        ABC: "sasa",
        BAR: "env-not-defined-in-schema-is-fine",
      },
    });

  const res = await failingAsyncEnvSchemaProc("foo");
  if (!res.ok) {
    expect(res.error.kind).toBe("UNKNOWN_ERROR");
    expect(res.error.message).toContain("cannot have async schema");
  } else {
    expect(false, "async env schema should fail").toBe(true);
  }
});

test("passning and sync env schema", () => {
  const func1 = zagora()
    .env(
      z.object({
        FOO_NAME: z.string(),
      }),
    )
    .handler(({ env }) => {
      expectTypeOf(env).toEqualTypeOf<{ FOO_NAME: string }>();

      return `Hello ${env.FOO_NAME}, wasup`;
    })
    .callable({
      env: {
        FOO_NAME: "Charlie",
        // @ts-expect-error -- expected to report type-error! Because the env schema is only `z.object()`
        BARRY: "expected-fail",
      },
    });

  const res = func1();
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.data).toStrictEqual("Hello Charlie, wasup");
  } else {
    expect(false, "sync env schema should be fine and test passing").toBe(true);
  }
});

test("4-argument tuple with all required", () => {
  const fn = zagora()
    .input(z.tuple([z.string(), z.number(), z.boolean(), z.object({ id: z.string() })]))
    .output(z.string())
    .handler((_, str, num, bool, obj) => {
      expectTypeOf(str).toEqualTypeOf<string>();
      expectTypeOf(num).toEqualTypeOf<number>();
      expectTypeOf(bool).toEqualTypeOf<boolean>();
      expectTypeOf(obj).toEqualTypeOf<{ id: string }>();

      return `${str}-${num}-${bool}-${obj.id}`;
    })
    .callable();

  const res = fn("hello", 42, true, { id: "test" });
  if (res.ok) {
    expect(res.data).toBe("hello-42-true-test");
  } else {
    expect(false, "expect succcess on 4-arg all required").toBe(true);
  }
});

test("4-argument tuple with last optional", () => {
  const fn = zagora()
    .input(z.tuple([z.string(), z.number(), z.boolean(), z.object({ id: z.string() }).optional()]))
    .output(z.string())
    .handler((_, str, num, bool, obj) => {
      expectTypeOf(str).toEqualTypeOf<string>();
      expectTypeOf(num).toEqualTypeOf<number>();
      expectTypeOf(bool).toEqualTypeOf<boolean>();
      expectTypeOf(obj).toEqualTypeOf<{ id: string } | undefined>();

      return `${str}-${num}-${bool}-${obj?.id ?? "none"}`;
    })
    .callable();

  const res1 = fn("hello", 42, true, { id: "test" });
  if (res1.ok) {
    expect(res1.data).toBe("hello-42-true-test");
  } else {
    expect(false, "expect succcess on 4-arg all passed").toBe(true);
  }

  const res2 = fn("hello", 42, true);
  if (res2.ok) {
    expect(res2.data).toBe("hello-42-true-none");
  } else {
    expect(false, "expect succcess on 4-arg last optional").toBe(true);
  }
});

test("4-argument tuple with defaults", () => {
  const fn = zagora()
    .input(
      z.tuple([
        z.string(),
        z.number().default(100),
        z.boolean().default(false),
        z.object({ id: z.string() }).default({ id: "default" }),
      ]),
    )
    .output(z.string())
    .handler((_, str, num, bool, obj) => {
      expectTypeOf(str).toEqualTypeOf<string>();
      expectTypeOf(num).toEqualTypeOf<number>();
      expectTypeOf(bool).toEqualTypeOf<boolean>();
      expectTypeOf(obj).toEqualTypeOf<{ id: string }>();

      return `${str}-${num}-${bool}-${obj.id}`;
    })
    .callable();

  const res1 = fn("test", 10, true, { id: "custom" });
  if (res1.ok) {
    expect(res1.data).toBe("test-10-true-custom");
  } else {
    expect(false, "expect succcess on 4-arg with defaults").toBe(true);
  }

  const res2 = fn("test");
  if (res2.ok) {
    expect(res2.data).toBe("test-100-false-default");
  } else {
    expect(false, "Expected success").toBe(true);
  }
});

test("callable env accepts `process.env`, which is not a plain object on Node", () => {
  const envSchema = z.object({ PATH: z.string().optional() });

  const proc = zagora()
    .env(envSchema)
    .handler(({ env }) => typeof env.PATH)
    .callable({ env: process.env });

  expect(proc().ok).toBe(true);

  const auto = zagora({ autoCallable: true })
    .env(envSchema, process.env)
    .handler(({ env }) => typeof env.PATH);

  expect(auto().ok).toBe(true);
});

test("cache key supports bigint inputs", () => {
  let called = 0;
  const double = zagora()
    .input(z.bigint())
    .cache(new Map())
    .handler((_, value) => {
      called += 1;
      return value * 2n;
    })
    .callable();

  expect(double(5n)).toMatchObject({ ok: true, data: 10n });
  expect(double(5n)).toMatchObject({ ok: true, data: 10n });
  expect(double(6n)).toMatchObject({ ok: true, data: 12n });
  expect(called).toBe(2);
});

test("cache key keeps a bigint apart from a string with the same digits", () => {
  let called = 0;
  const describe = zagora()
    .input(z.union([z.bigint(), z.string()]))
    .cache(new Map())
    .handler((_, value) => {
      called += 1;
      return typeof value;
    })
    .callable();

  expect(describe(5n)).toMatchObject({ ok: true, data: "bigint" });
  expect(describe("5n")).toMatchObject({ ok: true, data: "string" });
  expect(describe("5")).toMatchObject({ ok: true, data: "string" });
  expect(called).toBe(3);
});
