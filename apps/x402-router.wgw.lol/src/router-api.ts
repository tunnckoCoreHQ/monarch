import { fetch as routerFetch } from "@tunnckocore/x402-router";

const HEALTH_ENDPOINTS = new Set(["health", "healthz"]);

// Mirrors the router's own path handling so /health, /health/ and //health all count.
function endpointOf(request: Request): string {
  return new URL(request.url).pathname.replace(/^\/+|\/+$/g, "");
}

// The router package answers health checks; the app adds the commit it was built from.
export async function routerApi(request: Request): Promise<Response> {
  const response = await routerFetch(request);
  if (request.method !== "GET" || !response.ok || !HEALTH_ENDPOINTS.has(endpointOf(request))) {
    return response;
  }

  // SAFETY: the router answers health checks with a JSON object, checked by response.ok above.
  const body = (await response.json()) as Record<string, unknown>;

  return new Response(JSON.stringify({ ...body, commit: import.meta.env.COMMIT_SHA }), response);
}
