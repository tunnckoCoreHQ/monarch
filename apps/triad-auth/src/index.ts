import { AUTH_BASE_PATH, createTriadAuth } from "./better-auth/auth";
import { createTriadConfiguration } from "./better-auth/configuration";
import { canonicalDisclosureScopes } from "./better-auth/disclosures";
import type { TriadEnv } from "./better-auth/env";
import { createTriadResourceFragment } from "./better-auth/resources";
import { handleWalletBrokerRequest } from "./better-auth/wallet";

interface TriadAuthService {
  api: {
    getSession(input: { headers: Headers }): Promise<{ user: { id: string } } | null>;
    signJWT(input: { body: { payload: Record<string, unknown> } }): Promise<{ token: string }>;
  };
  handler(request: Request): Response | Promise<Response>;
}

interface WorkerServices<Configuration> {
  createTriadConfiguration(env: TriadEnv): Configuration;
  createTriadAuth(env: TriadEnv, configuration: Configuration): TriadAuthService;
  handleWalletBroker(request: Request, env: TriadEnv, auth: TriadAuthService): Promise<Response>;
  handleAstro(request: Request, env: TriadEnv, context: ExecutionContext): Promise<Response>;
  fetchAssets(request: Request, env: TriadEnv): Promise<Response>;
}

interface DeviceDisclosureRecord {
  scope: string | null;
}

const DEVICE_DISCLOSURE_PATH = `${AUTH_BASE_PATH}/device/disclosure`;
const WALLET_API_BASE_PATH = "/api/wallet";
const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self'",
    "connect-src 'self'",
  ].join("; "),
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
};

export function isAuthPath(pathname: string): boolean {
  return pathname === AUTH_BASE_PATH || pathname.startsWith(`${AUTH_BASE_PATH}/`);
}

function crossOriginOpenerPolicy(pathname: string): "same-origin" | "unsafe-none" {
  if (isAuthPath(pathname) || pathname === "/consent" || pathname === "/consent/") {
    return "unsafe-none";
  }

  return "same-origin";
}

function protectedResourceDocument(url: URL, env: TriadEnv) {
  if (!url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
    return undefined;
  }

  const fragment = createTriadResourceFragment(env);

  return fragment.protectedResourceMetadata.find(({ metadataUrl }) => metadataUrl === url.href)
    ?.document;
}

function withSecurityHeaders(response: Response, env: TriadEnv, pathname: string): Response {
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    secured.headers.set(name, value);
  }
  secured.headers.set("cross-origin-opener-policy", crossOriginOpenerPolicy(pathname));

  try {
    if (new URL(env.AUTH_ORIGIN).protocol === "https:") {
      secured.headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
    }
  } catch {
    // Authentication configuration validates AUTH_ORIGIN on authenticated routes.
  }

  return secured;
}

async function handleDeviceDisclosure(
  request: Request,
  env: TriadEnv,
  auth: TriadAuthService,
): Promise<Response> {
  if (request.method !== "GET") {
    return new Response(null, { status: 405 });
  }

  const url = new URL(request.url);
  const userCodes = url.searchParams.getAll("user_code");
  const userCode = userCodes.length === 1 ? userCodes[0]!.replaceAll("-", "").toUpperCase() : "";
  if (!/^[A-Z0-9]{8}$/.test(userCode)) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user.id) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const record = await env.DB.prepare(
    'select "scope" from "deviceCode" where "userCode" = ? and "userId" = ? and "status" = \'pending\'',
  )
    .bind(userCode, session.user.id)
    .first<DeviceDisclosureRecord>();
  if (!record) {
    return Response.json({ error: "invalid_request" }, { status: 404 });
  }

  let scopes;
  try {
    scopes = canonicalDisclosureScopes(record.scope?.split(" ") ?? []);
  } catch {
    return Response.json({ error: "invalid_scope" }, { status: 400 });
  }

  return Response.json(
    { scopes },
    {
      headers: {
        "cache-control": "no-store",
        pragma: "no-cache",
      },
    },
  );
}

export function createWorker<Configuration>(services: WorkerServices<Configuration>) {
  return {
    async fetch(request, env, context) {
      const url = new URL(request.url);
      const resourceDocument = protectedResourceDocument(url, env);
      if (resourceDocument) {
        return withSecurityHeaders(Response.json(resourceDocument), env, url.pathname);
      }

      if (url.pathname === DEVICE_DISCLOSURE_PATH) {
        const configuration = services.createTriadConfiguration(env);
        const auth = services.createTriadAuth(env, configuration);

        return withSecurityHeaders(
          await handleDeviceDisclosure(request, env, auth),
          env,
          url.pathname,
        );
      }

      if (
        url.pathname === WALLET_API_BASE_PATH ||
        url.pathname.startsWith(`${WALLET_API_BASE_PATH}/`)
      ) {
        const configuration = services.createTriadConfiguration(env);
        const auth = services.createTriadAuth(env, configuration);

        return withSecurityHeaders(
          await services.handleWalletBroker(request, env, auth),
          env,
          url.pathname,
        );
      }

      if (isAuthPath(url.pathname)) {
        const configuration = services.createTriadConfiguration(env);
        const authResponse = await services.createTriadAuth(env, configuration).handler(request);

        return withSecurityHeaders(authResponse, env, url.pathname);
      }

      if (url.pathname.startsWith("/__astro_")) {
        return withSecurityHeaders(
          await services.handleAstro(request, env, context),
          env,
          url.pathname,
        );
      }

      return withSecurityHeaders(await services.fetchAssets(request, env), env, url.pathname);
    },
  } satisfies ExportedHandler<TriadEnv>;
}

export default createWorker({
  createTriadConfiguration,
  createTriadAuth,
  handleWalletBroker: handleWalletBrokerRequest,
  async handleAstro(request, env, context) {
    const { handle } = await import("@astrojs/cloudflare/handler");

    return handle(request, env, context);
  },
  fetchAssets(request, env) {
    return env.ASSETS.fetch(request);
  },
});
