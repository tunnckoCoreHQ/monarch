import { zValidator } from "@hono/zod-validator";
import type { Result } from "@tunnckocore/ethscriptions-core";
import { fileTypeFromBuffer } from "file-type";
import { Hono } from "hono";
import type { Context, MiddlewareHandler, ValidationTargets } from "hono";
import { cors } from "hono/cors";
import { etag } from "hono/etag";
import { trimTrailingSlash } from "hono/trailing-slash";
import type { ZodType } from "zod";

export type Bindings = {
  COMMIT_SHA?: string;
};

export type App = Hono<{ Bindings: Bindings }>;

// The result of the `@tunnckocore/ethscriptions-core` functions.
export type HandlerResult = Result<unknown>;

export function createApp(corsOptions?: Parameters<typeof cors>[0]): App {
  const app: App = new Hono();
  app.use(trimTrailingSlash());
  app.use(etag({ weak: true }));
  app.use(cors(corsOptions ?? { origin: "*" }));

  return app;
}

export function toHonoHandler(
  fn: (ctx: Context) => HandlerResult | Promise<HandlerResult>,
): MiddlewareHandler {
  return async (ctx) => {
    const resp = await fn(ctx);
    if (!resp.ok) {
      return json({ error: resp.error }, { status: resp.error.httpStatus ?? 500 });
    }

    const { result, pagination, headers } = resp;
    if (result instanceof Uint8Array) {
      const res = new Response(new Uint8Array(result), { headers });
      res.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
      const { mime = "" } = (await fileTypeFromBuffer(result)) ?? {};
      if (mime.includes("gzip")) {
        res.headers.set("Content-Encoding", "gzip");
      }

      return res;
    }

    return json(pagination ? { result, pagination } : { result }, { headers });
  };
}

function json(body: unknown, init: ResponseInit): Response {
  // oxlint-disable-next-line unicorn/prefer-response-static-json -- workerd serializes Response.json natively, so BigInt values throw; JSON.stringify writes them as numbers.
  const response = new Response(JSON.stringify(body), init);
  response.headers.set("Content-Type", "application/json");
  response.headers.set("Cross-Origin-Resource-Policy", "cross-origin");

  return response;
}

export function validate(target: keyof ValidationTargets, schema: ZodType): MiddlewareHandler {
  return zValidator(target, schema, (res, ctx) => {
    if (!res.success) {
      return ctx.json(
        {
          error: {
            message: "Failure in validation",
            httpStatus: 400,
            issues: res.error.issues,
          },
        },
        400,
      );
    }

    return undefined;
  });
}
