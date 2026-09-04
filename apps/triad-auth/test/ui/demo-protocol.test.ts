import { describe, expect, it } from "vite-plus/test";

import {
  authorizationRequest,
  canonicalScopeRequest,
  DEVICE_CODE_GRANT_TYPE,
  demoProviderCapabilities,
  demoResourceFromIssuer,
  inspectOAuthQuery,
  isIdentitySigningKey,
  oauthDeviceTokenRequest,
  tokenExchangeRequest,
} from "../../src/scripts/demo-protocol";

describe("Better Auth demo protocol", () => {
  it("builds the authorization request with the projected client, resource, and canonical scopes", () => {
    const request = authorizationRequest({
      authorizationEndpoint: "https://auth.example/api/auth/oauth2/authorize",
      callbackUrl: "https://auth.example/demo/callback",
      challenge: "challenge",
      clientId: "server-client-id",
      resource: "https://auth.example/demo",
      scope: "openid email avatar",
      state: "state",
    });

    expect(request.href).toBe(
      "https://auth.example/api/auth/oauth2/authorize?response_type=code&client_id=server-client-id&redirect_uri=https%3A%2F%2Fauth.example%2Fdemo%2Fcallback&scope=openid+email+avatar&resource=https%3A%2F%2Fauth.example%2Fdemo&state=state&code_challenge=challenge&code_challenge_method=S256&prompt=login",
    );
  });

  it("derives the canonical demo resource from the server issuer", () => {
    expect(demoResourceFromIssuer("https://auth.example/api/auth")).toBe(
      "https://auth.example/demo",
    );
  });

  it("preserves the exact signed query while inspecting canonical values", () => {
    const rawQuery =
      "?client_id=server-client&scope=openid%20email%20avatar&resource=https%3A%2F%2Fresource.example%2F&resource=https%3A%2F%2Fsecond.example%2F&exp=1&sig=signed";

    expect(inspectOAuthQuery(rawQuery)).toEqual({
      clientId: "server-client",
      oauthQuery: rawQuery.slice(1),
      resources: ["https://resource.example/", "https://second.example/"],
      scopes: ["openid", "email", "avatar"],
    });
  });

  it.each([
    "?scope=openid&sig=signed",
    "?client_id=client&scope=email&resource=https%3A%2F%2Fresource.example%2F&sig=signed",
    "?client_id=client&scope=openid%20profile&resource=https%3A%2F%2Fresource.example%2F&sig=signed",
    "?client_id=client&scope=openid&scope=openid&sig=signed",
    "?client_id=client&scope=openid&resource=relative&sig=signed",
  ])("rejects an invalid consent query: %s", (query) => {
    expect(() => inspectOAuthQuery(query)).toThrow("authorization request");
  });

  it("binds token exchange to the projected client, resource, callback, and verifier", () => {
    expect(
      tokenExchangeRequest({
        callbackUrl: "https://auth.example/demo/callback",
        clientId: "server-client-id",
        code: "code",
        resource: "https://auth.example/demo",
        verifier: "verifier",
      }).toString(),
    ).toBe(
      "grant_type=authorization_code&client_id=server-client-id&redirect_uri=https%3A%2F%2Fauth.example%2Fdemo%2Fcallback&code=code&code_verifier=verifier&resource=https%3A%2F%2Fauth.example%2Fdemo",
    );
  });

  it("binds an OAuth device exchange to its client, code, and resource", () => {
    expect(
      oauthDeviceTokenRequest({
        clientId: "device-client",
        deviceCode: "device-code",
        resource: "https://resource.example/",
      }).toString(),
    ).toBe(
      `grant_type=${encodeURIComponent(DEVICE_CODE_GRANT_TYPE)}&device_code=device-code&client_id=device-client&resource=https%3A%2F%2Fresource.example%2F`,
    );
  });

  it.each([
    { alg: "ES256", crv: "P-256", kid: "active", kty: "EC" },
    { alg: "ES256", crv: "P-256", kid: "active", kty: "EC", use: "sig" },
  ])("accepts an RC.1 ES256 signing key with optional use: $use", (key) => {
    expect(isIdentitySigningKey(key, "active")).toBe(true);
  });

  it.each([
    { alg: "ES256", crv: "P-256", kid: "active", kty: "EC", use: "enc" },
    { alg: "ES384", crv: "P-256", kid: "active", kty: "EC" },
    { alg: "ES256", crv: "P-384", kid: "active", kty: "EC" },
    { alg: "ES256", crv: "P-256", kid: "other", kty: "EC" },
    { alg: "ES256", crv: "P-256", kty: "EC" },
    { alg: "ES256", crv: "P-256", kid: "active", kty: "RSA" },
  ])("rejects an ineligible identity signing key: $key", (key) => {
    expect(isIdentitySigningKey(key, "active")).toBe(false);
  });
});

describe("demo disclosure scopes", () => {
  it("defines each provider's exact optional claim capabilities", () => {
    expect(demoProviderCapabilities).toEqual([
      { id: "google", scopes: ["email", "name", "avatar"] },
      { id: "github", scopes: ["email", "handle", "name", "avatar"] },
      { id: "twitter", scopes: ["handle", "name", "avatar"] },
      { id: "ethereum", scopes: ["wallet", "chains", "chain_id"] },
      { id: "passkey", scopes: ["handle", "cred", "pubkey", "cosekey"] },
    ]);
  });

  it("defaults to openid and serializes supported selections in canonical order", () => {
    const github = demoProviderCapabilities[1]!;

    expect(canonicalScopeRequest(github, [])).toBe("openid");
    expect(canonicalScopeRequest(github, ["avatar", "email", "email"])).toBe("openid email avatar");
  });

  it("rejects scopes that the selected provider cannot disclose", () => {
    const google = demoProviderCapabilities[0]!;
    const twitter = demoProviderCapabilities[2]!;

    expect(() => canonicalScopeRequest(google, ["handle"])).toThrow("selected provider");
    expect(() => canonicalScopeRequest(twitter, ["email"])).toThrow("selected provider");
  });
});
