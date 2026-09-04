# Direct D1 Foundation

Better Auth 1.7.0-rc.1 detects Cloudflare D1 through the binding's `batch`, `exec`, and `prepare` methods. It then uses its bundled D1 SQLite dialect without an application adapter.

At runtime, `createTriadAuth()` receives the real Worker `DB` binding directly. The object in `scripts/auth-schema-database.ts` is restricted to CLI schema compilation: it reports an empty schema so `auth generate` can compile SQL, and unsupported query operations fail loudly. Runtime modules must not import it.

Better Auth generates the migration SQL, but Wrangler applies that SQL to D1. Triad does not use Better Auth's `migrate` command for deployment.

The D1 configuration contains an all-zero placeholder UUID. Deployment replaces it only after the isolated `triad-better-auth` remote database has been created; this foundation task does not create or inspect remote resources.
