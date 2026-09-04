import {
  type OAuthOptions,
  type OAuthProviderExtension,
  type OAuthResourceInput,
  type ResourceServerMetadata,
  type Scope,
} from "@better-auth/oauth-provider";
import type { BetterAuthPlugin } from "better-auth";

import { AUTH_BASE_PATH } from "../auth";
import { DISCLOSURE_SCOPES, canonicalDisclosureScopes, type DisclosureScope } from "../disclosures";

export const ACCESS_TOKEN_TTL_SECONDS = 5 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

const DEMO_SCOPES = DISCLOSURE_SCOPES;

export type TriadScope = DisclosureScope;

export interface TriadResourceRequest {
  resource?: string | readonly string[];
  scopes: readonly string[];
}

export type TriadResourceErrorCode = "invalid_scope" | "invalid_target";

export class TriadResourceRequestError extends Error {
  readonly code: TriadResourceErrorCode;

  constructor(code: TriadResourceErrorCode, message: string) {
    super(message);
    this.name = "TriadResourceRequestError";
    this.code = code;
  }
}

export interface ResolvedTriadResourceRequest {
  audience: string | [string, string];
  issueRefreshToken: boolean;
  resource: string;
  resources: [string];
  scopes: TriadScope[];
}

export interface TriadProtectedResourceMetadata {
  metadataUrl: string;
  document: ResourceServerMetadata;
}

export type TriadResourceOAuthProviderOptions = Pick<
  OAuthOptions<Scope[]>,
  | "accessTokenExpiresIn"
  | "enforcePerClientResources"
  | "refreshTokenExpiresIn"
  | "resources"
  | "resourceSeedMode"
  | "scopes"
>;

export interface TriadRecognizedResource extends OAuthResourceInput {
  name: string;
  accessTokenTtl: number;
  allowedScopes: TriadScope[];
  disabled: false;
}

export interface TriadResourceFragment {
  oauthProviderOptions: TriadResourceOAuthProviderOptions;
  oauthProviderExtensions: OAuthProviderExtension[];
  betterAuthPlugins: BetterAuthPlugin[];
  protectedResourceMetadata: TriadProtectedResourceMetadata[];
  recognizedResources: TriadRecognizedResource[];
  authorizationServer: string;
}

export const triadResourceOAuthProviderExtensions: OAuthProviderExtension[] = [];
export const triadResourceBetterAuthPlugins: BetterAuthPlugin[] = [];

function canonicalOrigin(authOrigin: string): string {
  return new URL(authOrigin).origin;
}

function authorizationServer(origin: string): string {
  return new URL(AUTH_BASE_PATH, origin).href;
}

function demoResource(origin: string): TriadRecognizedResource {
  return {
    identifier: new URL("/demo", origin).href,
    name: "Triad demo",
    accessTokenTtl: ACCESS_TOKEN_TTL_SECONDS,
    allowedScopes: [...DEMO_SCOPES],
    disabled: false,
  };
}

function metadataUrl(identifier: string): string | undefined {
  const resource = new URL(identifier);
  if (resource.protocol !== "https:") {
    return undefined;
  }

  resource.pathname = `/.well-known/oauth-protected-resource${
    resource.pathname === "/" ? "" : resource.pathname
  }`;
  resource.search = "";

  return resource.href;
}

function protectedResourceMetadata(
  resource: TriadRecognizedResource,
  issuer: string,
): TriadProtectedResourceMetadata | undefined {
  const location = metadataUrl(resource.identifier);
  if (!location) {
    return undefined;
  }

  return {
    metadataUrl: location,
    document: {
      resource: resource.identifier,
      authorization_servers: [issuer],
      scopes_supported: [...resource.allowedScopes],
      bearer_methods_supported: ["header"],
      resource_name: resource.name,
    },
  };
}

export function createTriadResourceFragment(env: { AUTH_ORIGIN: string }): TriadResourceFragment {
  const origin = canonicalOrigin(env.AUTH_ORIGIN);
  const issuer = authorizationServer(origin);
  const recognizedResources = [demoResource(origin)];
  const scopes: TriadScope[] = [...DEMO_SCOPES];

  return {
    authorizationServer: issuer,
    recognizedResources,
    oauthProviderOptions: {
      scopes,
      resources: recognizedResources,
      resourceSeedMode: "overwrite",
      enforcePerClientResources: false,
      accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
    },
    oauthProviderExtensions: triadResourceOAuthProviderExtensions,
    betterAuthPlugins: triadResourceBetterAuthPlugins,
    protectedResourceMetadata: recognizedResources.flatMap((resource) => {
      const metadata = protectedResourceMetadata(resource, issuer);

      return metadata ? [metadata] : [];
    }),
  };
}

function exactRequestedResource(resource: TriadResourceRequest["resource"]): string {
  if (typeof resource === "string" && resource.length > 0) {
    return resource;
  }
  if (Array.isArray(resource) && resource.length === 1 && resource[0]) {
    return resource[0];
  }

  throw new TriadResourceRequestError(
    "invalid_target",
    "exactly one recognized resource is required",
  );
}

function canonicalScopes(
  resource: TriadRecognizedResource,
  requested: readonly string[],
): TriadScope[] {
  const uniqueRequested = new Set(requested);
  if (uniqueRequested.size !== requested.length) {
    throw new TriadResourceRequestError("invalid_scope", "duplicate scopes are not allowed");
  }

  const isDemo =
    resource.allowedScopes.length === DEMO_SCOPES.length &&
    DEMO_SCOPES.every((scope) => resource.allowedScopes.includes(scope));
  if (isDemo) {
    try {
      return canonicalDisclosureScopes(requested);
    } catch (error) {
      throw new TriadResourceRequestError(
        "invalid_scope",
        error instanceof Error ? error.message : "invalid disclosure scopes",
      );
    }
  }

  throw new TriadResourceRequestError(
    "invalid_scope",
    `requested scopes are not valid for resource ${resource.identifier}`,
  );
}

export function resolveTriadResourceRequest(
  fragment: TriadResourceFragment,
  request: TriadResourceRequest,
): ResolvedTriadResourceRequest {
  const identifier = exactRequestedResource(request.resource);
  const resource = fragment.recognizedResources.find(
    (candidate) => candidate.identifier === identifier,
  );
  if (!resource) {
    throw new TriadResourceRequestError(
      "invalid_target",
      `resource ${identifier} is not recognized`,
    );
  }

  const scopes = canonicalScopes(resource, request.scopes);
  const audience = scopes.includes("openid")
    ? ([resource.identifier, `${fragment.authorizationServer}/oauth2/userinfo`] satisfies [
        string,
        string,
      ])
    : resource.identifier;

  return {
    resource: resource.identifier,
    resources: [resource.identifier],
    scopes,
    audience,
    issueRefreshToken: false,
  };
}
