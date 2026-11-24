import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/better-auth/drizzle-schema.ts",
  out: "./migrations",
});
