import { createRemoteJWKSet, jwtVerify } from "jose";

const githubKeys = createRemoteJWKSet(
  new URL("https://token.actions.githubusercontent.com/.well-known/jwks"),
);
const repository = "tunnckoCoreHQ/monarch";
const repositoryId = "1299813376";
const repositoryOwnerId = "51462759";

// Package managers request the GitHub OIDC token with audience `npm:<registry host>` and
// exchange it at the registry; see the exchange route in index.ts.
export const publishAudience = "npm:npm.wgw.lol";

export type PublishTag = "nightly" | "latest";

// The GitHub environment declared on the publishing job decides which dist-tag it may write.
export async function verifyPublishToken(token: string): Promise<PublishTag> {
  const { payload } = await jwtVerify(token, githubKeys, {
    issuer: "https://token.actions.githubusercontent.com",
    audience: publishAudience,
    algorithms: ["RS256"],
    requiredClaims: ["exp", "iat", "nbf", "sub", "environment"],
    maxTokenAge: "10m",
  });

  if (
    payload.repository !== repository ||
    payload.repository_id !== repositoryId ||
    payload.repository_owner_id !== repositoryOwnerId ||
    payload.ref !== "refs/heads/master"
  ) {
    throw new Error("Untrusted publishing repository or ref");
  }

  if (payload.environment === "nightly" || payload.environment === "latest") {
    return payload.environment;
  }

  throw new Error("Untrusted publishing environment");
}

export async function validatePublishRequest(
  request: Request,
  path: string,
  tag: PublishTag,
): Promise<boolean> {
  if (request.method !== "PUT") {
    return false;
  }

  const versionPattern =
    tag === "nightly" ? /^\d+\.\d+\.\d+-nightly\.[\da-z.-]+$/ : /^\d+\.\d+\.\d+$/;
  const body: unknown = await request.clone().json();
  if (path.startsWith("/-/package/")) {
    return (
      new RegExp(`^/-/package/@tunnckocore/[a-z0-9][a-z0-9._-]*/dist-tags/${tag}$`).test(path) &&
      typeof body === "string" &&
      versionPattern.test(body)
    );
  }

  if (!/^\/@tunnckocore\/[a-z0-9][a-z0-9._-]*$/.test(path)) {
    return false;
  }
  if (
    typeof body !== "object" ||
    body === null ||
    !("versions" in body) ||
    !("dist-tags" in body)
  ) {
    return false;
  }

  const versions = body.versions;
  const tags = body["dist-tags"];
  if (
    typeof versions !== "object" ||
    versions === null ||
    typeof tags !== "object" ||
    tags === null
  ) {
    return false;
  }

  const entries = Object.entries(tags);
  return (
    entries.length === 1 &&
    entries[0][0] === tag &&
    typeof entries[0][1] === "string" &&
    versionPattern.test(entries[0][1]) &&
    Object.keys(versions).length === 1 &&
    Object.keys(versions)[0] === entries[0][1]
  );
}
