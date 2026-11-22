---
"zagora": minor
---

Make `.callable()` a type error until `.handler()` is set. A call that skips the types, like plain JS or `as any`, still never throws. Its procedure returns an `UNKNOWN_ERROR` that says no handler is set.
