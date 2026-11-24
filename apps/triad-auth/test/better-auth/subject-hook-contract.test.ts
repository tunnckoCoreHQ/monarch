import { readdirSync, readFileSync } from "node:fs";

import { oauthProvider, type OAuthOptions } from "@better-auth/oauth-provider";
import { describe, expect, it } from "vitest";

const resolver: NonNullable<OAuthOptions["resolveSubjectIdentifier"]> = (input) =>
  `${input.use}:${input.clientId}:${input.userId}:${input.defaultSubject}`;

const plugin = oauthProvider({
  consentPage: "/consent",
  loginPage: "/sign-in/",
  resolveSubjectIdentifier: resolver,
});

const distUrl = new URL(".", import.meta.resolve("@better-auth/oauth-provider"));
const distSource = readdirSync(distUrl)
  .filter((file) => file.endsWith(".mjs"))
  .map((file) => readFileSync(new URL(file, distUrl), "utf-8"))
  .join("\n");

describe("OAuth Provider exact-client subject hook", () => {
  it("exposes the resolver through the public options type", () => {
    expect(plugin.options.resolveSubjectIdentifier).toBe(resolver);
  });

  it("labels every OIDC-facing subject use", () => {
    expect(distSource).toContain('resolveSubjectIdentifier(userId, client, opts, "logout_token")');
    expect(distSource).toContain('resolveSubjectIdentifier(user.id, client, opts, "userinfo")');
    expect(distSource).toContain('resolveSubjectIdentifier(user.id, client, opts, "id_token")');
  });

  it("enables UserInfo subject resolution without a pairwise secret", () => {
    expect(distSource).toContain(
      "const client = clientId && (opts.pairwiseSecret || opts.resolveSubjectIdentifier || hasUserInfoClaimExtension(opts))",
    );
    expect(distSource).toContain(
      "if ((opts.pairwiseSecret || opts.resolveSubjectIdentifier) && client) baseUserClaims.sub",
    );
  });

  it("passes the exact client ID and built-in default subject to the hook", () => {
    const subjectResolver = distSource.match(
      /async function resolveSubjectIdentifier\(userId, client, opts, use\) \{[\s\S]*?\n}/,
    )?.[0];

    expect(subjectResolver).toContain("clientId: client.clientId");
    expect(subjectResolver).toContain("defaultSubject");
  });

  it("returns the global subject from introspection", () => {
    const introspectionResolver = distSource.match(
      /async function resolveIntrospectionSubjects[\s\S]*?\n}\nasync function introspectEndpoint/,
    )?.[0];

    expect(introspectionResolver).toContain("return payload;");
    expect(introspectionResolver).not.toContain("resolvePresentedSubjects(");
  });
});
