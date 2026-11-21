// SPDX-License-Identifier: Apache-2.0

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { expectTypeOf, test } from "vitest";
import { z } from "zod";

import type { DefinedError, ResolveErrorKindNames } from "../src/errors";
import type { ZagoraConfig } from "../src/index";
import type {
  ConditionalCacheAsync,
  FixedTuple,
  InferOutput,
  InferSchemaInput,
  InferSchemaInputSafe,
  InferSchemaOutput,
  ObjectToUnion,
  Prettify,
  SchemaIssue,
  ZagoraDef,
  ZagoraEnvVars,
} from "../src/types";

const withDefault = z.number().default(10);
const toLength = z.string().transform((value) => value.length);
const idSchema = z.object({ id: z.string() });

type SyncCache = {
  has(key: string): boolean;
  get(key: string): unknown;
  set(key: string, value: unknown): void;
};

type AsyncCache = {
  has(key: string): Promise<boolean>;
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
};

test("InferSchemaInput and InferSchemaOutput read both sides of a schema", () => {
  expectTypeOf<InferSchemaInput<typeof withDefault>>().toEqualTypeOf<number | undefined>();
  expectTypeOf<InferSchemaOutput<typeof withDefault>>().toEqualTypeOf<number>();
  expectTypeOf<InferSchemaInput<typeof toLength>>().toEqualTypeOf<string>();
  expectTypeOf<InferSchemaOutput<typeof toLength>>().toEqualTypeOf<number>();
});

test("InferSchemaInputSafe gives unknown for a value that is not a schema", () => {
  expectTypeOf<InferSchemaInputSafe<typeof toLength>>().toEqualTypeOf<string>();
  expectTypeOf<InferSchemaInputSafe<undefined>>().toEqualTypeOf<unknown>();
  expectTypeOf<InferSchemaInputSafe<string>>().toEqualTypeOf<unknown>();
});

test("InferOutput prefers the output schema over the handler return type", () => {
  expectTypeOf<InferOutput<typeof toLength, () => string>>().toEqualTypeOf<number>();
  expectTypeOf<InferOutput<undefined, () => Promise<{ id: number }>>>().toEqualTypeOf<{
    id: number;
  }>();
  expectTypeOf<InferOutput<undefined, () => boolean>>().toEqualTypeOf<boolean>();
});

test("FixedTuple keeps only tuples with a fixed length", () => {
  expectTypeOf<FixedTuple<[string, number]>>().toEqualTypeOf<[string, number]>();
  expectTypeOf<FixedTuple<[string?]>>().toEqualTypeOf<[string?]>();
  expectTypeOf<FixedTuple<string[]>>().toBeNever();
  expectTypeOf<FixedTuple<string>>().toBeNever();
});

test("ConditionalCacheAsync adds a Promise only for an async cache", () => {
  expectTypeOf<ConditionalCacheAsync<SyncCache, "result">>().toEqualTypeOf<"result">();
  expectTypeOf<ConditionalCacheAsync<undefined, "result">>().toEqualTypeOf<"result">();
  expectTypeOf<ConditionalCacheAsync<AsyncCache, "result">>().toEqualTypeOf<
    "result" | Promise<"result">
  >();
  expectTypeOf<ConditionalCacheAsync<AsyncCache, Promise<"result">>>().toEqualTypeOf<
    Promise<"result">
  >();
});

test("Prettify flattens an intersection", () => {
  expectTypeOf<Prettify<{ a: 1 } & { b: 2 }>>().toEqualTypeOf<{ a: 1; b: 2 }>();
});

test("ObjectToUnion gives the union of the values", () => {
  expectTypeOf<ObjectToUnion<{ a: 1; b: "x" }>>().toEqualTypeOf<1 | "x">();
});

test("SchemaIssue is the Standard Schema issue", () => {
  expectTypeOf<SchemaIssue>().toEqualTypeOf<StandardSchemaV1.Issue>();
});

test("ZagoraEnvVars accepts records of strings only", () => {
  expectTypeOf<{ PORT: string }>().toExtend<ZagoraEnvVars>();
  expectTypeOf<typeof process.env>().toExtend<ZagoraEnvVars>();
  expectTypeOf<{ DEBUG: boolean }>().not.toExtend<ZagoraEnvVars>();
});

test("ZagoraConfig has two optional flags", () => {
  expectTypeOf<ZagoraConfig>().toEqualTypeOf<{
    disableOptions?: boolean;
    autoCallable?: boolean;
  }>();
});

test("ZagoraDef carries the schemas it gets", () => {
  type Def = ZagoraDef<{ db: string }, typeof idSchema, undefined, undefined, undefined>;

  expectTypeOf<Def["inputSchema"]>().toEqualTypeOf<typeof idSchema>();
  expectTypeOf<Def["outputSchema"]>().toEqualTypeOf<undefined>();
  expectTypeOf<Def["cacheAdapter"]>().toEqualTypeOf<undefined>();
  expectTypeOf<Def["envVars"]>().toEqualTypeOf<ZagoraEnvVars>();
  expectTypeOf<Def["disableOptions"]>().toEqualTypeOf<boolean | undefined>();
});

test("ResolveErrorKindNames gives the keys of an error map", () => {
  expectTypeOf<
    ResolveErrorKindNames<{ NOT_FOUND: typeof idSchema; FORBIDDEN: typeof idSchema }>
  >().toEqualTypeOf<"NOT_FOUND" | "FORBIDDEN">();
  expectTypeOf<ResolveErrorKindNames<undefined>>().toEqualTypeOf<undefined>();
});

test("DefinedError adds a readonly kind to the error data", () => {
  expectTypeOf<DefinedError<{ id: string }>>().toEqualTypeOf<{
    readonly kind: string;
    id: string;
  }>();
});
