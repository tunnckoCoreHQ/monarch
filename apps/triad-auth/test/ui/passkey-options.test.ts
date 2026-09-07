import { describe, expect, it } from "vite-plus/test";
import { decodeAuthenticationOptions, decodeRegistrationOptions } from "../../src/utils";

describe("Passkey option decoding", () => {
  it("preserves authentication restrictions and extensions", () => {
    const options = {
      challenge: "challenge",
      rpId: "auth.example.com",
      userVerification: "required",
      allowCredentials: [{ id: "credential", type: "public-key", transports: ["internal"] }],
      extensions: { prf: { eval: { first: "salt" } } },
    };
    expect(decodeAuthenticationOptions(options)).toEqual(options);
  });

  it.each([null, [], {}, { challenge: 1 }])("rejects an invalid challenge %j", (options) => {
    expect(() => decodeAuthenticationOptions(options)).toThrow(
      "invalid passkey authentication options",
    );
  });

  it("preserves registration options after checking the required fields", () => {
    const options = {
      challenge: "challenge",
      rp: { name: "Triad", id: "auth.example.com" },
      user: { id: "account", name: "account", displayName: "Account" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { userVerification: "required", residentKey: "required" },
      excludeCredentials: [{ id: "existing", type: "public-key" }],
    };
    expect(decodeRegistrationOptions(options)).toEqual(options);
    expect(() => decodeRegistrationOptions({ ...options, user: { id: "account" } })).toThrow(
      "invalid passkey registration options",
    );
    expect(() =>
      decodeRegistrationOptions({
        ...options,
        pubKeyCredParams: [{ type: "public-key", alg: "-7" }],
      }),
    ).toThrow("invalid passkey registration options");
  });
});
