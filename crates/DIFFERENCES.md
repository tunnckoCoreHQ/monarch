# Differences from tsgolint v7.0.2003

tsgolint-rust gives the same output as the Go tsgolint, with the exceptions below. Most of them come from the TypeScript revision: tsgolint v7.0.2003 uses typescript-go `2bd066d87f5b` (the TypeScript 7.0 release branch, 2026-07-07). tsgolint-rust uses the `tsgolint-rust-upstream` branch of the ts-rust fork at `e21a51bc` (upstream ts-rust `d4eecf99` plus 4 patches), which ports microsoft/TypeScript `fed0bf24149f` (7.1.0-dev, 2026-10-08). The patches do not change that TypeScript revision.

Each TypeScript difference below was checked with two compilers: `typescript@7.0.2` (close to tsgolint's typescript-go) and `typescript@7.1.0-dev.20261008.1` (the revision that ts-rust ports). Go agrees with 7.0.2 and tsgolint-rust agrees with 7.1.0-dev in every case.

## TypeScript 7.1 differences

### Type strings are cut short at another point

TypeScript 7.1 elides more of a long type when it prints it in a message or label. This changes the text of `description` and `labeled_ranges[].label`, not the diagnostic itself.

```ts
type FC<P> = (props: P) => unknown;
declare const x: FC<{ a: string }> | FC<{ b: string }> | FC<{ c: string }> | FC<{ d: string }>
  | FC<{ e: string }> | ((props: { f: string }) => unknown) | ((props: { g: string }) => unknown);
export const n: number = x;
```

TypeScript 7.0.2 prints `... | FC<...> | ((props: { ...; }) => unknown) | ((props: { ...; }) => unknown)`. TypeScript 7.1.0-dev prints `... | FC<...> | ... | ...`. Object members change the same way: 7.0.2 prints `rerender: (ui: string) => void` where 7.1.0-dev prints `rerender: ...`.

### Union members print in another order

When a union in a message has members of the same kind, TypeScript 7.1 can order them differently (seen in Effect's `ai/Tool.ts`). One rule test case is pinned for this, `no-redundant-type-constituents` `invalid-26`: typescript-go's `CompareTypes` has no case for bigint literals and orders them by type id (`1n | -1n`), and TypeScript 7.1 orders them by value (`-1n | 1n`).

### TS7031 on a contextually typed binding pattern with a default

```ts
type S = (o?: { c?: number }) => number;
export const s: S = ({ c } = {}) => c ?? 0;
```

TypeScript 7.1.0-dev reports `TS7031: Binding element 'c' implicitly has an 'any' type.` TypeScript 7.0.2 reports nothing. With `report_semantic`, tsgolint-rust reports it too (seen in hono).

### Inference and assignability changes that change a rule result

- **Inference.** In TanStack Query's `queryCache.build(client, {...}, {...state, data})`, TypeScript 7.1 infers `TData = any` where 7.0 infers `unknown`. The contextual type of `data` is then `any`, so `no-unsafe-assignment` reports `anyAssignment` there and tsgolint does not.
- **Variance of circular generic types.** TypeScript 7.1 measures the variance of `QueryBehavior` (part of a cycle through `FetchContext`, `QueryOptions` and `Query`) differently and accepts `QueryBehavior<unknown, unknown, string>` where `QueryBehavior<unknown, unknown, number>` is expected. tsgolint reports `no-unsafe-type-assertion` on an assertion between two such types and tsgolint-rust does not. The 7.1.0-dev compiler accepts the same assignment, so ts-rust follows its reference here.
- **New type errors.** TypeScript 7.1.0-dev reports six TS2322/TS2345 errors in Effect's `packages/effect` (`HttpClient.ts`, `GraphQL.ts`, `SchemaAST.ts`, `schema/SchemaCompiler/runtime.ts`) that 7.0.2 does not.

### Library changes

The bundled `lib.dom.d.ts` changed. `TransformStreamDefaultController.enqueue` is `enqueue(chunk?: O)` in 7.0 and `enqueue(chunk: O)` in 7.1, so a message that prints its parameter type says `Head | ChunkData` where tsgolint says `Head | ChunkData | undefined`. `OXC_LOG=debug` also reports more lib files in a program ("Program created with 147 source files" against 139).

## Behavior differences by design

- **Effect diagnostics.** ts-rust has the Effect language service diagnostics built in. When a tsconfig enables the `@effect/language-service` plugin, `report_semantic` also returns the Effect diagnostics (codes TS377xxx), from the same check. tsgolint has no Effect support. Effect's tsconfig warnings do not count as tsconfig errors.
- **Checker per file.** tsgolint's default scheduling lints a file on whichever checker is free, so results that depend on checker history (type ids, union order, some `any` results) change from run to run. tsgolint-rust lints each file on the checker that ts-rust assigns to it, like tsgolint with `OXLINT_TSGOLINT_CHECKER_SCHEDULING=affinity`, so its output is the same on every run. ts-rust assigns files to checkers with TypeScript 7.1's weighted import-graph split, not tsgolint's round-robin.
- **Order of programs in the stream.** tsgolint emits programs in random map order. tsgolint-rust emits them in payload order; the inferred program comes last, as in tsgolint. Within a program the order is tsgolint's: TypeScript diagnostics first, then rule diagnostics in traversal order per file.
- **Panics.** Where tsgolint panics (for example `no-duplicate-type-constituents` with `-fix` on a union type that spans lines: `couldn't find '&' or '|' token`, or a payload path that is not normalized), tsgolint-rust panics with the same message and exits with code 2. tsgolint dies at once; tsgolint-rust can write a few more diagnostics before it exits. oxlint ignores the output of a run that exits with a non-zero code.
- **Stdout's reader gone, on Windows.** On Unix both binaries end by SIGPIPE at the next write to stdout. On Windows tsgolint ignores the failed writes and lints to the end, while tsgolint-rust exits with code 2 at once. The WASI build does the same.
- **Profiling flags.** `-trace`, `-cpuprof`, `-heap` and `-allocs` are accepted and keep tsgolint's error messages for unwritable paths, but the files they create are empty: there is no Go runtime to profile.
- **Error texts after the fixed prefix.** The `<rule>: failed to unmarshal options: ...` panic keeps tsgolint's prefix, but serde_json words the error after it. Payload errors (`error parsing config: ...`) keep JSON v2's wording, with one exception: Go chooses between "cannot" and "unable to" at random, and tsgolint-rust always says "cannot".
- **Regular expressions.** tsgolint compiles three kinds of pattern. Each port uses a Rust engine with the same syntax for valid patterns, and they can differ on edge cases:
  - `switch-exhaustiveness-check` `defaultCaseCommentPattern` uses regexp2 in ECMAScript mode; the port uses `regress`.
  - `dot-notation` `allowPattern` uses Go RE2; the port uses `regex`.
  - `prefer-regexp-exec` and `prefer-includes` check whether a pattern is valid; the port uses ts-rust's own regex checker. .NET-only syntax such as `(?i)` compiles in regexp2 but is invalid here.

## WASI

The `wasm32-wasip1` build runs on one thread and gives the same output as the native build. Its stream order is deterministic. It reads the current directory from `PWD`, and it needs the file system preopened at the same paths (`--dir /::/` with wasmtime), because path resolution walks parent directories from the root.
