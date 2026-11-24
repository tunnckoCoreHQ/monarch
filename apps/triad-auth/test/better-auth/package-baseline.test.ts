import { readFileSync } from "node:fs";

import { cimd } from "@better-auth/cimd";
import { oauthDeviceAuthorization, oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt } from "better-auth/plugins";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
) as {
  dependencies: Record<string, string>;
};

describe("Better Auth package baseline", () => {
  it("uses the shared Better Auth catalog", () => {
    expect(packageJson.dependencies).toMatchObject({
      "@better-auth/cimd": "catalog:better-auth",
      "@better-auth/oauth-provider": "catalog:better-auth",
      "@better-auth/passkey": "catalog:better-auth",
      auth: "catalog:better-auth",
      "better-auth": "catalog:better-auth",
      "drizzle-orm": "catalog:",
    });
  });

  it("exposes the required public factories", () => {
    expect(betterAuth).toBeTypeOf("function");
    expect(drizzleAdapter).toBeTypeOf("function");
    expect(jwt).toBeTypeOf("function");
    expect(oauthProvider).toBeTypeOf("function");
    expect(oauthDeviceAuthorization).toBeTypeOf("function");
    expect(cimd).toBeTypeOf("function");
  });
});
