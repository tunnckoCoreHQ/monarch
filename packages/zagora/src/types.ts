import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { ErrorHelpers, InferSchemaMapPlain, InternalError, ValidationError } from "./errors";
import type { Zagora } from "./index";
import type { IsPromise } from "./is-promise";

export type * from "./is-promise";

export type Schema<I, O = I> = StandardSchemaV1<I, O>;

export type AnySchema = Schema<any, any>;

export type IsAsyncSchema<T> = [T] extends [never]
  ? false
  : T extends unknown
    ? "async" extends keyof T
      ? [T["async" & keyof T]] extends [true]
        ? true
        : true extends T["async" & keyof T]
          ? boolean
          : false
      : false
    : never;

type SchemaMapAsyncState<T> =
  T extends Record<string, AnySchema>
    ? true extends {
        [K in keyof T]: [IsAsyncSchema<T[K]>] extends [true] ? true : false;
      }[keyof T]
      ? true
      : true extends {
            [K in keyof T]: true extends IsAsyncSchema<T[K]> ? true : false;
          }[keyof T]
        ? boolean
        : false
    : false;

type IsDefinitelyAsync<T extends boolean> = [T] extends [true] ? true : false;
type IsPossiblyAsync<T extends boolean> = true extends T ? true : false;

export type HasAsyncSchema<TInputSchema, TOutputSchema, TErrorsMap> = true extends
  | IsDefinitelyAsync<IsAsyncSchema<TInputSchema>>
  | IsDefinitelyAsync<IsAsyncSchema<TOutputSchema>>
  | IsDefinitelyAsync<SchemaMapAsyncState<TErrorsMap>>
  ? true
  : true extends
        | IsPossiblyAsync<IsAsyncSchema<TInputSchema>>
        | IsPossiblyAsync<IsAsyncSchema<TOutputSchema>>
        | IsPossiblyAsync<SchemaMapAsyncState<TErrorsMap>>
    ? boolean
    : false;

export type ConditionalSchemaAsync<
  TAsync extends boolean,
  TSync,
  TAsyncResult,
> = TAsync extends true ? TAsyncResult : TSync;

export type SchemaIssue = StandardSchemaV1.Issue;

export type InferSchemaOutput<T extends AnySchema> =
  T extends StandardSchemaV1<any, infer UOutput> ? UOutput : never;

export type InferSchemaInput<T extends AnySchema> =
  T extends StandardSchemaV1<infer UInput, any> ? UInput : never;

export type InferSchemaOutputSafe<T> = T extends AnySchema ? InferSchemaOutput<T> : unknown;

export type InferOutput<
  TOutputSchema extends AnySchema | undefined,
  THandlerFn extends (...args: any[]) => any,
> = TOutputSchema extends AnySchema
  ? InferSchemaOutput<TOutputSchema>
  : Awaited<ReturnType<THandlerFn>>;

export type InferSchemaInputSafe<T> = T extends AnySchema ? InferSchemaInput<T> : unknown;

export type UppercaseKeys<T> = {
  [K in keyof T as Uppercase<string & K>]: T[K];
};

export type ZagoraEnvVars = Record<string, string> | Record<string, string | undefined>;

export type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

export type IsOptional<T> = undefined extends T ? true : false;

export type ObjectToUnion<T> = T[keyof T];

export type CacheAdapter = {
  has(key: string): boolean | Promise<boolean>;
  get(key: string): unknown;
  set(key: string, value: unknown): any;
};

export type HasAsyncCache<TCache> = TCache extends {
  has(key: string): infer THas;
  get(key: string): infer TGet;
  set(key: string, value: unknown): infer TSet;
}
  ? true extends
      | IsDefinitelyAsync<IsPromise<THas>>
      | IsDefinitelyAsync<IsPromise<TGet>>
      | IsDefinitelyAsync<IsPromise<TSet>>
    ? true
    : true extends
          | IsPossiblyAsync<IsPromise<THas>>
          | IsPossiblyAsync<IsPromise<TGet>>
          | IsPossiblyAsync<IsPromise<TSet>>
      ? boolean
      : false
  : false;

export type ConditionalCacheAsync<TCache, TResult> = [HasAsyncCache<TCache>] extends [false]
  ? TResult
  : TResult | Promise<Awaited<TResult>>;

export type ZagoraResult<
  TOutput,
  TErrorsMap,
  TResolvedResult,
  IsTypedError = TErrorsMap extends Record<string, any> ? boolean : false,
> = TResolvedResult extends { readonly ok: true }
  ? {
      readonly ok: true;
      data: TOutput;
      readonly error: undefined;
    }
  : IsTypedError extends true
    ? TErrorsMap extends Record<string, AnySchema>
      ? {
          readonly ok: false;
          readonly isTypedError: true;
          readonly error: Prettify<
            Readonly<Prettify<ObjectToUnion<InferSchemaMapPlain<TErrorsMap, true>>>>
          >;
        }
      : never
    : {
        readonly ok: false;
        readonly isTypedError: false;
        readonly error:
          | InternalError
          | ValidationError<
              TErrorsMap extends Record<string, AnySchema> ? keyof TErrorsMap : never
            >;
      };

