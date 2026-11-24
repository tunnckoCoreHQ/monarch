import { readdirSync, readFileSync } from "node:fs";

import type { OAuthOptions, Scope } from "@better-auth/oauth-provider";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  createClientAdmissionFragment,
  createPublicDcrOptions,
  publicDcrGuard,
} from "../../src/better-auth/admission";

const distUrl = new URL(".", import.meta.resolve("@better-auth/oauth-provider"));
const distSource = readdirSync(distUrl)
  .filter((file) => file.endsWith(".mjs"))
  .map((file) => readFileSync(new URL(file, distUrl), "utf-8"))
  .join("\n");

describe("public DCR policy", () => {
  it("enables anonymous authorization-code registration with mandatory PKCE", () => {
    const options = createPublicDcrOptions();

    expectTypeOf(options).toMatchTypeOf<Partial<OAuthOptions<Scope[]>>>();

    expect(options).toEqual({
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      clientRegistrationRequirePKCE: true,
      grantTypes: ["authorization_code"],
    });
    expect(options).not.toHaveProperty("validateInitialAccessToken");
    expect(options).not.toHaveProperty("generateClientId");
  });

  it("guards only the register route and never creates a public client secret", () => {
    const [hook] = publicDcrGuard.hooks.before;

    expect(publicDcrGuard.hooks.before).toHaveLength(1);
    expect(hook?.matcher({ path: "/oauth2/register" } as never)).toBe(true);
    expect(hook?.matcher({ path: "/oauth2/token" } as never)).toBe(false);
    expect(distSource).toContain(
      "const clientSecret = isPublic || isPrivateKeyJwt || isExtensionAuthMethod ? void 0",
    );
  });

  it("retains S256-only PKCE and safe exact registered redirect checks", () => {
    expect(distSource).toContain('code_challenge_methods_supported: ["S256"]');
    expect(distSource).toContain(
      "redirect_uris: z.array(RedirectUriSyntaxSchema).min(1).optional()",
    );
    expect(distSource).toContain("if (url === requested) return true");
    expect(distSource).toContain(
      "findRegisteredRedirectUri(registeredUris, redirectUri, isWebClient)",
    );
  });

  it("does not use Origin as client identity", () => {
    const options = createPublicDcrOptions();

    expect(options).not.toHaveProperty("generateClientId");
    expect(distSource).toContain(
      "const clientId = input.clientId ?? opts.generateClientId?.() ?? generateRandomString",
    );
  });
});

describe("client admission fragment", () => {
  it("composes CIMD discovery, the public DCR guard, and public DCR options", () => {
    const fragment = createClientAdmissionFragment({
      resolveHostname: async () => ["8.8.8.8"],
    });

    expect(fragment.betterAuthPlugins).toEqual([publicDcrGuard]);
    expect(fragment.oauthProvider.allowDynamicClientRegistration).toBe(true);
    expect(fragment.oauthProvider.allowUnauthenticatedClientRegistration).toBe(true);
    expect(fragment.oauthProvider.clientRegistrationRequirePKCE).toBe(true);
    expect(fragment.oauthProvider.grantTypes).toEqual(["authorization_code"]);
    expect(fragment.oauthProvider.extensions).toHaveLength(1);
    expect(fragment.oauthProvider.extensions[0]?.clientDiscovery).toMatchObject({
      id: "cimd",
      discoveryMetadata: { client_id_metadata_document_supported: true },
    });
  });
});
