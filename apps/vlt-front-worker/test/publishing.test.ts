import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWTPayload } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import app from "../src/index";

const env: Env = {
  ALLOWED_GITHUB_LOGIN: "tunnckoCore",
  READ_TOKEN: "read-service-token",
  WRITE_TOKEN: "write-service-token",
  UPSTREAM_URL: "https://registry.vlt.io/tunnckocore/main/",
};
const claims: JWTPayload = {
  iss: "https://token.actions.githubusercontent.com",
  aud: "https://npm.wgw.lol",
  sub: "repo:tunnckoCoreHQ/monarch:ref:refs/heads/master",
  repository: "tunnckoCoreHQ/monarch",
  repository_id: "1299813376",
  repository_owner_id: "51462759",
  ref: "refs/heads/master",
  workflow_ref: "tunnckoCoreHQ/monarch/.github/workflows/typescript.yml@refs/heads/master",
  job_workflow_ref:
    "tunnckoCoreHQ/monarch/.github/workflows/packages-nightly.yml@refs/heads/master",
  event_name: "push",
};
let privateKey: CryptoKey;
let jwks: { keys: object[] };
const upstream = vi.fn();

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "github-test", alg: "RS256" }] };
});

beforeEach(() => {
  upstream.mockReset();
  upstream.mockResolvedValue(new Response("{}", { status: 201 }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://token.actions.githubusercontent.com/.well-known/jwks") {
        return Response.json(jwks);
      }
      if (String(input) === "https://api.github.com/user") {
        return Response.json({ login: "tunnckoCore" });
      }
      return upstream(input, init);
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

async function token(overrides: JWTPayload = {}, key = privateKey) {
  return new SignJWT({ ...claims, ...overrides })
    .setProtectedHeader({ alg: "RS256", kid: "github-test" })
    .setIssuedAt()
    .setNotBefore("0s")
    .setExpirationTime(overrides.exp ?? "5m")
    .sign(key);
}

function publish(
  bearer: string,
  tag = "nightly",
  version = "0.1.3-nightly.123.1.20260904.abcdef0",
) {
  return app.request(
    "https://npm.wgw.lol/@tunnckocore%2fcalc",
    {
      method: "PUT",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "@tunnckocore/calc",
        versions: { [version]: { name: "@tunnckocore/calc", version } },
        "dist-tags": { [tag]: version },
      }),
    },
    env,
  );
}

describe("CI publishing authorization", () => {
  it("verifies the signature and substitutes the worker token for a master nightly", async () => {
    expect((await publish(await token())).status).toBe(201);
    expect(upstream).toHaveBeenCalledOnce();
    expect(upstream.mock.calls[0][0].href).toBe(
      "https://registry.vlt.io/tunnckocore/main/@tunnckocore%2fcalc",
    );
    expect(upstream.mock.calls[0][1].headers.get("authorization")).toBe(
      "Bearer write-service-token",
    );
  });

  it("allows stable publishing after successful master checks", async () => {
    const bearer = await token({
      job_workflow_ref:
        "tunnckoCoreHQ/monarch/.github/workflows/packages-release.yml@refs/heads/master",
    });
    expect((await publish(bearer, "latest", "0.1.3")).status).toBe(201);
  });

  it.each([
    { repository: "attacker/monarch" },
    { repository_id: "123" },
    { repository_owner_id: "123" },
    { ref: "refs/heads/feature" },
    { event_name: "pull_request" },
    { event_name: "workflow_run" },
    { job_workflow_ref: undefined },
    { job_workflow_ref: "tunnckoCoreHQ/monarch/.github/workflows/other.yml@refs/heads/master" },
    {
      job_workflow_ref:
        "tunnckoCoreHQ/monarch/.github/workflows/packages-nightly.yml@refs/heads/feature",
    },
    { sub: "repo:tunnckoCoreHQ/monarch:pull_request" },
    { workflow_ref: "tunnckoCoreHQ/monarch/.github/workflows/other.yml@refs/heads/master" },
    { iss: "https://attacker.example" },
    { aud: "https://other.example" },
    { exp: 1 },
  ])("rejects invalid identity claims %j", async (overrides) => {
    expect((await publish(await token(overrides))).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects a forged signature", async () => {
    const forged = await generateKeyPair("RS256");
    expect((await publish(await token({}, forged.privateKey))).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("allows an automated master dispatch to publish nightly", async () => {
    expect((await publish(await token({ event_name: "workflow_dispatch" }))).status).toBe(201);
  });

  it("prevents a nightly token from modifying latest", async () => {
    expect((await publish(await token(), "latest", "0.1.3")).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("prevents a stable workflow from publishing a prerelease as latest", async () => {
    const bearer = await token({
      job_workflow_ref:
        "tunnckoCoreHQ/monarch/.github/workflows/packages-release.yml@refs/heads/master",
    });
    expect((await publish(bearer, "latest")).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("prevents CI tokens from deleting packages", async () => {
    const response = await app.request(
      "https://npm.wgw.lol/@tunnckocore%2fcalc",
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${await token()}` },
      },
      env,
    );
    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("keeps local GitHub token publishing available", async () => {
    expect((await publish("gho_local_cli_token", "latest", "0.1.3")).status).toBe(201);
    expect(upstream.mock.calls[0][1].headers.get("authorization")).toBe(
      "Bearer write-service-token",
    );
  });
});
