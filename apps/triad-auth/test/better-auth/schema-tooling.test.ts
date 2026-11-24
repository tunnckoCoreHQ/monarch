import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import config from "../../cloudflare.config";

function readSource(path: string): string {
  const file = resolve(repositoryRoot, path);
  return existsSync(file) ? readFileSync(file, "utf-8") : "";
}

type DirectoryEntry = {
  name: string;
  isDirectory: () => boolean;
};

const runtimeExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".astro"]);
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

function collectRuntimeSourcePaths(directory: string): string[] {
  const entries = readdirSync(resolve(repositoryRoot, directory), {
    withFileTypes: true,
  }) as DirectoryEntry[];

  return entries
    .flatMap((entry) => {
      const path = resolve(repositoryRoot, directory, entry.name);
      if (entry.isDirectory()) {
        return collectRuntimeSourcePaths(path);
      }

      return runtimeExtensions.has(extname(path)) ? [path] : [];
    })
    .toSorted((left, right) => left.localeCompare(right));
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

const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf-8")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
};
const cloudflareConfigSource = readSource("cloudflare.config.ts");
const schemaSource = readSource("src/better-auth/schema.ts");
const drizzleConfigSource = readSource("drizzle.config.ts");
const migrationFiles = readdirSync(resolve(repositoryRoot, "migrations"))
  .filter((path: string) => path.endsWith(".sql"))
  .toSorted();
const initialMigration = readSource("migrations/0000_initial.sql");

// cloudflare.config.ts is a function of the mode; `--mode nightly` selects the nightly Worker.
async function workerConfig(mode: string) {
  const resolved = typeof config === "function" ? await config({ mode, isPreview: false }) : config;

  return resolved.worker;
}

const productionDatabaseId = "40220009-d502-4afd-ab7b-54495016720f";
const nightlyDatabaseId = "c4c8e874-a463-4c22-8389-8911627c055d";

