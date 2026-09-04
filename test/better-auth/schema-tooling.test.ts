import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { authSchemaDatabase } from "../../scripts/auth-schema-database";

function readSource(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

type DirectoryEntry = {
  name: string;
  isDirectory: () => boolean;
};

const runtimeExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".astro"]);
const repositoryRoot = resolve(".");

function collectRuntimeSourcePaths(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true }) as DirectoryEntry[];

  return entries
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        return collectRuntimeSourcePaths(path);
      }

      return runtimeExtensions.has(extname(path)) ? [path] : [];
    })
    .sort((left, right) => left.localeCompare(right));
}

function importSpecifiers(source: string): string[] {
  const importPattern =
    /\b(?:import|export)\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;

  return Array.from(source.matchAll(importPattern), (match) => match[1] ?? match[2]);
}

function modulePath(path: string): string {
  const extension = extname(path);

  return runtimeExtensions.has(extension) ? path.slice(0, -extension.length) : path;
}

function normalizeModuleId(path: string): string {
  return modulePath(path.replaceAll("\\", "/")).replace(/^\.?\//, "");
}

function repositoryModuleId(path: string): string {
  return normalizeModuleId(relative(repositoryRoot, resolve(path)));
}

function resolvesToModule(importerPath: string, specifier: string, targetPath: string): boolean {
  const targetId = repositoryModuleId(targetPath);
  if (specifier.startsWith(".")) {
    return repositoryModuleId(resolve(dirname(importerPath), specifier)) === targetId;
  }

  const specifierId = normalizeModuleId(specifier);

  return specifierId === targetId || specifierId.endsWith(`/${targetId}`);
}

const schemaIntrospectionQuery =
  'select "name", "type", "sql" from "sqlite_master" where "type" in (?, ?) and "name" not like ? and "name" not like ? and "name" != ? and "name" != ?';
const schemaIntrospectionParameters = [
  "table",
  "view",
  "sqlite_%",
  "_cf_%",
  "kysely_migration",
  "kysely_migration_lock",
];
const unsupportedIntrospectionError = "no such table: oauthResource";
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
};
const wranglerSource = readSource("wrangler.toml");
const schemaSource = readSource("src/better-auth/schema.ts");
const schemaDatabaseSource = readSource("scripts/auth-schema-database.ts");
const migrationFiles = readdirSync("migrations")
  .filter((path: string) => path.endsWith(".sql"))
  .sort();
const initialMigration = readSource("migrations/0001-initial.sql");
const walletMigration = readSource("migrations/0002-prf-wallet.sql");
const walletCapabilityMigration = readSource("migrations/0003-wallet-capability.sql");
const walletAddressesMigration = readSource("migrations/0004-wallet-addresses.sql");

