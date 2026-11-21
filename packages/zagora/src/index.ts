import { createErrorHelpers, createInternalError, type ResolveErrorKindNames } from "./errors";
import type { ConditionalAsync } from "./is-promise";
import type {
  AnySchema,
  CacheAdapter,
  FixedTuple,
  ConditionalCacheAsync,
  ConditionalSchemaAsync,
  HasAsyncSchema,
  InferOutput,
  InferSchemaInput,
  InferSchemaInputSafe,
  Prettify,
  ResolvedProcedure,
  ResolveHandlerOptions,
  ResolveProcedure,
  SingleArg,
  SpreadTuple,
  UppercaseKeys,
  ZagoraDef,
  ZagoraEnvVars,
  ZagoraResult,
} from "./types";
import {
  createResult,
  deepMerge,
  getPipeInputSchema,
  handleTupleDefaults,
  processHandler,
  validateError,
  validateInputOutputOrEnv,
} from "./utils";

export * as errors from "./errors";
export type * as types from "./types";
export * as utils from "./utils";

type KeysOfUnion<T> = T extends unknown ? keyof T : never;

type ResolveCallableEnv<TOptions, TEnvVarsMap> = TEnvVarsMap extends AnySchema
  ? InferSchemaInputSafe<TEnvVarsMap> &
      ("env" extends keyof TOptions
        ? string extends keyof NonNullable<TOptions[keyof TOptions & "env"]>
          ? unknown
          : Record<
              Exclude<
                keyof NonNullable<TOptions[keyof TOptions & "env"]>,
                KeysOfUnion<InferSchemaInputSafe<TEnvVarsMap>>
              >,
              never
            >
        : unknown)
  : never;

export interface ZagoraConfig {
  disableOptions?: boolean;
  autoCallable?: boolean;
}

export function zagora(): Zagora<any>;
export function zagora<
  TDisableOptions extends boolean = false,
  TAutoCallable extends boolean = false,
>(config: {
  disableOptions: TDisableOptions;
  autoCallable?: TAutoCallable;
}): Zagora<
  any,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  TDisableOptions,
  TAutoCallable
>;
export function zagora<TAutoCallable extends boolean = false>(config: {
  autoCallable: TAutoCallable;
  disableOptions?: boolean;
}): Zagora<
  any,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  false,
  TAutoCallable
>;
export function zagora(config?: ZagoraConfig) {
  return new Zagora(config) as any;
}

const isAsyncSchema = (schema: unknown) =>
  (schema as { async?: boolean } | undefined)?.async === true;

export class Zagora<
  THandlerFn extends (...args: any[]) => any,
  TContext = undefined,
  TInputSchema extends AnySchema | undefined = undefined,
  TOutputSchema extends AnySchema | undefined = undefined,
  TErrorsMap extends Record<string, AnySchema> | undefined = undefined,
  TEnvVarsMap extends AnySchema | undefined = undefined,
  TCacheAdapter extends CacheAdapter | undefined = undefined,
  TDisableOptions extends boolean = false,
  TAutoCallable extends boolean = false,