describe("Better Auth schema tooling", () => {
  it("starts from one Drizzle migration with the full schema", () => {
    expect(migrationFiles).toEqual(["0000_initial.sql"]);
    expect(initialMigration).toContain("CREATE TABLE `user`");
    expect(initialMigration).toContain("`encryptedData` text");
    expect(initialMigration).toContain("`providerSub` text NOT NULL");
    expect(initialMigration).toContain("CREATE UNIQUE INDEX `user_providerSub_unique`");
    expect(initialMigration).toContain("CREATE TABLE `walletAddress`");
    expect(initialMigration).toContain("CREATE TABLE `passkey`");
    expect(initialMigration).toContain("CREATE TABLE `passkeyUsername`");
    expect(initialMigration).toContain("`walletCapable` integer DEFAULT false NOT NULL");
    expect(initialMigration).toContain("CREATE TABLE `deviceCode`");
    expect(initialMigration).toContain("`oauthClientId` text");
    expect(initialMigration).toContain("CREATE TABLE `rateLimit`");
    expect(initialMigration).toContain("CREATE UNIQUE INDEX `rateLimit_key_unique`");
    expect(initialMigration).toContain("CREATE TABLE `walletRequest`");
    expect(initialMigration).toContain("CREATE TABLE `walletCapabilityRequest`");
    expect(initialMigration).toContain("CREATE TABLE `oauthClient`");
    expect(initialMigration).not.toMatch(/`profile(?:Email|Handle|DisplayName|Avatar)`/);
    expect(initialMigration).not.toContain("ALTER TABLE");
  });

  it.each([
    ["production", "triad-auth", productionDatabaseId],
    ["development", "triad-auth", productionDatabaseId],
    ["nightly", "triad-auth-nightly", nightlyDatabaseId],
  ])("configures the Worker and D1 database for mode %s", async (mode, name, databaseId) => {
    const worker = await workerConfig(mode);

    expect(worker?.name).toBe(name);
    expect(worker?.entrypoint).toBe("src/index.ts");
    expect(worker?.workersDev).toBe(false);
    expect(worker?.triggers).toEqual([
      { type: "fetch", pattern: `${name}.wgw.lol/*`, zone: "wgw.lol" },
    ]);
    expect(worker?.env?.AUTH_ORIGIN).toMatchObject({ value: `https://${name}.wgw.lol` });
    expect(worker?.env?.DB).toMatchObject({ name, id: databaseId });
  });

  it("serves static assets with the same runtime behavior in both modes", async () => {
    for (const mode of ["production", "nightly"]) {
      const worker = await workerConfig(mode);

      expect(worker?.assets).toEqual({
        htmlHandling: "drop-trailing-slash",
        notFoundHandling: "404-page",
        runWorkerFirst: false,
      });
      expect(worker?.compatibilityDate).toBe("2026-07-09");
      expect(worker?.compatibilityFlags).toEqual(["nodejs_compat", "global_fetch_strictly_public"]);
    }
  });

  it("exposes generated schema, migration, and deployment commands", () => {
    expect(packageJson.scripts["db:generate"]).toBe(
      "pnpm exec auth generate --config src/better-auth/schema.ts --output src/better-auth/drizzle-schema.ts --yes && pnpm exec drizzle-kit generate",
    );
    expect(packageJson.scripts.build).toBe("pnpm exec cf build");
    expect(packageJson.scripts["deploy:nightly"]).toBe(
      `pnpm exec cf d1 migrations apply ${nightlyDatabaseId} && pnpm exec cf deploy --mode nightly`,
    );
    expect(packageJson.scripts["deploy:prod"]).toBe(
      `pnpm exec cf d1 migrations apply ${productionDatabaseId} && pnpm exec cf deploy --mode production`,
    );
    expect(packageJson.scripts.promote).toBe(
      "rwx dispatch monarch-deploy-prod --ref master --param app=triad-auth --wait",
    );
    expect(packageJson.scripts.deploy).toBeUndefined();
    expect(packageJson.scripts["deploy:staging"]).toBeUndefined();
    expect(packageJson.scripts.test).toBe("vitest run");
  });

  it("writes Drizzle migrations from the generated schema into the deploy folder", () => {
    expect(packageJson.dependencies["drizzle-orm"]).toBe("catalog:");
    expect(packageJson.devDependencies["drizzle-kit"]).toBe("catalog:");
    expect(drizzleConfigSource).toContain('dialect: "sqlite"');
    expect(drizzleConfigSource).toContain('schema: "./src/better-auth/drizzle-schema.ts"');
    expect(drizzleConfigSource).toContain('out: "./migrations"');
  });

  it("does not add Wrangler, an emulator, a SQLite driver, or a legacy resource name", () => {
    const dependencyNames = [
      ...Object.keys(packageJson.dependencies),
      ...Object.keys(packageJson.devDependencies),
    ].join("\n");
    const toolingSource = [
      dependencyNames,
      JSON.stringify(packageJson.scripts),
      cloudflareConfigSource,
      schemaSource,
    ].join("\n");

    expect(toolingSource).not.toMatch(/miniflare|better-sqlite3|bun:sqlite|node:sqlite|sqlite3/i);
    expect(toolingSource).not.toMatch(/triad-better-auth|triad-auth-broker/);
    expect(dependencyNames).not.toMatch(/^wrangler$/m);
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

  it.each([
    ["relative schema", "../better-auth/schema", "src/better-auth/schema.ts"],
    ["absolute schema", "/src/better-auth/schema.ts", "src/better-auth/schema.ts"],
    ["alias schema", "@triad/src/better-auth/schema", "src/better-auth/schema.ts"],
  ])("recognizes a %s import of a protected module", (_name, specifier, targetPath) => {
    expect(
      resolvesToModule(
        resolve(repositoryRoot, "src/pages/index.astro"),
        specifier,
        resolve(repositoryRoot, targetPath),
      ),
    ).toBe(true);
  });

  it("does not treat a partial module name as an alias suffix", () => {
    expect(
      resolvesToModule(
        resolve(repositoryRoot, "src/pages/index.astro"),
        "schema",
        resolve(repositoryRoot, "src/better-auth/schema.ts"),
      ),
    ).toBe(false);
  });

  it("keeps the schema-only auth instance out of every runtime module", () => {
    const schemaEntryPath = resolve(repositoryRoot, "src/better-auth/schema.ts");
    const violations = collectRuntimeSourcePaths("src").flatMap((path) => {
      if (path === schemaEntryPath) {
        return [];
      }

      return importSpecifiers(readSource(path))
        .filter((specifier) => resolvesToModule(path, specifier, schemaEntryPath))
        .map((specifier) => `${path}: ${specifier}`);
    });

    expect(violations).toEqual([]);
  });
});
