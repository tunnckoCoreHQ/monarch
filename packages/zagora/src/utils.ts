import nodeCrypto from "node:crypto";

import { createInternalError, createValidationError } from "./errors";
import type { AnySchema, CacheAdapter } from "./types";

export function getCacheHash(data: string) {
  return nodeCrypto.createHash("sha256").update(data).digest("hex");
}

function createUnexpectedValidationError(
  mode: "input" | "output" | "error data" | "env",
  cause: unknown,
) {
  return createResult(
    null,
    createInternalError(`Unexpected failure during ${mode} validation`, cause),
    false,
  );
}

export function validateInputOutputOrEnv(mode: "input" | "output" | "env", schema: any, data: any) {
  const processResult = (result: any) =>
    result.issues
      ? createResult(null, createValidationError(mode, result.issues), false)
      : createResult(result.value, null, false);

  try {
    const result = schema["~standard"].validate(data);
    if (result instanceof Promise) {
      return result
        .then(processResult)
        .catch((error: unknown) => createUnexpectedValidationError(mode, error));
    }
    return processResult(result);
  } catch (error) {
    return createUnexpectedValidationError(mode, error);
  }
}

export function validateError<TKindNames>(
  errorsMap: Record<string, AnySchema>,
  error: any,
  isAsync: boolean,
) {
  if (!errorsMap) {
    return createResult(
      null,
      createInternalError(`${isAsync ? "Async" : "Sync"} handler threw unknown error`, error),
      false,
    );
  }

  const kind = error?.kind;
  if (typeof kind !== "string") {
    return createResult(
      null,
      createInternalError(`${isAsync ? "Async" : "Sync"} handler threw unknown error`, error),
      false,
    );
  }

  if (Object.hasOwn(errorsMap, kind)) {
    const kindName = kind as TKindNames;
    const schema = errorsMap[kindName as any] as any;
    const { kind: _, ...cleanedError } = error;
    const processError = (res: any) =>
      res.issues
        ? createResult(
            null,
            createValidationError<TKindNames>("error data", res.issues, kindName),
            false,
          )
        : createResult(null, { ...res.value, kind } as const, true);

    try {
      const result = schema["~standard"].validate(cleanedError);
      if (result instanceof Promise) {
        return result
          .then(processError)
          .catch((error: unknown) => createUnexpectedValidationError("error data", error));
      }
      return processError(result);
    } catch (error) {
      return createUnexpectedValidationError("error data", error);
    }
  }

  return createResult(
    null,
    createInternalError(`Typed Error ${kind} is not defined in errors map`, error),
    false,
  );
}

export function processHandler(
  handlerFn: any,
  args: any[],
  cacheAdapter: any,
  incoming: {
    inputSchema?: unknown;
    outputSchema?: unknown;
    errorsMap?: unknown;
    envVarsMapSchema?: unknown;
  },
) {
  const { outputSchema } = incoming;
  let key = "";

  if (cacheAdapter) {
    try {
      key = getCacheHash(
        JSON.stringify({ ...incoming, fnStr: handlerFn.toString(), args }, (_, value) =>
          typeof value === "bigint" ? { $bigint: value.toString() } : value,
        ),
      );
    } catch (error) {
      return createResult(null, createInternalError("Failed to compute cache key", error), false);
    }
  }

  if (cacheAdapter) {
    const hasResult = tryCatch(() => cacheAdapter.has?.(key), false, "has");
    /* v8 ignore next -- @preserve */
    if (hasResult instanceof Promise) {
      return hasResult.then((resolved) => {
        if (resolved.ok) {
          return resolved.data
            ? readCache(args, { handlerFn, cacheAdapter, key, outputSchema })
            : executeHandler(args, { handlerFn, cacheAdapter, key, outputSchema });
        }
        return resolved;
      });
    }

    if (hasResult.ok) {
      return hasResult.data
        ? readCache(args, { handlerFn, cacheAdapter, key, outputSchema })
        : executeHandler(args, { handlerFn, cacheAdapter, key, outputSchema });
    }
    return hasResult;
  }

  return executeHandler(args, { handlerFn, cacheAdapter, key, outputSchema });
}

function readCache(
  args: any[],
  options: { handlerFn: any; cacheAdapter: CacheAdapter; key: string; outputSchema?: any },
) {
  const runHandlerOnMiss = (cached: any) =>
    cached.ok && cached.data === undefined ? executeHandler(args, options) : cached;

  const cached = tryCatch(() => options.cacheAdapter.get?.(options.key), false, "get");
  if (cached instanceof Promise) {
    return cached.then(runHandlerOnMiss);
  }

  return runHandlerOnMiss(cached);
}

