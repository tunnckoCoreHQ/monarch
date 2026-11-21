---
"zagora": patch
---

A handler that throws a value whose `kind` getter throws now gets an `UNKNOWN_ERROR` result, with the thrown value in `cause`. Before, the getter error escaped the call. A sync call threw it, and an async call rejected with it.
