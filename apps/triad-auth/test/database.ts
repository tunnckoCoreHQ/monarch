import { readdirSync, readFileSync } from "node:fs";

import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { onTestFinished } from "vitest";

import { triadDatabase } from "../src/better-auth/database";

const MIGRATIONS = new URL("../migrations/", import.meta.url);

const migrationStatements = readdirSync(MIGRATIONS)
  .filter((file) => file.endsWith(".sql"))
  .toSorted()
  .flatMap((file) =>
    readFileSync(new URL(file, MIGRATIONS), "utf-8").split("--> statement-breakpoint"),
  )
  .map((statement) => statement.trim())
  .filter(Boolean);

// Starts an empty local D1 database, the engine `pnpm run dev` uses, and applies the migrations.
// Call it inside a test: the database is disposed when the test finishes.
export async function createTestDatabase() {
  const miniflare = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default {};",
      d1Databases: ["DB"],
    }),
  );
  onTestFinished(() => miniflare.dispose());
  const binding = await miniflare.getD1Database("DB");
  await binding.batch(migrationStatements.map((statement) => binding.prepare(statement)));

  return { binding, database: triadDatabase(binding) };
}
