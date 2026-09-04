import { readFileSync } from "node:fs";
import { oauthProvider } from "@better-auth/oauth-provider";
import { describe, expect, it } from "vite-plus/test";

const plugin = oauthProvider({
  allowDynamicClientRegistration: true,
  allowUnauthenticatedClientRegistration: true,
  consentPage: "/consent",
  loginPage: "/sign-in/",
});

const entryUrl = new URL(import.meta.resolve("@better-auth/oauth-provider"));
const registrationSource = readFileSync(new URL("./register-BotzQoS8.mjs", entryUrl), "utf8");
const openRegistration = registrationSource.match(
  /if \(!session && !isTokenAuthorized\) \{[\s\S]*?\n\t}/,
)?.[0];

describe("OAuth Provider public DCR guard", () => {
  it("keeps open registration explicitly enabled", () => {
    expect(plugin.options.allowUnauthenticatedClientRegistration).toBe(true);
  });

  it("requires anonymous clients to declare the none auth method", () => {
    expect(openRegistration).toContain('body.token_endpoint_auth_method !== "none"');
    expect(openRegistration).toContain(
      "unauthenticated registration requires token_endpoint_auth_method",
    );
  });

  it("retains the anonymous client-credentials rejection", () => {
    expect(openRegistration).toContain('body.grant_types?.includes("client_credentials")');
  });
});