function validateOutput(outputSchema: any, data: unknown) {
  return outputSchema
    ? validateInputOutputOrEnv("output", outputSchema, data)
    : createResult(data, null, false);
}

export function executeHandler(
  argz: any,
  {
    handlerFn,
    cacheAdapter,
    key,
    outputSchema,
  }: { handlerFn: any; cacheAdapter: CacheAdapter; key: string; outputSchema?: any },
) {
  const handlerResult = tryCatch(() => handlerFn(...argz), true);
  if (handlerResult instanceof Promise) {
    return handlerResult.then((handlerResolved) =>
      handlerResolved.ok
        ? cacheValidOutput(handlerResolved.data, { cacheAdapter, key, outputSchema })
        : handlerResolved,
    );
  }

  return handlerResult.ok
    ? cacheValidOutput(handlerResult.data, { cacheAdapter, key, outputSchema })
    : handlerResult;
}

function cacheValidOutput(
  data: unknown,
  {
    cacheAdapter,
    key,
    outputSchema,
  }: { cacheAdapter: CacheAdapter; key: string; outputSchema: any },
) {
  const storeOutput = (output: any) => {
    if (!output.ok) {
      return output;
    }

    const resp = tryCatch(() => cacheAdapter?.set?.(key, output.data), false, "set");
    if (resp instanceof Promise) {
      return resp.then((resolved) => (resolved.ok ? output : resolved));
    }
    return resp.ok ? output : resp;
  };

  const output = validateOutput(outputSchema, data);
  if (output instanceof Promise) {
    return output.then(storeOutput);
  }

  return storeOutput(output);
}

export function tryCatch(fn: any, isHandler: boolean, method = "") {
  try {
    const res = fn();
    const isThenable = typeof res?.then === "function";
    if (isThenable) {
      return Promise.resolve(res)
        .then((data) => createResult(data, null, false))
        .catch((error: unknown) => {
          if (isHandler) {
            return {
              ok: false as const,
              isTypedError: false as const,
              error,
              handlerFailed: true,
              isAsync: true,
            };
          }
          return createResult(
            null,
            createInternalError(`Failure in async CacheAdapter.${method} method`, error),
            false,
          );
        });
    }
    return createResult(res, null, false);
  } catch (error: unknown) {
    if (isHandler) {
      return {
        ok: false as const,
        isTypedError: false as const,
        error,
        handlerFailed: true,
        isAsync: false,
      };
    }

    return createResult(
      null,
      createInternalError(`Failure in CacheAdapter.${method} method`, error),
      false,
    );
  }
}

export function createResult(data: any, error: any, isTypedError: boolean) {
  if (error) {
    return { ok: false, isTypedError, error: Object.freeze(error) } as const;
  }

  return { ok: true, data, error: undefined } as const;
}

// A Zod transform wraps its schema in a pipe. The schema that receives the input is the pipe's `in`.
export function getPipeInputSchema(schema: any) {
  let inner = schema;
  while (inner?._def?.type === "pipe") {
    inner = inner._def.in;
  }
  return inner;
}

export function handleTupleDefaults(schema: AnySchema, parsedInput: unknown): unknown[] {
  if (!Array.isArray(parsedInput)) {
    return [parsedInput];
  }

  const schemaAny = schema as any;
  const isZodTuple = schemaAny._def && schemaAny._def.type === "tuple";
  const isValibotTuple = schemaAny.type === "tuple" && !isZodTuple;

  if (isZodTuple || isValibotTuple) {
    const tupleItems = schemaAny?._def?.items || schemaAny.items;

    if (tupleItems && Array.isArray(tupleItems)) {
      const result = [...parsedInput];

      for (let i = parsedInput.length; i < tupleItems.length; i++) {
        const itemSchema = tupleItems[i];

        if (itemSchema && itemSchema.type === "default" && itemSchema._def) {
          const defaultValue =
            typeof itemSchema._def.defaultValue === "function"
              ? itemSchema._def.defaultValue()
              : itemSchema._def.defaultValue;

          result[i] = defaultValue;
        } else if (itemSchema && isValibotTuple && itemSchema.type === "optional") {
          result[i] = itemSchema.default;
        }
      }

      return result;
    }
  }

  return parsedInput;
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    throw new Error("Expects plain object args");
  }

  const result: Record<string, any> = { ...base };

  for (const key of Object.keys(override)) {
    const value =
      Object.hasOwn(result, key) && isPlainObject(result[key]) && isPlainObject(override[key])
        ? deepMerge(result[key], override[key])
        : override[key];

    Object.defineProperty(result, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  return result;
}
