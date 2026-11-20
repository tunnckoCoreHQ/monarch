import {
  BASE_API_URL,
  checkExists,
  estimateDataCost,
  getAllEthscriptions,
  getDigestForData,
  getEthscriptionById,
  getEthscriptionDetailed,
  getHeaders,
  getPrices,
  getUserCreatedEthscritions,
  getUserOwnedEthscriptions,
  getUserProfile,
  resolveUser,
  searchParamsToOptions,
} from "@tunnckocore/ethscriptions-core";
import type { EnumAllDetailed } from "@tunnckocore/ethscriptions-core";
import type { Context } from "hono";
import { env as runtimeEnv } from "hono/adapter";
import { z } from "zod";

import { ENDPOINTS } from "./endpoints-docs";
import { toHonoHandler, validate } from "./helpers";
import type { App } from "./helpers";
import {
  BigIntFromHashSchema,
  booleanSchema,
  DataURISchema,
  FilterSchema,
  HashSchema,
  IdSchema,
  UserSchema,
} from "./schemas";

export const REPOSITORY_URL = "https://github.com/tunnckoCoreHQ/monarch";
export const SOURCE_URL = `${REPOSITORY_URL}/tree/master/packages/ethscriptions-server`;

export type RoutesOptions = {
  // The home page title and heading.
  title?: string;
};

const costSettings = {
  speed: z.union([z.literal("normal"), z.literal("fast")]).optional(),
  eth_price: z.coerce.number().optional(),
  gas_price: z.coerce.number().optional(),
  gas_fee: z.coerce.number().optional(),
  base_fee: z.coerce.number().optional(),
  buffer_fee: z.coerce.number().optional(),
  priority_fee: z.coerce.number().optional(),
};

// The build commit comes from COMMIT_SHA, and is "local" when it is missing.
export function getEnv(ctx: Context, key = "COMMIT_SHA"): string {
  const runtime: Record<string, unknown> = runtimeEnv(ctx);
  const value: unknown = ctx.env?.[key] ?? runtime[key];

  return typeof value === "string" && value !== "" ? value : "local";
}

function commitUrl(commit: string): string {
  return commit === "local" ? REPOSITORY_URL : `${REPOSITORY_URL}/commit/${commit}`;
}

// A validator answers 400 before the handler runs, so validated params are present.
function param(ctx: Context, name: string): string {
  return ctx.req.param(name) ?? "";
}

function endpointLink(entry: string): string {
  if (!entry) {
    return "";
  }

  const [key = "", desc] = entry.split(" - ");
  if (!key.startsWith("/")) {
    return `<h2>${key}</h2>`;
  }

  const example = /attach|blob/i.test(key)
    ? key.replace(":id", "5743259")
    : key.replace("/ethscriptions/:id", "/ethscriptions/302469");

  return `<span><a href="${example}"><code>${key}</code></a> ${desc ? ` - ${desc}` : ""}</span><br>`;
}

function homePage(title: string, commit: string): string {
  return `<html lang="en">
  <head>
    <meta charset="utf-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="viewport" content="width=device-width" />
    <meta name="generator" content="Hono/v4" />
    <title>${title}</title>
  </head>

  <body data-theme="dark" class="relative z-10 overflow-auto overflow-x-hidden bg-[#231631]">
      <div>
        <h1>${title}</h1>
        <p>Build: <a href="${commitUrl(commit)}">${commit}</a></p>
        <p>Source: <a href="${SOURCE_URL}">${SOURCE_URL}</a></p>
      </div>
      <div>${ENDPOINTS.map(endpointLink).join("")}</div><br><br>
  </body>
  </html>`;
}

