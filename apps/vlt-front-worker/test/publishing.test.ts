import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWTPayload } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Env } from "../src/env";
import app from "../src/index";

const env: Env = {
  ALLOWED_GITHUB_LOGIN: "tunnckoCore",
  COMMIT_SHA: "local",
  READ_TOKEN: "read-service-token",
  WRITE_TOKEN: "write-service-token",
  UPSTREAM_URL: "https://registry.vlt.io/tunnckocore/main/",
};
const claims: JWTPayload = {
  iss: "https://identity.depot.dev",
  aud: "npm:npm.wgw.lol",
  sub: "spiffe://identity.depot.dev/org/pcnr2v598s/ci/github/tunnckoCoreHQ/monarch/ref/refs/heads/master/sandbox/snd_test",
  org_id: "pcnr2v598s",
  repository: "tunnckoCoreHQ/monarch",
  repository_id: "1299813376",
  repository_owner_id: "51462759",
  ref: "refs/heads/master",
  workflow_ref: "tunnckoCoreHQ/monarch/.depot/workflows/nightly.yml@refs/heads/master",
  event_name: "workflow_run",
};
const exchangeUrl = "https://npm.wgw.lol/-/npm/v1/oidc/token/exchange/package/@tunnckocore%2fcalc";
let privateKey: CryptoKey;
let jwks: { keys: object[] };
const upstream = vi.fn();

beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  privateKey = pair.privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "depot-test", alg: "ES256" }] };
});