describe("Better Auth schema tooling", () => {
  it("keeps the finalized initial migration and adds schema changes separately", () => {
    expect(migrationFiles).toEqual([
      "0001-initial.sql",
      "0002-prf-wallet.sql",
      "0003-wallet-capability.sql",
      "0004-wallet-addresses.sql",
    ]);
    expect(createHash("sha256").update(initialMigration).digest("hex")).toBe(
      "23f86de32d73f5cac58147983fe07b68890000174fd916f39039083d22aa9e00",
    );
    expect(initialMigration).toContain('create table "user"');
    expect(initialMigration).toContain('"encryptedData" text');
    expect(initialMigration).toContain('create table "walletAddress"');
    expect(initialMigration).toContain('create table "passkey"');
    expect(initialMigration).toContain('create table "passkeyUsername"');
    expect(initialMigration).not.toContain('create table "walletRequest"');
    expect(initialMigration).toContain('"credentialID" text not null');
    expect(initialMigration).toContain('"username" text not null unique');
    expect(initialMigration).toContain('"accountSub" text not null unique');
    expect(initialMigration).toContain('"name" text not null');
    expect(initialMigration).toContain('"email" text not null unique');
    expect(initialMigration).toContain('"emailVerified" integer not null');
    expect(initialMigration).toContain('"image" text');
    expect(initialMigration).not.toContain('"profileEmail"');
    expect(initialMigration).not.toContain('"profileEmailVerified"');
    expect(initialMigration).not.toContain('"profileHandle"');
    expect(initialMigration).not.toContain('"profileDisplayName"');
    expect(initialMigration).not.toContain('"profileAvatar"');
    expect(initialMigration).toContain('create table "deviceCode"');
    expect(initialMigration).toContain('create table "rateLimit"');
    expect(walletMigration).toContain('create table "walletRequest"');
    expect(walletMigration).toContain('"namespace" text not null');
    expect(walletMigration).toContain('"walletProfile" text not null');
    expect(walletMigration).toContain('"accountIndex" integer not null');
    expect(walletMigration).toContain('"chainId" integer');
    expect(walletMigration).toContain('"signingMessage" text not null');
    expect(walletMigration).toContain('"consumedAt" date');
    expect(walletMigration).toContain('create index "walletRequest_expiresAt_idx"');
    expect(walletCapabilityMigration).toContain(
      'alter table "passkey" add column "walletCapable" integer not null default 0',
    );
    expect(walletCapabilityMigration).toContain('create table "walletCapabilityRequest"');
    expect(walletCapabilityMigration).toContain(
      'create index "walletCapabilityRequest_expiresAt_idx"',
    );
    expect(walletAddressesMigration).toContain(
      'alter table "passkey" add column "encryptedData" text',
    );
  });

  it("configures one canonical Worker and D1 database with preview URLs", () => {
    const bindingBlocks = wranglerSource.match(/\[\[d1_databases\]\][\s\S]*?(?=\n\[|$)/g) ?? [];

    expect(bindingBlocks).toHaveLength(1);
    expect(wranglerSource).toContain('name = "triad-auth"');
    expect(wranglerSource).toContain("workers_dev = false");
    expect(wranglerSource).toContain("preview_urls = true");
    expect(wranglerSource).toContain(
      'routes = [{ pattern = "triad.wgw.lol/*", zone_name = "wgw.lol" }]',
    );
    expect(bindingBlocks[0]).toContain('binding = "DB"');
    expect(bindingBlocks[0]).toContain('database_name = "triad-auth"');
    expect(bindingBlocks[0]).toContain('database_id = "cb0818ed-e2c1-4b41-bfe6-15d4399602e2"');
    expect(bindingBlocks[0]).toContain('migrations_dir = "migrations"');
    expect(wranglerSource).not.toContain("[env.staging]");
    expect(wranglerSource).not.toContain("triad-auth-staging");
    expect(wranglerSource.match(/database_id\s*=/g)).toHaveLength(1);
  });

  it("exposes generated schema, migration, and deployment commands", () => {
    expect(packageJson.scripts["db:generate"]).toBe(
      "vp exec auth generate --config src/better-auth/schema.ts --output .generated/auth-schema.sql --yes",
    );
    expect(packageJson.scripts["db:migrate"]).toContain("--remote");
    expect(packageJson.scripts["db:migrate:local"]).toContain("--local");
    expect(packageJson.scripts.deploy).toBe("vp exec wrangler deploy");
    expect(packageJson.scripts["deploy:staging"]).toContain("versions upload");
    expect(packageJson.scripts["deploy:staging"]).toContain("--preview-alias staging");
  });

  it("does not add an adapter, emulator, SQLite driver, or legacy resource name", () => {
    const dependencyNames = [
      ...Object.keys(packageJson.dependencies),
      ...Object.keys(packageJson.devDependencies),
    ].join("\n");
    const toolingSource = [
      dependencyNames,
      JSON.stringify(packageJson.scripts),
      wranglerSource,
      schemaSource,
      schemaDatabaseSource,
    ].join("\n");

    expect(toolingSource).not.toMatch(
      /drizzle|miniflare|better-sqlite3|bun:sqlite|node:sqlite|sqlite3/i,
    );
    expect(toolingSource).not.toMatch(/triad-better-auth|triad-auth-broker/);
  });

  it("builds the schema auth instance through the canonical configuration", () => {
    const configurationCall = schemaSource.match(
      /const\s+(\w+)\s*=\s*createTriadConfiguration\(schemaEnv\);/,
    );

    expect(schemaSource).toContain('import { createTriadAuth } from "./auth";');
    expect(schemaSource).toContain('import { createTriadConfiguration } from "./configuration";');
    expect(configurationCall).not.toBeNull();
    expect(schemaSource).toContain(
      `export const auth = createTriadAuth(schemaEnv, ${configurationCall?.[1]});`,
    );
    expect(schemaSource).not.toMatch(/\bbetterAuth\s*\(/);
  });

  it("returns an empty schema for Better Auth's exact D1 introspection query", async () => {
    const result = await authSchemaDatabase
      .prepare(schemaIntrospectionQuery)
      .bind(...schemaIntrospectionParameters)
      .all();

    expect(result).toMatchObject({
      success: true,
      results: [],
      meta: {
        changes: 0,
        last_row_id: 0,
        rows_read: 0,
        rows_written: 0,
      },
    });
  });

  it("rejects arbitrary application SQL", () => {
    expect(() => authSchemaDatabase.prepare('select * from "user"')).toThrow(
      unsupportedIntrospectionError,
    );
  });

  it("rejects introspection execution with unexpected bindings", async () => {
    const statement = authSchemaDatabase.prepare(schemaIntrospectionQuery).bind("table");

    await expect(statement.all()).rejects.toThrow(unsupportedIntrospectionError);
  });

  it("throws from every unsupported query method", () => {
    const statement = authSchemaDatabase
      .prepare(schemaIntrospectionQuery)
      .bind(...schemaIntrospectionParameters);

    expect(() => authSchemaDatabase.batch([])).toThrow("SQL generation only");
    expect(() => authSchemaDatabase.exec("select 1")).toThrow("SQL generation only");
    expect(() => statement.first()).toThrow("SQL generation only");
    expect(() => statement.raw()).toThrow("SQL generation only");
    expect(() => statement.run()).toThrow("SQL generation only");
  });

  it.each([
    ["relative schema", "../better-auth/schema", "src/better-auth/schema.ts"],
    ["relative database", "../../scripts/auth-schema-database", "scripts/auth-schema-database.ts"],
    ["absolute schema", "/src/better-auth/schema.ts", "src/better-auth/schema.ts"],
    ["alias schema", "@triad/src/better-auth/schema", "src/better-auth/schema.ts"],
    ["alias database", "@triad/scripts/auth-schema-database.ts", "scripts/auth-schema-database.ts"],
  ])("recognizes a %s import of a protected module", (_name, specifier, targetPath) => {
    expect(resolvesToModule(resolve("src/pages/index.astro"), specifier, resolve(targetPath))).toBe(
      true,
    );
  });

  it("does not treat a partial module name as an alias suffix", () => {
    expect(
      resolvesToModule(
        resolve("src/pages/index.astro"),
        "schema",
        resolve("src/better-auth/schema.ts"),
      ),
    ).toBe(false);
  });

  it("keeps the schema-only database out of every runtime module", () => {
    const schemaEntryPath = resolve("src/better-auth/schema.ts");
    const schemaDatabasePath = resolve("scripts/auth-schema-database.ts");
    const violations = collectRuntimeSourcePaths("src").flatMap((path) => {
      if (path === schemaEntryPath) {
        return [];
      }

      return importSpecifiers(readSource(path))
        .filter(
          (specifier) =>
            resolvesToModule(path, specifier, schemaEntryPath) ||
            resolvesToModule(path, specifier, schemaDatabasePath),
        )
        .map((specifier) => `${path}: ${specifier}`);
    });

    expect(violations).toEqual([]);
  });
});
