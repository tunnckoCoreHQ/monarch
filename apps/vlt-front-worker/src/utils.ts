import { createRemoteJWKSet, jwtVerify } from "jose";

const depotKeys = createRemoteJWKSet(new URL("https://identity.depot.dev/keys"));
const repository = "tunnckoCoreHQ/monarch";
const repositoryId = "1299813376";
const repositoryOwnerId = "51462759";
const depotOrgId = "pcnr2v598s";
const subjectPrefix = `spiffe://identity.depot.dev/org/${depotOrgId}/ci/github/${repository}/ref/refs/heads/master/sandbox/`;

// Package managers request the Depot CI OIDC token with audience `npm:<registry host>` and
// exchange it at the registry; see the exchange route in index.ts.
export const publishAudience = "npm:npm.wgw.lol";

export type PublishTag = "nightly" | "latest";

// Depot CI tokens have no environment claim, so the workflow file decides the dist-tag:
// nightly.yml may write nightly and publish.yml may write latest. GitHub formats workflow_ref as
// owner/repo/.github/workflows/file.yml@ref; Depot's documented example omits the directory, so
// both forms are accepted.
const workflowTags: Record<string, PublishTag> = { nightly: "nightly", publish: "latest" };
const workflowRef = new RegExp(
  `^${repository}/(?:\\.depot/workflows/)?(nightly|publish)\\.yml@refs/heads/master$`,
);

const versionPatterns: Record<PublishTag, RegExp> = {
  nightly: /^\d+\.\d+\.\d+-nightly\.[\da-z.-]+$/,
  latest: /^\d+\.\d+\.\d+$/,
};

export async function verifyPublishToken(token: string): Promise<PublishTag> {
  const { payload } = await jwtVerify(token, depotKeys, {
    issuer: "https://identity.depot.dev",
    audience: publishAudience,
    algorithms: ["ES256", "ES384", "RS256"],
    requiredClaims: ["exp", "iat", "sub", "workflow_ref"],
    maxTokenAge: "10m",
  });

  if (
    payload.repository !== repository ||
    payload.repository_id !== repositoryId ||
    payload.repository_owner_id !== repositoryOwnerId ||
    payload.ref !== "refs/heads/master" ||
    payload.org_id !== depotOrgId ||
    typeof payload.sub !== "string" ||
    !payload.sub.startsWith(subjectPrefix)
  ) {
    throw new Error("Untrusted publishing organization, repository, or ref");
  }

  const workflow =
    typeof payload.workflow_ref === "string" ? workflowRef.exec(payload.workflow_ref)?.[1] : null;
  if (!workflow) {
    throw new Error("Untrusted publishing workflow");
  }
  return workflowTags[workflow];
}

export async function validatePublishRequest(
  request: Request,
  path: string,
  tag: PublishTag,
): Promise<boolean> {
  if (request.method !== "PUT") {
    return false;
  }

  const versionPattern = versionPatterns[tag];
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