beforeEach(() => {
  upstream.mockReset();
  upstream.mockResolvedValue(new Response("{}", { status: 201 }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://identity.depot.dev/keys") {
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
    .setProtectedHeader({ alg: "ES256", kid: "depot-test" })
    .setIssuedAt()
    .setExpirationTime(overrides.exp ?? "5m")
    .sign(key);
}

function latestToken() {
  return token({
    workflow_ref: "tunnckoCoreHQ/monarch/.depot/workflows/publish.yml@refs/heads/master",
  });
}

function exchange(bearer: string | undefined, url = exchangeUrl) {
  return app.request(
    url,
    { method: "POST", headers: bearer ? { authorization: `Bearer ${bearer}` } : {} },
    env,
  );
}

function publish(
  bearer: string,
  tag = "nightly",
  version = "0.1.3-nightly.20260904234045.abcdef0",
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

function setDistTag(bearer: string, tag: string, version: string) {
  return app.request(
    `https://npm.wgw.lol/-/package/@tunnckocore%2fcalc/dist-tags/${tag}`,
    {
      method: "PUT",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify(version),
    },
    env,
  );
}

const invalidClaims: JWTPayload[] = [
  { workflow_ref: undefined },
  { workflow_ref: "tunnckoCoreHQ/monarch/.depot/workflows/ci.yml@refs/heads/master" },
  { workflow_ref: "tunnckoCoreHQ/monarch/.depot/workflows/release.yml@refs/heads/master" },
  { workflow_ref: "tunnckoCoreHQ/monarch/.depot/workflows/nightly.yml@refs/heads/feature" },
  { workflow_ref: "attacker/monarch/.depot/workflows/nightly.yml@refs/heads/master" },
  { repository: "attacker/monarch" },
  { repository_id: "123" },
  { repository_owner_id: "123" },
  { ref: "refs/heads/feature" },
  { ref: "refs/pull/1/merge" },
  { org_id: "org_other" },
  {
    sub: "spiffe://identity.depot.dev/org/org_other/ci/github/tunnckoCoreHQ/monarch/ref/refs/heads/master/sandbox/snd_test",
  },
  {
    sub: "spiffe://identity.depot.dev/org/pcnr2v598s/ci/github/tunnckoCoreHQ/monarch/ref/refs/heads/feature/sandbox/snd_test",
  },
  { iss: "https://token.actions.githubusercontent.com" },
  { iss: "https://attacker.example" },
  { aud: "https://npm.wgw.lol" },
  { aud: "npm:registry.npmjs.org" },
  { exp: 1 },
];

describe("OIDC token exchange", () => {
  it("returns the verified Depot token for a scoped package", async () => {
    const bearer = await token();
    const response = await exchange(bearer);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: bearer });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("issues a token that the publish route accepts", async () => {
    const { token: exchanged } = (await (await exchange(await token())).json()) as {
      token: string;
    };
    expect((await publish(exchanged)).status).toBe(201);
    expect(upstream.mock.calls[0][1].headers.get("authorization")).toBe(
      "Bearer write-service-token",
    );
  });

  it.each(invalidClaims)("rejects invalid identity claims %j", async (overrides) => {
    expect((await exchange(await token(overrides))).status).toBe(401);
  });

  it("rejects a missing bearer and a forged signature", async () => {
    expect((await exchange(undefined)).status).toBe(401);
    const forged = await generateKeyPair("ES256");
    expect((await exchange(await token({}, forged.privateKey))).status).toBe(401);
  });

  it("knows only @tunnckocore packages", async () => {
    const bearer = await token();
    for (const name of ["calc", "@other%2fcalc", "@tunnckocore%2f..%2fcalc"]) {
      const response = await exchange(bearer, `${exchangeUrl.replace(/[^/]+$/, "")}${name}`);
      expect(response.status).toBe(404);
    }
  });
});

describe("package visibility", () => {
  it("reports scoped packages as not public so pnpm skips provenance", async () => {
    const response = await app.request(
      "https://npm.wgw.lol/-/package/@tunnckocore%2fcalc/visibility",
      { method: "GET" },
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ public: false });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("knows only @tunnckocore packages", async () => {
    for (const name of ["calc", "@other%2fcalc"]) {
      const response = await app.request(
        `https://npm.wgw.lol/-/package/${name}/visibility`,
        { method: "GET" },
        env,
      );
      expect(response.status).toBe(404);
    }
  });
});

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

  it("lets publish.yml publish stable versions as latest", async () => {
    expect((await publish(await latestToken(), "latest", "0.1.3")).status).toBe(201);
    expect((await setDistTag(await latestToken(), "latest", "0.1.3")).status).toBe(201);
  });

  it("accepts the short workflow_ref form from the Depot docs", async () => {
    const short = await token({
      workflow_ref: "tunnckoCoreHQ/monarch/nightly.yml@refs/heads/master",
    });
    expect((await publish(short)).status).toBe(201);
  });

  it("keeps nightly.yml away from latest and publish.yml away from nightly", async () => {
    expect((await publish(await token(), "latest", "0.1.3")).status).toBe(403);
    expect((await setDistTag(await token(), "latest", "0.1.3")).status).toBe(403);
    expect((await publish(await latestToken())).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(invalidClaims)("rejects invalid identity claims %j", async (overrides) => {
    expect((await publish(await token(overrides))).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects a forged signature", async () => {
    const forged = await generateKeyPair("ES256");
    expect((await publish(await token({}, forged.privateKey))).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("does not depend on the triggering event", async () => {
    expect((await publish(await token({ event_name: "workflow_dispatch" }))).status).toBe(201);
  });

  it("prevents a prerelease from reaching latest", async () => {
    expect((await publish(await latestToken(), "latest")).status).toBe(403);
    expect(
      (await setDistTag(await latestToken(), "latest", "0.1.3-nightly.1.abcdef0")).status,
    ).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("prevents a stable version from reaching nightly", async () => {
    expect((await publish(await token(), "nightly", "0.1.3")).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("prevents CI tokens from writing other dist-tags", async () => {
    expect((await publish(await latestToken(), "beta", "0.1.3")).status).toBe(403);
    expect((await setDistTag(await latestToken(), "beta", "0.1.3")).status).toBe(403);
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
