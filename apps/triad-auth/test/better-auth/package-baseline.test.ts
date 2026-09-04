import { readFileSync } from "node:fs";
import { cimd } from "@better-auth/cimd";
import { deviceCodeGrant, oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { jwt } from "better-auth/plugins";
import { describe, expect, it } from "vite-plus/test";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as {
  dependencies: Record<string, string>;
};

const acceptsD1Database = (database: D1Database): BetterAuthOptions["database"] => database;

describe("Better Auth package baseline", () => {
  it("uses the shared Better Auth catalog", () => {
    expect(packageJson.dependencies).toMatchObject({
      "@better-auth/cimd": "catalog:better-auth",
      "@better-auth/oauth-provider": "catalog:better-auth",
      "@better-auth/passkey": "catalog:better-auth",
      auth: "catalog:better-auth",
      "better-auth": "catalog:better-auth",
    });
  });

  it("exposes the required public factories", () => {
    expect(betterAuth).toBeTypeOf("function");
    expect(jwt).toBeTypeOf("function");
    expect(oauthProvider).toBeTypeOf("function");
    expect(deviceCodeGrant).toBeTypeOf("function");
    expect(cimd).toBeTypeOf("function");
  });

  it("accepts the Cloudflare D1 binding without an ORM adapter", () => {
    const database = {} as D1Database;

    expect(acceptsD1Database(database)).toBe(database);
  });
});
