import { createRemoteJWKSet, jwtVerify } from "jose";

const githubKeys = createRemoteJWKSet(
  new URL("https://token.actions.githubusercontent.com/.well-known/jwks"),
);
const repository = "tunnckoCoreHQ/monarch";

export async function verifyPublishToken(token: string): Promise<"nightly" | "latest"> {
  const { payload } = await jwtVerify(token, githubKeys, {
    issuer: "https://token.actions.githubusercontent.com",
    audience: "https://npm.wgw.lol",
    algorithms: ["RS256"],
    requiredClaims: ["exp", "iat", "nbf", "sub"],
    maxTokenAge: "10m",
    subject: `repo:${repository}:ref:refs/heads/master`,
  });

  if (
    payload.repository !== repository ||
    payload.repository_id !== "1299813376" ||
    payload.repository_owner_id !== "51462759" ||
    payload.ref !== "refs/heads/master"
  ) {
    throw new Error("Untrusted publishing repository or ref");
  }

  if (
    payload.workflow_ref ===
      `${repository}/.github/workflows/packages-nightly.yml@refs/heads/master` &&
    payload.event_name === "workflow_run"
  ) {
    return "nightly";
  }

  if (
    payload.workflow_ref ===
      `${repository}/.github/workflows/packages-release.yml@refs/heads/master` &&
    payload.event_name === "workflow_run"
  ) {
    return "latest";
  }

  throw new Error("Untrusted publishing workflow or event");
}

export async function validatePublishRequest(
  request: Request,
  path: string,
  tag: "nightly" | "latest",
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
