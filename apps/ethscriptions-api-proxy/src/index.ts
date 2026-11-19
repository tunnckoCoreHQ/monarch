import { createApp, withRoutes } from "ethscriptions-server";

import type { Env } from "./env";

const SOURCE_URL =
  "https://github.com/tunnckoCoreHQ/monarch/tree/master/apps/ethscriptions-api-proxy";

const networks = {
  mainnet: withRoutes(createApp()),
  sepolia: withRoutes(createApp(), "https://sepolia-api-v2.ethscriptions.com"),
};

type Network = keyof typeof networks;

// The sepolia-api host and the /sepolia prefix serve Sepolia; everything else is mainnet.
function resolveNetwork(url: URL): { network: Network; pathname: string } {
  const sepolia = stripPrefix(url.pathname, "/sepolia");
  if (url.hostname === "sepolia-api.calldata.space" || sepolia !== undefined) {
    return { network: "sepolia", pathname: sepolia ?? url.pathname };
  }

  return { network: "mainnet", pathname: stripPrefix(url.pathname, "/mainnet") ?? url.pathname };
}

function stripPrefix(pathname: string, prefix: string): string | undefined {
  if (pathname === prefix) {
    return "/";
  }
  if (pathname.startsWith(`${prefix}/`)) {
    return pathname.slice(prefix.length);
  }

  return undefined;
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/llms.txt") {
    return llmsTxt(request, env);
  }

  const { network, pathname } = resolveNetwork(url);
  url.pathname = pathname;

  const response = await networks[network].fetch(new Request(url, request), serverEnv(env));
  if (network === "sepolia" && pathname === "/" && response.ok) {
    return retitle(response, "Calldata API (Sepolia)");
  }

  return response;
}

// The server shows the build commit from this variable, and "local" when it is missing.
function serverEnv(env: Env) {
  return { VERCEL_GIT_COMMIT_SHA: env.COMMIT_SHA };
}

async function retitle(response: Response, title: string): Promise<Response> {
  const html = (await response.text()).replace(
    "<title>Calldata API</title>",
    `<title>${title}</title>`,
  );

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("etag");

  return new Response(html, { status: response.status, headers });
}

async function llmsTxt(request: Request, env: Env): Promise<Response> {
  const url = new URL("/endpoints", request.url);
  const response = await networks.mainnet.fetch(new Request(url, request), serverEnv(env));
  // SAFETY: the server's /endpoints route always answers with this JSON object.
  const data: { endpoints?: string[] } = await response.json();

  const lines = [
    "# Calldata API",
    "",
    "API for Ethscriptions, Blobscriptions, calldata utilities, profiles, ENS/name resolution, content, metadata, and related helpers.",
    "",
    `Source: ${SOURCE_URL}`,
    `Build: ${env.COMMIT_SHA}`,
    "",
    "## Base URLs",
    "",
    "- Mainnet: https://api.calldata.space",
    "- Mainnet alias: https://api.calldata.space/mainnet",
    "- Sepolia: https://api.calldata.space/sepolia",
    "- Sepolia alias: https://sepolia-api.calldata.space",
    "",
    "## Endpoint index",
    "",
  ];

  for (const endpoint of (data.endpoints ?? []).filter(Boolean)) {
    if (endpoint.startsWith("/")) {
      lines.push(`- ${endpoint}`);
    } else {
      lines.push("", `### ${endpoint}`, "");
    }
  }

  return new Response(`${lines.join("\n").trim()}\n`, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public,max-age=0,must-revalidate",
      "cdn-cache-control": "public,s-maxage=3600,must-revalidate",
    },
  });
}

// Workers responses skip the zone cache, so successful GETs go into the colo cache for the
// s-maxage the server sets in cdn-cache-control. Errors and 404s are never cached.
async function cached(request: Request, ctx: ExecutionContext, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return handle(request, env);
  }

  const cache = await caches.open("ethscriptions-api");
  const hit = await cache.match(request);
  if (hit) {
    return hit;
  }

  const response = await handle(request, env);
  const ttl = sharedMaxAge(response.headers.get("cdn-cache-control"));
  if (response.status === 200 && ttl > 0) {
    const copy = new Response(response.clone().body, response);
    copy.headers.set("cache-control", `public,max-age=0,s-maxage=${ttl},must-revalidate`);
    ctx.waitUntil(cache.put(request, copy));
  }

  return response;
}

function sharedMaxAge(header: string | null): number {
  return Number(/s-maxage=(\d+)/.exec(header ?? "")?.[1] ?? 0);
}

export default {
  fetch(request, env, ctx) {
    return cached(request, ctx, env);
  },
} satisfies ExportedHandler<Env>;
