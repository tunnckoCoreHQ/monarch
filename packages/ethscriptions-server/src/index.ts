import { BASE_API_URL } from "ethscriptions";
import { Hono } from "hono";
import { handle } from "hono/vercel";

import { createApp } from "./helpers";
import { withRoutes } from "./routes";
import { createBigIntToNumberStringify } from "./safe-json-stringify";

// The upstream responses carry BigInt values, so every JSON response writes them as numbers.
globalThis.JSON.stringify = createBigIntToNumberStringify();

export type CreateRouteHandlersType = {
  eths: ReturnType<typeof withRoutes>;
  app: Hono;
  baseURL?: string | null;
  prefix?: string | null;
  GET: ReturnType<typeof handle>;
  PUT: ReturnType<typeof handle>;
  POST: ReturnType<typeof handle>;
  PATCH: ReturnType<typeof handle>;
  DELETE: ReturnType<typeof handle>;
  OPTIONS: ReturnType<typeof handle>;
};

// Mounts the Ethscriptions routes under `prefix`, with one handler per HTTP method, for
// frameworks like Next.js. Pass another Hono adapter as `handler` for other platforms.
export function createRouteHandlers(
  baseURL?: string | null,
  prefix?: string | null,
  handler: typeof handle = handle,
): CreateRouteHandlersType {
  const eths = withRoutes(createApp(), baseURL || BASE_API_URL);
  const app = new Hono().basePath(prefix || "/");
  app.route("/", eths);

  return {
    eths,
    app,
    baseURL,
    prefix,
    GET: handler(app),
    PUT: handler(app),
    POST: handler(app),
    PATCH: handler(app),
    DELETE: handler(app),
    OPTIONS: handler(app),
  };
}

export { BASE_API_URL, CACHE_TTL } from "ethscriptions";
export { handle as honoVercelHandle } from "hono/vercel";

export { ENDPOINTS } from "./endpoints-docs";
export { createApp, toHonoHandler, validate } from "./helpers";
export type { App, Bindings, HandlerResult } from "./helpers";
export { getEnv, REPOSITORY_URL, SOURCE_URL, withRoutes } from "./routes";
export type { RoutesOptions } from "./routes";
export * from "./schemas";