export interface ZagoraDef<
  TContext,
  TInputSchema extends AnySchema | undefined,
  TOutputSchema extends AnySchema | undefined,
  TErrorsMap extends Record<string, AnySchema> | undefined,
  TEnvVarsMap extends AnySchema | undefined,
  TCacheAdapter extends CacheAdapter | undefined = undefined,
> {
  disableOptions?: boolean;
  autoCallable?: boolean;
  initialContext: any;
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  errorsMap: TErrorsMap;
  envVarsMapSchema: TEnvVarsMap;
  envVars: ZagoraEnvVars;
  cacheAdapter: TCacheAdapter;
  handler?: (options: { context: TContext; errors: any }, ...args: unknown[]) => any;
}

export interface ResolveHandlerOptions<
  TContext,
  TErrorsMap extends Record<string, AnySchema> | undefined,
  TEnvVarsMap extends AnySchema | undefined,
> {
  context: TContext;
  errors: TErrorsMap extends Record<string, AnySchema> ? ErrorHelpers<TErrorsMap> : undefined;
  env: InferSchemaOutputSafe<TEnvVarsMap>;
}

export type ResolveProcedure<
  TDisableOptions extends boolean,
  TContext,
  TInputSchema extends AnySchema | undefined,
  TErrorsMap extends Record<string, AnySchema> | undefined,
  TEnvVarsMap extends AnySchema | undefined,
> = TDisableOptions extends true
  ? TInputSchema extends AnySchema
    ? InferSchemaOutput<TInputSchema> extends readonly [any, ...any[]]
      ? SpreadTuple<InferSchemaOutput<TInputSchema>, any>
      : [TupleSchemaFixedOutput<TInputSchema>] extends [never]
        ? (arg: InferSchemaOutput<TInputSchema>) => any
        : SpreadTuple<TupleSchemaFixedOutput<TInputSchema>, any>
    : () => any
  : TInputSchema extends AnySchema
    ? InferSchemaOutput<TInputSchema> extends readonly [any, ...any[]]
      ? SpreadTuple<
          [
            Prettify<ResolveHandlerOptions<TContext, TErrorsMap, TEnvVarsMap>>,
            ...InferSchemaOutput<TInputSchema>,
          ],
          any
        >
      : [TupleSchemaFixedOutput<TInputSchema>] extends [never]
        ? (
            options: Prettify<ResolveHandlerOptions<TContext, TErrorsMap, TEnvVarsMap>>,
            arg: InferSchemaOutput<TInputSchema>,
          ) => any
        : SpreadTuple<
            [
              Prettify<ResolveHandlerOptions<TContext, TErrorsMap, TEnvVarsMap>>,
              ...TupleSchemaFixedOutput<TInputSchema>,
            ],
            any
          >
    : (options: Prettify<ResolveHandlerOptions<TContext, TErrorsMap, TEnvVarsMap>>) => any;

export type FixedTuple<T> = [T] extends [infer TTuple extends readonly any[]]
  ? number extends TTuple["length"]
    ? never
    : TTuple
  : never;

type TupleSchemaFixedOutput<TSchema extends AnySchema> = [
  FixedTuple<InferSchemaInput<TSchema>>,
] extends [never]
  ? never
  : FixedTuple<InferSchemaOutput<TSchema>>;

type OptionalTail<T extends readonly any[], TTail extends any[] = []> = T extends readonly [
  ...infer THead,
  infer TLast,
]
  ? IsOptional<TLast> extends true
    ? OptionalTail<THead, [TLast, ...TTail]>
    : [...T, ...Partial<TTail>]
  : [...T, ...Partial<TTail>];

export type SpreadTuple<T extends readonly any[], R> = (...args: OptionalTail<T>) => R;

export type SingleArg<TInput, R> =
  IsOptional<TInput> extends true ? (arg?: TInput) => R : (arg: TInput) => R;

export type ResolvedProcedure<
  TInputSchema extends AnySchema | undefined,
  TFinalResult,
> = TInputSchema extends AnySchema
  ? InferSchemaInput<TInputSchema> extends readonly [any, ...any[]]
    ? SpreadTuple<InferSchemaInput<TInputSchema>, TFinalResult>
    : [FixedTuple<InferSchemaInput<TInputSchema>>] extends [never]
      ? SingleArg<InferSchemaInput<TInputSchema>, TFinalResult>
      : SpreadTuple<FixedTuple<InferSchemaInput<TInputSchema>>, TFinalResult>
  : () => TFinalResult;

export type Implemented<T> = {
  [K in keyof T]: T[K] extends Zagora<any, any, infer TInput, any, any, any, any, any, any>
    ? ResolvedProcedure<TInput, unknown>
    : Implemented<T[K]>;
};

export type Exact<T, TContract> = T extends (...args: any[]) => any
  ? T
  : T & { [K in Exclude<keyof T, keyof TContract>]: never } & {
      [K in keyof T & keyof TContract]: Exact<T[K], TContract[K]>;
    };
