import { defineConfig } from "drizzle-kit";

// `auth generate` writes the schema from the Better Auth configuration. This
// config turns it into the numbered SQL files that the deploy applies to D1.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/better-auth/drizzle-schema.ts",
  out: "./migrations",
});
