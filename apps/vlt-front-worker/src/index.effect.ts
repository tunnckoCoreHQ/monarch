import { Context, Effect, Layer, Schema } from "effect";

const GitHubProfile = Schema.Struct({ login: Schema.String });

interface GitHubProfile extends Schema.Schema.Type<typeof GitHubProfile> {}

class ProxyError extends Schema.TaggedError<ProxyError>()("VltProxy.ProxyError", {
  operation: Schema.String,
  status: Schema.Number,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

interface FetcherInterface {
  readonly send: (
    operation: string,
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Effect.Effect<Response, ProxyError>;
}

class Fetcher extends Context.Service<Fetcher, FetcherInterface>()("VltProxy.Fetcher") {}

const send = Effect.fn("VltProxy.send")(function* (
  operation: string,
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  return yield* Effect.tryPromise({
    try: (signal) => fetch(input, { ...init, signal }),
    catch: (cause) =>
      new ProxyError({
        operation,
        status: 502,
        message: `${operation} failed`,
        cause,
      }),
  });
});

const FetcherLive = Layer.succeed(Fetcher, Fetcher.of({ send }));

const handle = Effect.fn("VltProxy.handle")(function* (request: Request, env: Env) {
  const fetcher = yield* Fetcher;
  const url = new URL(request.url);
  const path = yield* Effect.try({
    try: () => decodeURIComponent(url.pathname),
    catch: (cause) =>
      new ProxyError({
        operation: "VltProxy.route",
        status: 404,
        message: "Not found",
        cause,
      }),
  });

  const isPackagePath = /^\/@tunnckocore\/[a-z0-9][a-z0-9._-]*(?:\/.*)?$/.test(path);
  const isDistTagPath =
    /^\/-\/package\/@tunnckocore\/[a-z0-9][a-z0-9._-]*\/dist-tags(?:\/.*)?$/.test(path);
  const hasTraversal = path.split("/").some((segment) => segment === "." || segment === "..");

  if ((!isPackagePath && !isDistTagPath) || hasTraversal) {
    return yield* Effect.fail(
      new ProxyError({ operation: "VltProxy.route", status: 404, message: "Not found" }),
    );
  }

  const isRead = request.method === "GET" || request.method === "HEAD";
  const isWrite =
    request.method === "PUT" || request.method === "POST" || request.method === "DELETE";

  if (!isRead && !isWrite) {
    return yield* Effect.fail(
      new ProxyError({
        operation: "VltProxy.route",
        status: 405,
        message: "Method not allowed",
      }),
    );
  }

  let token: string;
  if (isRead) {
    token = env.READ_TOKEN;
  } else {
    const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!bearer) {
      return yield* Effect.fail(
        new ProxyError({ operation: "VltProxy.authorize", status: 401, message: "Unauthorized" }),
      );
    }

    const github = yield* fetcher.send("VltProxy.authorize", "https://api.github.com/user", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${bearer}`,
        "user-agent": "vlt-front-worker-effect",
        "x-github-api-version": "2026-03-10",
      },
    });
    if (github.status === 401) {
      return yield* Effect.fail(
        new ProxyError({ operation: "VltProxy.authorize", status: 401, message: "Unauthorized" }),
      );
    }
    if (!github.ok) {
      return yield* Effect.fail(
        new ProxyError({
          operation: "VltProxy.authorize",
          status: 502,
          message: "GitHub authorization unavailable",
        }),
      );
    }

    const json = yield* Effect.tryPromise({
      try: () => github.json(),
      catch: (cause) =>
        new ProxyError({
          operation: "VltProxy.decodeGitHubProfile",
          status: 502,
          message: "GitHub authorization unavailable",
          cause,
        }),
    });
    const profile: GitHubProfile = yield* Schema.decodeUnknownEffect(GitHubProfile)(json).pipe(
      Effect.mapError(
        (cause) =>
          new ProxyError({
            operation: "VltProxy.decodeGitHubProfile",
            status: 502,
            message: "GitHub authorization unavailable",
            cause,
          }),
      ),
    );
    if (profile.login.toLowerCase() !== env.ALLOWED_GITHUB_LOGIN.toLowerCase()) {
      return yield* Effect.fail(
        new ProxyError({ operation: "VltProxy.authorize", status: 403, message: "Forbidden" }),
      );
    }

    token = env.WRITE_TOKEN;
  }

  const upstreamPath = isDistTagPath
    ? url.pathname.replace(/(%40|@)tunnckocore%2f/i, "$1tunnckocore%252F")
    : url.pathname;
  const upstream = new URL(upstreamPath.replace(/^\/+/, ""), env.UPSTREAM_URL);
  upstream.search = url.search;

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.set("authorization", `Bearer ${token}`);

  const isTarball = path.includes("/-/") && path.endsWith(".tgz");
  const response = yield* fetcher.send("VltProxy.forward", upstream, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "follow",
    cf:
      isRead && isTarball
        ? {
            cacheEverything: true,
            cacheTtl: 31_536_000,
          }
        : undefined,
  });

  if (!isRead || !response.ok) {
    return response;
  }

  const responseHeaders = new Headers(response.headers);
  responseHeaders.set(
    "cache-control",
    isTarball ? "public, max-age=31536000, immutable" : "public, max-age=60",
  );

  if (
    isTarball ||
    request.method === "HEAD" ||
    !response.headers.get("content-type")?.includes("json")
  ) {
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  }

  const body = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) =>
      new ProxyError({
        operation: "VltProxy.rewriteMetadata",
        status: 502,
        message: "Upstream response failed",
        cause,
      }),
  });
  responseHeaders.delete("content-length");
  responseHeaders.delete("etag");

  return new Response(body.replaceAll(env.UPSTREAM_URL, `${url.origin}/`), {
    status: response.status,
    headers: responseHeaders,
  });
});

export default {
  fetch(request, env): Promise<Response> {
    return Effect.runPromise(
      handle(request, env).pipe(
        Effect.provide(FetcherLive),
        Effect.catch((error) => {
          const headers = new Headers();
          if (error.status === 401) {
            headers.set("www-authenticate", `Bearer realm="${new URL(request.url).host}"`);
          } else if (error.status === 405) {
            headers.set("allow", "GET, HEAD, PUT, POST, DELETE");
          }

          return Effect.succeed(new Response(error.message, { status: error.status, headers }));
        }),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