> {
  "~zagora": Partial<
    ZagoraDef<TContext, TInputSchema, TOutputSchema, TErrorsMap, TEnvVarsMap, TCacheAdapter>
  >;

  constructor(
    def: Partial<
      ZagoraDef<TContext, TInputSchema, TOutputSchema, TErrorsMap, TEnvVarsMap, TCacheAdapter>
    > = {},
  ) {
    this["~zagora"] = def;

    if ("disableOptions" in def && def.disableOptions !== undefined) {
      this["~zagora"].disableOptions = def.disableOptions;
    }
    if ("autoCallable" in def && def.autoCallable !== undefined) {
      this["~zagora"].autoCallable = def.autoCallable;
    }
  }

  input<TInput extends AnySchema>(
    inputSchema: TInput,
  ): Zagora<
    THandlerFn,
    TContext,
    TInput,
    TOutputSchema,
    TErrorsMap,
    TEnvVarsMap,
    TCacheAdapter,
    TDisableOptions,
    TAutoCallable
  > {
    return new Zagora({
      ...this["~zagora"],
      inputSchema,
    });
  }

  output<TOutput extends AnySchema>(
    outputSchema: TOutput,
  ): Zagora<
    THandlerFn,
    TContext,
    TInputSchema,
    TOutput,
    TErrorsMap,
    TEnvVarsMap,
    TCacheAdapter,
    TDisableOptions,
    TAutoCallable
  > {
    return new Zagora({
      ...this["~zagora"],
      outputSchema,
    });
  }

  context<TNewContext extends Record<string, unknown>>(
    initialContext?: TNewContext,
  ): Zagora<
    THandlerFn,
    TNewContext,
    TInputSchema,
    TOutputSchema,
    TErrorsMap,
    TEnvVarsMap,
    TCacheAdapter,
    TDisableOptions,
    TAutoCallable
  > {
    return new Zagora({
      ...this["~zagora"],
      initialContext,
    }) as any;
  }

  errors<TErrors extends Record<string, AnySchema>>(
    errorsMap: TErrors & UppercaseKeys<TErrors>,
  ): Zagora<
    THandlerFn,
    TContext,
    TInputSchema,
    TOutputSchema,
    TErrors,
    TEnvVarsMap,
    TCacheAdapter,
    TDisableOptions,
    TAutoCallable
  > {
    return new Zagora({
      ...this["~zagora"],
      errorsMap,
    }) as any;
  }

  env<TNewEnvVarsMapSchema extends AnySchema, TEnvVars extends ZagoraEnvVars>(
    envVarsMapSchema: TNewEnvVarsMapSchema,
    envVars?: TEnvVars & UppercaseKeys<TEnvVars>,
  ): Zagora<
    THandlerFn,
    TContext,
    TInputSchema,
    TOutputSchema,
    TErrorsMap,
    TNewEnvVarsMapSchema,
    TCacheAdapter,
    TDisableOptions,
    TAutoCallable
  > {
    return new Zagora({
      ...this["~zagora"],
      envVarsMapSchema,
      envVars,
    });
  }

  cache<TNewCacheAdapter extends CacheAdapter>(
    cacheAdapter: TNewCacheAdapter,
  ): Zagora<
    THandlerFn,
    TContext,
    TInputSchema,
    TOutputSchema,
    TErrorsMap,
    TEnvVarsMap,
    TNewCacheAdapter,
    TDisableOptions,
    TAutoCallable
  > {
    return new Zagora({
      ...this["~zagora"],
      cacheAdapter,
    });
  }

  handler<
    TFn extends ResolveProcedure<TDisableOptions, TContext, TInputSchema, TErrorsMap, TEnvVarsMap>,
  >(
    fn: TFn,
  ): TAutoCallable extends true
    ? ResolvedProcedure<
        TInputSchema,
        ConditionalCacheAsync<
          TCacheAdapter,
          ConditionalSchemaAsync<
            HasAsyncSchema<TInputSchema, TOutputSchema, TErrorsMap>,
            ConditionalAsync<
              ReturnType<TFn>,
              ZagoraResult<InferOutput<TOutputSchema, TFn>, TErrorsMap, any>
            >,
            Promise<ZagoraResult<InferOutput<TOutputSchema, TFn>, TErrorsMap, any>>
          >
        >
      > & {
        "~zagora": Omit<
          Partial<
            ZagoraDef<TContext, TInputSchema, TOutputSchema, TErrorsMap, TEnvVarsMap, TCacheAdapter>
          >,
          "envVars"
        >;
      }
    : Zagora<
        TFn,
        TContext,
        TInputSchema,
        TOutputSchema,
        TErrorsMap,
        TEnvVarsMap,
        TCacheAdapter,
        TDisableOptions,
        TAutoCallable
      > {
    const newInstance = new Zagora<
      TFn,
      TContext,
      TInputSchema,
      TOutputSchema,
      TErrorsMap,
      TEnvVarsMap,
      TCacheAdapter,
      TDisableOptions,
      TAutoCallable
    >({
      ...this["~zagora"],
      handler: fn as any,
    });

    if (this["~zagora"].autoCallable) {
      return newInstance._createProcedure(
        this["~zagora"].initialContext,
        this["~zagora"].envVars,
      ) as any;
    }

    return newInstance as any;
  }

  private _createProcedure<
    TCache extends CacheAdapter | undefined = TCacheAdapter,
    TEnv = unknown,
    TNewContext extends TContext = TContext,
    TKindNames extends ResolveErrorKindNames<TErrorsMap> = ResolveErrorKindNames<TErrorsMap>,
  >(context?: TNewContext, env?: TEnv) {
    const zagora = this["~zagora"];
    const disableOptions = zagora.disableOptions ?? false;
    const handlerFn = zagora.handler;
    const errorsMap = zagora.errorsMap;
    const inputSchema = zagora.inputSchema as TInputSchema;
    const outputSchema = zagora.outputSchema as TOutputSchema;
    const cacheAdapter = zagora.cacheAdapter;
    const envVarsMapSchema = zagora.envVarsMapSchema;
    const baseEnvVars = zagora.envVars;

    const hasAsyncSchema =
      isAsyncSchema(inputSchema) ||
      isAsyncSchema(outputSchema) ||
      Object.values(errorsMap || {}).some(isAsyncSchema);

    const hasAsyncHandler = handlerFn?.constructor?.name === "AsyncFunction";

    // The spread copies `process.env`, which is not a plain object on Node.
    const mergedEnvVars = deepMerge({ ...baseEnvVars }, { ...env });

    const forwardProcedure = (...args: unknown[]) => {
      const envVars = envVarsMapSchema
        ? validateInputOutputOrEnv("env", envVarsMapSchema, mergedEnvVars)
        : ({ ok: true, data: mergedEnvVars } as const);

      if (envVars instanceof Promise) {
        return createResult(
          null,
          createInternalError("Environment Variables cannot have async schema validation"),
          false,
        );
      }
      if (!envVars.ok) {
        return envVars;
      }

      const mergedContext = context
        ? deepMerge(zagora.initialContext || {}, context)
        : zagora.initialContext;

      const errors = zagora.errorsMap ? createErrorHelpers(zagora.errorsMap as any) : undefined;
      const options = {
        errors,
        context: mergedContext,
        env: envVars.data,
      } as Prettify<
        ResolveHandlerOptions<Prettify<TNewContext & TContext>, TErrorsMap, TEnvVarsMap>
      >;

      const schemaAny = getPipeInputSchema(inputSchema);
      const isTupleSchema =
        (schemaAny?._def && schemaAny?._def?.type === "tuple") || schemaAny?.type === "tuple";

      const processInput = (inputData: any) => {
        const handlerArgs = isTupleSchema
          ? handleTupleDefaults(inputSchema as any, inputData)
          : [inputData];

        const executionArgs = disableOptions ? handlerArgs : [options, ...handlerArgs];

        const state = processHandler(handlerFn, executionArgs, cacheAdapter, {
          inputSchema,
          outputSchema,
          envVarsMapSchema,
          errorsMap,
        });

        const handleState = (st: any) => {
          if (st.ok) {
            return st;
          }

          const { isAsync, handlerFailed, ...rest } = st;

          return handlerFailed
            ? validateError<TKindNames>(errorsMap as any, st.error, isAsync)
            : rest;
        };

        if (state instanceof Promise) {
          return state.then((st) => handleState(st));
        }

        return handleState(state);
      };

      const inputArgs = isTupleSchema ? args : args[0];

      const inputResult = inputSchema
        ? validateInputOutputOrEnv("input", inputSchema, inputArgs)
        : ({ ok: true, data: inputArgs } as const);

      if (inputResult instanceof Promise) {
        return inputResult.then((resultObj) =>
          resultObj.ok ? processInput(resultObj.data) : resultObj,
        );
      }

      return inputResult.ok ? processInput(inputResult.data) : inputResult;
    };

    type TResolvedResult = Awaited<ReturnType<typeof forwardProcedure>>;
    type Result = ZagoraResult<InferOutput<TOutputSchema, THandlerFn>, TErrorsMap, TResolvedResult>;

    type TResult = ConditionalSchemaAsync<
      HasAsyncSchema<TInputSchema, TOutputSchema, TErrorsMap>,
      ConditionalAsync<ReturnType<THandlerFn>, Result>,
      Promise<Result>
    >;

    type TFinalResult = ConditionalCacheAsync<TCache, TResult>;

    const procedure = (
      hasAsyncSchema || hasAsyncHandler
        ? (...args: unknown[]) => Promise.resolve(forwardProcedure(...args))
        : forwardProcedure
    ) as TInputSchema extends AnySchema
      ? InferSchemaInput<TInputSchema> extends readonly [any, ...any[]]
        ? SpreadTuple<InferSchemaInput<TInputSchema>, TFinalResult>
        : [FixedTuple<InferSchemaInput<TInputSchema>>] extends [never]
          ? SingleArg<InferSchemaInput<TInputSchema>, TFinalResult>
          : SpreadTuple<FixedTuple<InferSchemaInput<TInputSchema>>, TFinalResult>
      : () => TFinalResult;

    const proc = procedure as typeof procedure & {
      "~zagora": Omit<
        Partial<
          ZagoraDef<TContext, TInputSchema, TOutputSchema, TErrorsMap, TEnvVarsMap, TCacheAdapter>
        >,
        "envVars"
      >;
    };

    const { envVars: _envVars, ...metadata } = this["~zagora"];
    proc["~zagora"] = metadata;

    return proc;
  }

  callable<
    TNewContext extends TContext & Record<string, unknown>,
    TIncomingEnv extends ZagoraEnvVars,
    TKindNames extends ResolveErrorKindNames<TErrorsMap>,
    const TOptions extends object = {},
  >(
    options: {
      context?: TNewContext;
      cache?: CacheAdapter;
      env?: ResolveCallableEnv<TOptions, TEnvVarsMap>;
    } & TOptions &
      Record<Exclude<keyof TOptions, "context" | "cache" | "env">, never> = {} as {
      context?: TNewContext;
      cache?: CacheAdapter;
      env?: ResolveCallableEnv<TOptions, TEnvVarsMap>;
    } & TOptions &
      Record<Exclude<keyof TOptions, "context" | "cache" | "env">, never>,
  ) {
    type TOptionCache = TOptions[keyof TOptions & "cache"];
    type TProvidedCache = Extract<TOptionCache, CacheAdapter>;
    type TEffectiveCacheAdapter = "cache" extends keyof TOptions
      ? undefined extends TOptionCache
        ? TCacheAdapter | TProvidedCache
        : TProvidedCache
      : TCacheAdapter;

    let za = this;
    if (options.cache) {
      za = this.cache(options.cache) as any;
    }

    return za._createProcedure<TEffectiveCacheAdapter, TIncomingEnv, TNewContext, TKindNames>(
      options.context,
      options.env,
    );
  }
}