export function withRoutes(app: App, baseURL = BASE_API_URL, options: RoutesOptions = {}): App {
  const title = options.title ?? "Calldata Ethscriptions API";

  app.get("/", (ctx) => ctx.html(homePage(title, getEnv(ctx))));

  app.get("/endpoints", (ctx) =>
    ctx.json({
      about: { source: SOURCE_URL, commit: getEnv(ctx) },
      endpoints: ENDPOINTS,
    }),
  );

  app.get(
    "/prices",
    toHonoHandler((ctx) => {
      const speed = ctx.req.query("speed");
      return getPrices(speed === "slow" || speed === "fast" ? speed : "normal");
    }),
  );

  app.all(
    "/optimize/:modifiers/:data{.+}",
    validate(
      "param",
      z
        .object({
          data: DataURISchema.or(z.string().url()),
          modifiers: z.string(),
        })
        .strict(),
    ),
    async (ctx) => {
      const modifiers = param(ctx, "modifiers");
      const url = new URL(ctx.req.url);
      const upstreamUrl = new URL(url.pathname.replace("/optimize", ""), "https://ipx.wgw.lol");

      if (
        /basic|multiple/i.test(modifiers) &&
        !/f_webp/i.test(modifiers) &&
        ctx.req.method === "POST"
      ) {
        const contentType = ctx.req.header("content-type") ?? "";
        const isFormData = contentType.includes("multipart/form-data");
        if (!isFormData && !contentType.includes("application/json")) {
          return new Response("Expected JSON or form-data", { status: 400 });
        }

        const body = isFormData ? await ctx.req.formData() : await ctx.req.text();
        const resp = await fetch(upstreamUrl, {
          method: "POST",
          body,
          headers: ctx.req.raw.headers,
        });

        return new Response(new Uint8Array(await resp.arrayBuffer()), {
          headers: getHeaders(3600 * 24 * 7, {
            "content-type": String(resp.headers.get("content-type")),
          }),
        });
      }

      return fetch(upstreamUrl);
    },
  );

  app.get(
    "/estimate/:data",
    validate("param", z.object({ data: DataURISchema })),
    validate("query", z.object(costSettings).strict()),
    toHonoHandler((ctx) => {
      const { searchParams } = new URL(ctx.req.url);
      const settings = Object.fromEntries(
        [...searchParams.entries()].map(([key, value]) => {
          const val = Number(value);
          return [key, Number.isNaN(val) ? value : val || 0];
        }),
      );

      return estimateDataCost(param(ctx, "data"), settings);
    }),
  );

  app.post(
    "/estimate",
    validate("json", z.object({ data: DataURISchema, ...costSettings }).strict()),
    toHonoHandler(async (ctx) => {
      const { data, ...settings } = z
        .object({ data: z.string(), ...costSettings })
        .parse(await ctx.req.json());

      return estimateDataCost(data, settings);
    }),
  );

  app.get(
    "/sha/:data?",
    validate("param", z.object({ data: DataURISchema.optional() })),
    validate(
      "query",
      z.object({ data: DataURISchema.optional(), of: DataURISchema.optional() }).strict(),
    ),
    toHonoHandler((ctx) => {
      const input = ctx.req.param("data") || ctx.req.query("of") || ctx.req.query("data") || "";
      return getDigestForData(input, { checkExists: true, baseURL });
    }),
  );

  const shaBody = z
    .object({
      data: DataURISchema,
      checkExists: z.coerce.boolean().or(z.literal(1)).optional(),
    })
    .strict();

  app.post(
    "/sha",
    validate("json", shaBody),
    toHonoHandler(async (ctx) => {
      const { data, ...settings } = z
        .object({ data: z.string(), checkExists: shaBody.shape.checkExists })
        .parse(await ctx.req.json());

      return getDigestForData(data, { ...settings, baseURL });
    }),
  );

  for (const path of ["/check/:sha", "/exists/:sha"]) {
    app.get(
      path,
      validate("param", z.object({ sha: HashSchema })),
      toHonoHandler((ctx) => checkExists(param(ctx, "sha"), { baseURL })),
    );
  }

  app.get(
    "/resolve/:name",
    validate("param", z.object({ name: UserSchema })),
    validate(
      "query",
      z
        .object({ checkCreator: booleanSchema.optional(), creator: booleanSchema.optional() })
        .strict(),
    ),
    toHonoHandler((ctx) => {
      const checkCreator =
        ctx.req.query("creator") === "true" || ctx.req.query("checkCreator") === "true";
      return resolveUser(param(ctx, "name"), { checkCreator, baseURL });
    }),
  );

  app.get(
    "/profiles/:name",
    validate("param", z.object({ name: UserSchema })),
    toHonoHandler((ctx) => getUserProfile(param(ctx, "name"), { baseURL })),
  );

  app.get(
    "/profiles/:name/:mode",
    validate(
      "param",
      z.object({
        name: UserSchema,
        mode: z.union([z.literal("created"), z.literal("owned")]),
      }),
    ),
    // Not strict: the query passes through to the upstream API.
    validate("query", FilterSchema),
    toHonoHandler((ctx) => {
      const { searchParams } = new URL(ctx.req.url);
      const settings = { ...searchParamsToOptions(searchParams), baseURL };
      const name = param(ctx, "name");

      return param(ctx, "mode") === "created"
        ? getUserCreatedEthscritions(name, settings)
        : getUserOwnedEthscriptions(name, settings);
    }),
  );

  // Ordinals-like `/content/:id`, where "id" is an ethscription number, a transaction hash, or
  // the hash as a BigInt. An ERC721 token can then set `esc://content/` as its baseURI and append
  // the tokenId. The BigInt id is permanent like the hash; ethscription numbers can differ between
  // indexers, because they only show the order of the transaction in the protocol.
  //
  // - /content/3305568362307615822298477236865643378946845502932415825777752632693561433502
  // - /content/0x074ee2a9028840b3aa8962a2eec5560f5b0a5dbfe10e67c9685057d419371d9e
  // - /content/498087
  // - /content/498,087
  app.get(
    "/content/:id",
    validate("param", z.object({ id: z.union([IdSchema, BigIntFromHashSchema]) })),
    toHonoHandler((ctx) =>
      getEthscriptionDetailed(toEthscriptionId(param(ctx, "id")), "content", { baseURL }),
    ),
  );

  // Hono has no plain regex routes like `/(ethscriptions|eths)`, so this uses a named regex
  // param. It serves /ethscriptions, /eths, /blobscriptions, and /blobs, each with an optional
  // `/:id` and `/:id/:mode`, like `/ethscriptions/:id/owners` or `/blobs/:id/content`.
  app.get(
    "/:type{(blobscriptions|blobs|ethscriptions|eths)+}/:id?/:mode?",
    validate(
      "param",
      z
        .object({
          type: z.union([
            z.literal("ethscriptions"),
            z.literal("eths"),
            z.literal("blobscriptions"),
            z.literal("blobs"),
          ]),
          id: z.union([IdSchema, BigIntFromHashSchema]).optional(),
          mode: z
            .union([
              z.literal("meta"),
              z.literal("data"),
              z.literal("metadata"),
              z.literal("content"),
              z.literal("transfer"),
              z.literal("transfers"),
              z.literal("index"),
              z.literal("number"),
              z.literal("numbers"),
              z.literal("stats"),
              z.literal("info"),
              z.literal("owner"),
              z.literal("owners"),
              z.literal("creator"),
              z.literal("receiver"),
              z.literal("previous"),
              z.literal("initial"),
              z.literal("initial_owner"),
              z.literal("current_owner"),
              z.literal("previous_owner"),
              z.literal("attachment"),
              z.literal("blob"),
            ])
            .optional(),
        })
        .strict(),
    ),
    // Not strict: the query passes through to the upstream API.
    validate("query", FilterSchema),
    toHonoHandler((ctx) => {
      const settings = { baseURL, ...searchParamsToOptions(new URL(ctx.req.url).searchParams) };

      const id = ctx.req.param("id");
      if (!id) {
        return getAllEthscriptions(
          param(ctx, "type").includes("blob")
            ? { ...settings, attachment_present: true }
            : settings,
        );
      }

      const mode = ctx.req.param("mode");
      if (!mode) {
        return getEthscriptionById(toEthscriptionId(id), settings);
      }

      // SAFETY: the param validator limits mode to these names, and the library matches each
      // mode by pattern, so the owner aliases resolve too.
      return getEthscriptionDetailed(toEthscriptionId(id), mode as EnumAllDetailed, settings);
    }),
  );

  return app;
}

// Turns a BigInt id into its 0x-prefixed transaction hash, and drops number separators.
function toEthscriptionId(id: string): string {
  if (!BigIntFromHashSchema.safeParse(id).success) {
    return id.replaceAll(",", "");
  }

  // The padStart keeps hashes that start with 0, like the one of ethscription 5707:
  // 0x074ee2a9028840b3aa8962a2eec5560f5b0a5dbfe10e67c9685057d419371d9e.
  return `0x${BigInt(id).toString(16).padStart(64, "0")}`;
}
