# Better Auth D1/Kysely Compatibility

Better Auth `1.7.0-rc.1` detects a direct Cloudflare D1 binding and lazily loads its `d1-sqlite-dialect` module when the first request initializes the auth context. That module imports `DEFAULT_MIGRATION_LOCK_TABLE` from the Kysely package root.

Kysely `0.29.3` no longer exports `DEFAULT_MIGRATION_LOCK_TABLE` from its root. Direct-D1 initialization therefore fails before query execution with:

```text
SyntaxError: The requested module 'kysely' does not provide an export named 'DEFAULT_MIGRATION_LOCK_TABLE'
```

The workspace override pins Kysely to `0.28.17`, where the required root export remains available. `pnpm why kysely` verifies that the Better Auth dependency graph resolves exactly one Kysely version, `0.28.17`, and the direct-D1 runtime contract verifies successful lazy initialization.

Because the override applies workspace-wide, reconsider it whenever another Kysely consumer is introduced or upgraded. Rerun `pnpm why kysely` whenever the dependency graph changes to confirm every consumer remains compatible with the pinned version.

Retest the direct-D1 runtime contract whenever Better Auth is upgraded. Remove the override once the upgraded Better Auth D1 dialect no longer depends on the removed Kysely root export; do not retain the pin without rechecking that compatibility boundary.
