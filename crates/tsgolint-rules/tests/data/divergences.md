# Accepted divergences from tsgolint

ts-rust ports a newer TypeScript (7.1.0-dev, 2026-10-08) than tsgolint v7.0.2003 (7.0, 2026-07-07). When the newer checker gives another type, type string or diagnostic, a rule test case can differ from tsgolint's expectation without a bug in our code. Such a case is listed here and pinned in `divergences/`.

Never pin a difference that comes from a bug in the port.

## How a case is pinned

`divergences/<rule>.json` maps a case key to the reason and the Rust result:

```json
{
  "TestNoArrayDelete/invalid-3": {
    "reason": "TypeScript 7.1 prints `readonly number[]` here (microsoft/TypeScript#12345)",
    "result": { "diagnostics": [], "outputs": [], "snapshot": "No diagnostics" }
  }
}
```

`result` is the checked part of the case: each diagnostic's message id, 1-based line and UTF-16 column of its start and end, suggestion ids and outputs, the code after each fix pass, and the snapshot text. Run the case with `TSGOLINT_PRINT_RESULT=1` to print it in this form:

```
TSGOLINT_PRINT_RESULT=1 cargo test -p tsgolint-rules --test rules -- 'TestNoArrayDelete/invalid-3'
```

The harness then checks the case against the pinned result instead of tsgolint's expectation. A pinned case fails when its result changes, and also when it matches tsgolint again (remove the entry then).

## Cases

Each entry below gives the case key, what tsgolint expects, what we produce, and the TypeScript change or checker function that explains it.

- `no-redundant-type-constituents` `TestNoRedundantTypeConstituentsRule/invalid-26`. tsgolint prints the union `(-1n | 1n)` as `1n | -1n`; we print `-1n | 1n`. typescript-go's `CompareTypes` (internal/checker/utilities.go:392) has no case for bigint literals and orders them by type id; ts-rust's `compare_types` (checker/utilities_p1.rs:1067) orders them by value, as TypeScript 7.1 does.
