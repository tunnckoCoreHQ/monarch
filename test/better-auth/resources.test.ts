import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import {
  ACCESS_TOKEN_TTL_SECONDS,
  createTriadResourceFragment,
  REFRESH_TOKEN_TTL_SECONDS,
  resolveTriadResourceRequest,
  type TriadResourceRequestError,
} from "../../src/better-auth/resources";

const productionEnv = { AUTH_ORIGIN: "https://auth.example.com" };

describe("Triad OAuth resource fragment", () => {
  it("always configures the canonical Triad demo resource", () => {
    const fragment = createTriadResourceFragment(productionEnv);

    expect(fragment.oauthProviderOptions).toEqual({
      accessTokenExpiresIn: 300,
      enforcePerClientResources: false,
      refreshTokenExpiresIn: 2_592_000,
      resourceSeedMode: "overwrite",
      resources: [
        {
          accessTokenTtl: 300,
          allowedScopes: [
            "openid",
            "email",
            "handle",
            "name",
            "avatar",
            "wallet",
            "chains",
            "chain_id",
            "cred",
            "pubkey",
            "cosekey",
          ],
          disabled: false,
          identifier: "https://auth.example.com/demo",
          name: "Triad demo",
        },
      ],
      scopes: [
        "openid",
        "email",
        "handle",
        "name",
        "avatar",
        "wallet",
        "chains",
        "chain_id",
        "cred",
        "pubkey",
        "cosekey",
      ],
    });
    expect(fragment.oauthProviderOptions.resources?.[0]).not.toHaveProperty("refreshTokenTtl");
    expect(fragment.oauthProviderExtensions).toEqual([]);
    expect(fragment.betterAuthPlugins).toEqual([]);
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(5 * 60);
    expect(REFRESH_TOKEN_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
  });

  it("uses the installed OAuth Provider public option types", () => {
    const fragment = createTriadResourceFragment(productionEnv);

    expectTypeOf(fragment.oauthProviderOptions.resources).toMatchTypeOf<
      | Array<
          | string
          | {
              identifier: string;
              allowedScopes?: string[];
              accessTokenTtl?: number;
            }
        >
      | undefined
    >();
  });
});

describe("Triad OAuth resource request semantics", () => {
  const fragment = createTriadResourceFragment(productionEnv);

  it.each<[resource: string | string[] | undefined, description: string]>([
    [undefined, "a missing resource"],
    [[], "an empty resource list"],
    [["https://auth.example.com/demo", "https://other.example.com/resource"], "multiple resources"],
    [["https://auth.example.com/demo", "https://auth.example.com/demo"], "a duplicate"],
    ["https://unknown.example.com", "an unrecognized resource"],
  ])("rejects %s with invalid_target (%s)", (resource) => {
    expect(() => resolveTriadResourceRequest(fragment, { resource, scopes: ["openid"] })).toThrow(
      expect.objectContaining({
        code: "invalid_target",
      } satisfies Partial<TriadResourceRequestError>),
    );
  });

  it.each([
    ["https://auth.example.com/demo", ["email"]],
    ["https://auth.example.com/demo", ["openid", "offline_access"]],
    ["https://auth.example.com/demo", ["openid", "email", "email"]],
    ["https://auth.example.com/demo", ["openid", "profile"]],
  ])("rejects noncanonical scopes for %s", (resource, scopes) => {
    expect(() => resolveTriadResourceRequest(fragment, { resource, scopes })).toThrow(
      expect.objectContaining({
        code: "invalid_scope",
      } satisfies Partial<TriadResourceRequestError>),
    );
  });

  it("resolves the demo to its resource and OIDC UserInfo audiences", () => {
    const resolved = resolveTriadResourceRequest(fragment, {
      resource: "https://auth.example.com/demo",
      scopes: ["openid"],
    });

    expect(resolved).toEqual({
      audience: [
        "https://auth.example.com/demo",
        "https://auth.example.com/api/auth/oauth2/userinfo",
      ],
      issueRefreshToken: false,
      resource: "https://auth.example.com/demo",
      resources: ["https://auth.example.com/demo"],
      scopes: ["openid"],
    });
  });

  it("defaults and canonicalizes demo disclosure scopes", () => {
    const defaulted = resolveTriadResourceRequest(fragment, {
      resource: "https://auth.example.com/demo",
      scopes: [],
    });
    const canonical = resolveTriadResourceRequest(fragment, {
      resource: "https://auth.example.com/demo",
      scopes: ["avatar", "openid", "email"],
    });

    expect(defaulted.scopes).toEqual(["openid"]);
    expect(canonical.scopes).toEqual(["openid", "email", "avatar"]);
    expect(canonical.issueRefreshToken).toBe(false);
  });
});

describe("Triad RFC 9728 protected-resource metadata", () => {
  it("describes each HTTPS resource at its path-preserving well-known URL", () => {
    const fragment = createTriadResourceFragment(productionEnv);

    expect(fragment.protectedResourceMetadata).toEqual([
      {
        metadataUrl: "https://auth.example.com/.well-known/oauth-protected-resource/demo",
        document: {
          authorization_servers: ["https://auth.example.com/api/auth"],
          bearer_methods_supported: ["header"],
          resource: "https://auth.example.com/demo",
          resource_name: "Triad demo",
          scopes_supported: [
            "openid",
            "email",
            "handle",
            "name",
            "avatar",
            "wallet",
            "chains",
            "chain_id",
            "cred",
            "pubkey",
            "cosekey",
          ],
        },
      },
    ]);
  });

  it("does not publish RFC 9728 metadata for local HTTP or non-HTTPS resources", () => {
    const fragment = createTriadResourceFragment({ AUTH_ORIGIN: "http://localhost:8787" });

    expect(fragment.protectedResourceMetadata).toEqual([]);
  });
});
